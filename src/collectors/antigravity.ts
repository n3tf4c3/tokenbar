import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clampPercent, CollectionError, FailureKind, parseReset, ProviderSnapshot, unavailable, UsageCollector, UsageWindow } from '../usage';

export const ANTIGRAVITY_REFRESH_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const SOURCE = 'Antigravity CLI';

// Os dois grupos originais mantêm IDs e rótulos curtos para não quebrar cache e bandeja.
// Grupos novos (ex.: a cota própria do Gemini 4 Argon) recebem ID e rótulo derivados do nome.
const GROUPS = new Map([
  ['Gemini Models', { id: 'gemini', label: 'Gemini', short: 'Gem' }],
  ['Claude and GPT models', { id: 'claude_gpt', label: 'Claude/GPT', short: 'C/G' }]
]);
const PERIODS = {
  five_hour: { label: '5 horas', short: '5h', minutes: 300 },
  seven_day: { label: 'Semanal', short: 'sem', minutes: 10_080 }
} as const;
type PeriodId = keyof typeof PERIODS;
const MAX_NAME_LENGTH = 60;

interface AntigravityBucket { group: string; period?: PeriodId; remainingPercent: number; resetsAt?: string }

function invalidUsage(message = 'O Antigravity retornou um formato de cotas desconhecido.'): CollectionError {
  return new CollectionError(message, 'invalid-response');
}

function groupInfo(name: string): { id: string; label: string; short: string } {
  const known = GROUPS.get(name);
  if (known) { return known; }
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!id || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) { throw invalidUsage(); }
  const words = name.split(/\s+/).filter(word => !/^(?:models?|and)$/i.test(word));
  const label = words.join(' ') || name;
  return { id, label, short: (words[words.length - 1] ?? name).slice(0, 6) };
}

/** Período pelo campo `window` do JSON ou pelo nome do bucket; períodos desconhecidos são ignorados. */
function periodOf(window: unknown, name: string): PeriodId | undefined {
  if (window === '5h' || (window === undefined && /\bfive[ -]?hour\b|\b5[ -]?h(?:our)?\b/i.test(name))) { return 'five_hour'; }
  if (window === 'weekly' || (window === undefined && /\bweekly\b/i.test(name))) { return 'seven_day'; }
  return undefined;
}

/** TSV do modo texto: grupo, nome do limite, percentual restante e renovação ISO. */
function parseTsvBuckets(output: string): AntigravityBucket[] {
  return output.trim().split(/\r?\n/).filter(line => line.trim()).map(line => {
    const fields = line.split('\t').map(field => field.trim());
    if (fields.length !== 4 || !fields[0] || !/^\d+(?:\.\d+)?%$/.test(fields[2]) || !/^\d{4}-\d{2}-\d{2}T/.test(fields[3])) {
      throw invalidUsage();
    }
    return { group: fields[0], period: periodOf(undefined, fields[1]), remainingPercent: Number(fields[2].slice(0, -1)), resetsAt: fields[3] };
  });
}

/** JSON de `--output-format json`: `command.data.groups[].buckets[]` com a fração restante exata. */
function parseJsonBuckets(output: string): AntigravityBucket[] {
  const line = output.trim().split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
  let payload: any;
  try { payload = JSON.parse(line ?? ''); } catch { throw invalidUsage(); }
  if (!payload || typeof payload !== 'object') { throw invalidUsage(); }
  if (payload.finished_reason === 'print_timeout') {
    throw new CollectionError('Tempo esgotado ao consultar as cotas do Antigravity.', 'timeout');
  }
  if (payload.status !== undefined && payload.status !== 'SUCCESS') { throw invalidUsage(); }
  const groups = payload.command?.data?.groups;
  if (!Array.isArray(groups)) {
    // CLI que ainda não estrutura o comando: o TSV vem em `response`.
    if (typeof payload.response === 'string') { return parseTsvBuckets(payload.response); }
    throw invalidUsage();
  }
  // Em JSON o zero pode ser omitido; o TSV do mesmo payload serve de conferência.
  const tsv = typeof payload.response === 'string' ? safeTsv(payload.response) : [];
  const buckets: AntigravityBucket[] = [];
  for (const group of groups) {
    if (!group || typeof group.name !== 'string' || !Array.isArray(group.buckets)) { throw invalidUsage(); }
    for (const bucket of group.buckets) {
      if (!bucket || typeof bucket.name !== 'string') { throw invalidUsage(); }
      if (bucket.disabled === true || bucket.enabled === false) { continue; }
      const period = periodOf(bucket.window, bucket.name);
      let fraction = bucket.remaining_fraction;
      if (fraction === undefined || fraction === null) {
        const text = tsv.find(item => item.group === group.name && item.name === bucket.name);
        if (!text) { throw invalidUsage(); }
        fraction = text.remainingPercent / 100;
      }
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
        throw invalidUsage('O Antigravity retornou um percentual inválido.');
      }
      buckets.push({ group: group.name, period, remainingPercent: fraction * 100, resetsAt: bucket.reset_time ?? undefined });
    }
  }
  return buckets;
}

