import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clampPercent, CollectionError, FailureKind, parseReset, ProviderSnapshot, unavailable, UsageCollector, UsageWindow } from '../usage';

export const ANTIGRAVITY_REFRESH_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const SOURCE = 'Antigravity CLI';

const GROUPS = new Map([
  ['Gemini Models', { id: 'gemini', label: 'Gemini', short: 'Gem' }],
  ['Claude and GPT models', { id: 'claude_gpt', label: 'Claude/GPT', short: 'C/G' }]
]);
const PERIODS = new Map([
  ['Five Hour Limit Remaining', { id: 'five_hour', label: '5 horas', short: '5h', minutes: 300 }],
  ['Weekly Limit Remaining', { id: 'seven_day', label: 'Semanal', short: 'sem', minutes: 10_080 }]
]);

/** O /usage oficial devolve TSV com percentual restante, não percentual usado. */
export function parseAntigravityUsage(output: string): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const line of output.trim().split(/\r?\n/).filter(line => line.trim())) {
    const fields = line.split('\t').map(field => field.trim());
    const group = GROUPS.get(fields[0]);
    const period = PERIODS.get(fields[1]);
    if (fields.length !== 4 || !group || !period || !/^\d+(?:\.\d+)?%$/.test(fields[2])
      || !/^\d{4}-\d{2}-\d{2}T/.test(fields[3])) {
      throw new CollectionError('O Antigravity retornou um formato de cotas desconhecido.', 'invalid-response');
    }
    const remaining = Number(fields[2].slice(0, -1));
    if (!Number.isFinite(remaining) || remaining > 100) {
      throw new CollectionError('O Antigravity retornou um percentual inválido.', 'invalid-response');
    }
    const id = `antigravity_${group.id}_${period.id}`;
    if (seen.has(id)) { throw new CollectionError('O Antigravity retornou uma janela de cota duplicada.', 'invalid-response'); }
    seen.add(id);
    windows.push({
      id, label: `${group.label} · ${period.label}`, shortLabel: `${group.short} ${period.short}`,
      usedPercent: clampPercent(Number((100 - remaining).toFixed(6))),
      durationMinutes: period.minutes, resetsAt: parseReset(fields[3])
    });
  }
  return windows.sort((a, b) => (a.id.includes('_gemini_') ? 0 : 1) - (b.id.includes('_gemini_') ? 0 : 1)
    || a.durationMinutes! - b.durationMinutes!);
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
  if (error.code === 'ABORT_ERR' || error.killed || /timed? out|timeout|deadline exceeded/i.test(output)) {
    return new CollectionError('Tempo esgotado ao consultar as cotas do Antigravity.', 'timeout');
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
    const child = execFile(executable, ['--print', '/usage', '--print-timeout', '10s'], {
      cwd: os.tmpdir(), windowsHide: true, timeout: 12_000, maxBuffer: 64 * 1024, encoding: 'utf8', signal
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