function safeTsv(output: string): { group: string; name: string; remainingPercent: number }[] {
  return output.trim().split(/\r?\n/).map(line => line.split('\t').map(field => field.trim()))
    .filter(fields => fields.length === 4 && /^\d+(?:\.\d+)?%$/.test(fields[2]))
    .map(fields => ({ group: fields[0], name: fields[1], remainingPercent: Number(fields[2].slice(0, -1)) }));
}

/** O /usage oficial informa percentual restante, não percentual usado. Aceita JSON ou o TSV antigo. */
export function parseAntigravityUsage(output: string): UsageWindow[] {
  // Um aviso do CLI antes do JSON não deve jogar a leitura para o TSV.
  const buckets = /^\s*\{/m.test(output) ? parseJsonBuckets(output) : parseTsvBuckets(output);
  const windows: (UsageWindow & { order: number })[] = [];
  const groupOrder: string[] = [];
  for (const bucket of buckets) {
    if (bucket.remainingPercent > 100) { throw invalidUsage('O Antigravity retornou um percentual inválido.'); }
    const group = groupInfo(bucket.group);
    if (!bucket.period) { continue; }
    const period = PERIODS[bucket.period];
    const id = `antigravity_${group.id}_${bucket.period}`;
    if (windows.some(window => window.id === id)) { throw invalidUsage('O Antigravity retornou uma janela de cota duplicada.'); }
    if (!groupOrder.includes(group.id)) { groupOrder.push(group.id); }
    windows.push({
      id, label: `${group.label} · ${period.label}`, shortLabel: `${group.short} ${period.short}`,
      usedPercent: clampPercent(Number((100 - bucket.remainingPercent).toFixed(6))),
      durationMinutes: period.minutes, resetsAt: parseReset(bucket.resetsAt),
      // Grupos Gemini primeiro, depois a ordem do CLI; dentro do grupo, 5 h antes da semanal.
      order: (group.id.startsWith('gemini') ? 0 : 1000) + groupOrder.indexOf(group.id)
    });
  }
  return windows.sort((a, b) => a.order - b.order || a.durationMinutes! - b.durationMinutes!)
    .map(({ order: _order, ...window }) => window);
}

class AntigravityCliError extends Error {
  public constructor(message: string, public readonly status: 'unavailable' | 'error', public readonly kind?: FailureKind) { super(message); }
}

/** Nunca devolve a saída bruta do CLI: ela pode conter dados da conta ou URLs de login. */
export function antigravityCliFailure(error: { code?: string | number | null; killed?: boolean }, output: string): Error {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
    return new AntigravityCliError('Antigravity CLI não encontrado. Instale o agy e entre na sua conta.', 'unavailable');
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new CollectionError('A resposta de cotas do Antigravity excedeu o limite de tamanho.', 'invalid-response');
  }
  if (error.code === 'ABORT_ERR' || error.killed || /timed? out|timeout|deadline[ _]exceeded/i.test(output)) {
    return new CollectionError('Tempo esgotado ao consultar as cotas do Antigravity.', 'timeout');
  }
  if (error.code === 2 && /GEMINI_API_KEY|API key/i.test(output)) {
    return new AntigravityCliError('Com GEMINI_API_KEY o Antigravity não tem cota de assinatura; entre com a conta Google no CLI.', 'unavailable');
  }
  if (/authentication required|unauthenticated|not (?:signed|logged) in|(?:sign|log)[ -]?in required|\b401\b/i.test(output)) {
    return new AntigravityCliError('Abra o Antigravity CLI e entre novamente na sua conta.', 'unavailable', 'auth');
  }
  if (/\b429\b|resource_exhausted|rate.?limit|too many requests/i.test(output)) {
    return new AntigravityCliError('O Antigravity limitou as consultas. A próxima tentativa será automática.', 'unavailable', 'rate-limit');
  }
  return new CollectionError('Não foi possível consultar as cotas pelo Antigravity CLI.', 'network');
}

function findAntigravity(): string | undefined {
  const windows = process.platform === 'win32';
  const name = windows ? 'agy.exe' : 'agy';
  const candidates = windows
    ? [path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', name)]
    : [path.join(os.homedir(), '.local', 'bin', name), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory) { candidates.push(path.join(directory.replace(/^"|"$/g, ''), name)); }
  }
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
}

function readUsage(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CollectionError('A consulta do Antigravity foi cancelada.', 'timeout')); return; }
    const executable = findAntigravity();
    if (!executable) { reject(antigravityCliFailure({ code: 'ENOENT' }, '')); return; }
    // Executa apenas o comando interno de cotas; nenhum prompt ou token é enviado pelo TokenBar.
    const child = execFile(executable, ['--print', '/usage', '--print-timeout', '10s', '--output-format', 'json'], {
      cwd: os.tmpdir(), windowsHide: true, timeout: 12_000, maxBuffer: 64 * 1024, encoding: 'utf8', signal,
      // O auto-updater cria outros agy.exe que podem abrir um terminal no Windows.
      // A consulta não atualiza o CLI; a opção vale só para este processo e seus filhos.
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
    }, (error, stdout, stderr) => {
      if (error) { reject(antigravityCliFailure(error, `${stdout}\n${stderr}`)); }
      else { resolve(stdout); }
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  });
}

export class AntigravityCollector implements UsageCollector {
  public readonly provider = 'antigravity' as const;
  private snapshot?: ProviderSnapshot;

  public constructor(initialSnapshot?: ProviderSnapshot, private readonly options: {
    now?: () => number; readUsage?: (signal?: AbortSignal) => Promise<string>;
  } = {}) {
    this.snapshot = initialSnapshot?.provider === this.provider ? initialSnapshot : undefined;
  }

  public async collect(_force = false, signal?: AbortSignal): Promise<ProviderSnapshot> {
    const now = (this.options.now ?? Date.now)();
    if (this.snapshot?.nextRetryAt && Date.parse(this.snapshot.nextRetryAt) > now) {
      return { ...this.snapshot, stale: this.snapshot.windows.length ? true : undefined };
    }
    let result: ProviderSnapshot;
    try {
      const windows = parseAntigravityUsage(await (this.options.readUsage ?? readUsage)(signal));
      result = windows.length ? {
        provider: this.provider, label: 'Antigravity', source: SOURCE, status: 'ok',
        collectedAt: new Date((this.options.now ?? Date.now)()).toISOString(), windows
      } : unavailable(this.provider, 'Antigravity', SOURCE, 'O Antigravity não retornou cotas para esta conta.');
    } catch (error) {
      const known = error instanceof CollectionError || error instanceof AntigravityCliError;
      result = unavailable(this.provider, 'Antigravity', SOURCE,
        known ? error.message : 'Falha inesperada ao consultar as cotas do Antigravity.',
        error instanceof AntigravityCliError ? error.status : 'error');
      result.failureKind = known ? error.kind : 'network';
    }
    if (result.status !== 'ok' && this.snapshot?.windows.length) {
      result = { ...result, windows: this.snapshot.windows, collectedAt: this.snapshot.collectedAt, stale: true };
    }
    const limited = result.failureKind === 'rate-limit';
    this.snapshot = {
      ...result, lastAttemptAt: new Date(now).toISOString(),
      nextRetryAt: new Date(now + (limited ? RATE_LIMIT_BACKOFF_MS : ANTIGRAVITY_REFRESH_MS)).toISOString(),
      retryReason: limited ? 'rate-limit' : 'interval'
    };
    return this.snapshot;
  }
}
