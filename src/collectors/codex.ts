import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clampPercent, CollectionError, ProviderSnapshot, unavailable, UsageCollector, UsageWindow } from '../usage';
import { VERSION } from '../version';

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

interface RateLimitResponse {
  rateLimits?: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

function isSparkLimit(snapshot: RateLimitSnapshot): boolean {
  return snapshot.limitId === 'codex_bengalfox'
    || [snapshot.limitId, snapshot.limitName].some(value => typeof value === 'string' && /(?:^|[-_\s])spark(?:$|[-_\s])/i.test(value));
}

function selectCodexLimits(result: RateLimitResponse): RateLimitSnapshot[] {
  const buckets = Object.entries(result.rateLimitsByLimitId ?? {})
    .map(([id, snapshot]) => ({ ...snapshot, limitId: snapshot.limitId ?? id }));
  const main = buckets.find(snapshot => snapshot.limitId === 'codex') ?? result.rateLimits;
  const snapshots = new Map<string, RateLimitSnapshot>();
  const include = (snapshot: RateLimitSnapshot) => snapshots.set(isSparkLimit(snapshot) ? 'spark' : snapshot.limitId ?? 'codex', snapshot);
  if (main) { include(main); }
  else {
    buckets.filter(snapshot => snapshot.limitId !== 'base_model_inference' && snapshot.limitName !== 'gpt-reserve').forEach(include);
  }
  // rateLimits é a visão legada; Spark só aparece na visão por limite, na mesma consulta.
  buckets.filter(isSparkLimit).forEach(include);
  return [...snapshots.values()];
}

export class CodexCollector implements UsageCollector {
  public readonly provider = 'codex' as const;

  public async collect(_force = false, signal?: AbortSignal): Promise<ProviderSnapshot> {
    try {
      const result = await this.readRateLimits(signal);
      const snapshots = selectCodexLimits(result);
      const windows: UsageWindow[] = [];
      let plan: string | undefined;

      for (const snapshot of snapshots) {
        plan ||= snapshot.planType ?? undefined;
        this.appendWindow(windows, snapshot, snapshot.primary, 'primary');
        this.appendWindow(windows, snapshot, snapshot.secondary, 'secondary');
      }

      return {
        provider: this.provider,
        label: 'Codex',
        status: windows.length ? 'ok' : 'unavailable',
        source: 'Codex app-server',
        collectedAt: new Date().toISOString(),
        plan,
        windows,
        message: windows.length ? undefined : 'O Codex não retornou janelas de limite para esta conta.'
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...unavailable(this.provider, 'Codex', 'Codex app-server', message, 'error'),
        failureKind: error instanceof CollectionError ? error.kind : 'network' };
    }
  }

  private appendWindow(target: UsageWindow[], snapshot: RateLimitSnapshot, window: RateLimitWindow | null | undefined, position: string): void {
    if (!window) {
      return;
    }
    const duration = window.windowDurationMins ?? undefined;
    if (duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0)) {
      throw new CollectionError('O Codex retornou uma duração de janela inválida.', 'invalid-response');
    }
    if (window.resetsAt != null && (typeof window.resetsAt !== 'number' || !Number.isFinite(window.resetsAt)
      || !Number.isFinite(new Date(window.resetsAt * 1000).getTime()))) {
      throw new CollectionError('O Codex retornou um horário de renovação inválido.', 'invalid-response');
    }
    const durationLabel = duration === 300 ? 'Janela de 5 horas' : duration === 10_080 ? 'Janela semanal' : duration ? `Janela de ${this.formatDuration(duration)}` : 'Limite da assinatura';
    const spark = isSparkLimit(snapshot);
    target.push({
      id: `${snapshot.limitId ?? 'codex'}_${position}`,
      label: spark ? `${durationLabel} · Spark` : snapshot.limitName ? `${durationLabel} · ${snapshot.limitName}` : durationLabel,
      shortLabel: spark ? (duration === 300 ? 'Spark 5h' : duration === 10_080 ? 'Spark 7d' : 'Spark') : undefined,
      usedPercent: clampPercent(window.usedPercent),
      durationMinutes: duration,
      resetsAt: window.resetsAt != null ? new Date(window.resetsAt * 1000).toISOString() : undefined
    });
  }

  private formatDuration(minutes: number): string {
    if (minutes % 1440 === 0) {
      return `${minutes / 1440} dias`;
    }
    if (minutes % 60 === 0) {
      return `${minutes / 60} horas`;
    }
    return `${minutes} minutos`;
  }

  private readRateLimits(signal?: AbortSignal): Promise<RateLimitResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new CollectionError('A consulta do Codex foi cancelada.', 'timeout')); return; }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnCodex();
      } catch {
        reject(new Error('Codex CLI não foi encontrado.'));
        return;
      }

      let buffer = '';
      let settled = false;
      const finish = (error?: Error, value?: RateLimitResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        child.stdin.end();
        setTimeout(() => child.kill(), 250);
        error ? reject(error) : resolve(value!);
      };
      const abort = () => finish(new CollectionError('A consulta do Codex foi cancelada.', 'timeout'));
      const timer = setTimeout(() => finish(new CollectionError('Tempo esgotado ao consultar o Codex.', 'timeout')), 12_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => finish(new CollectionError('A comunicação com o Codex foi interrompida.', 'network')));
      child.stderr.resume();

      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.id === 1 && message.result) {
            child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
            child.stdin.write(`${JSON.stringify({ method: 'account/rateLimits/read', id: 2, params: null })}\n`);
          } else if (message.id === 2) {
            if (message.error) {
              finish(new Error(message.error.message ?? 'Falha ao consultar os limites do Codex.'));
            } else {
              finish(undefined, message.result as RateLimitResponse);
            }
          }
        }
      });
      child.on('error', () => finish(new Error('Não foi possível iniciar o Codex CLI.')));
      child.on('exit', code => {
        if (!settled) {
          finish(new Error(`Codex app-server encerrou antes de responder (${code ?? 'sem código'}).`));
        }
      });
      child.stdin.write(`${JSON.stringify({
        method: 'initialize',
        id: 1,
        params: { clientInfo: { name: 'tokenbar', title: 'TokenBar', version: VERSION }, capabilities: null }
      })}\n`);
    });
  }

  private spawnCodex(): ChildProcessWithoutNullStreams {
    if (process.platform === 'win32') {
      const command = this.findCodexOnWindows();
      if (!command) {
        throw new Error('missing');
      }
      return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', command, 'app-server', '--stdio'], { windowsHide: true });
    }
    return spawn('codex', ['app-server', '--stdio']);
  }

  /**
   * O prefixo padrão do npm vem primeiro, mas quem usa nvm-windows, Volta, pnpm ou um
   * `npm prefix` próprio tem o `codex` só no PATH. Resolvemos o caminho aqui, em vez de
   * deixar o cmd.exe resolver, para distinguir "CLI ausente" (pré-requisito, não é erro)
   * de "o app-server morreu".
   */
  private findCodexOnWindows(): string | undefined {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    const candidates = [path.join(appData, 'npm', 'codex.cmd')];
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!directory) {
        continue;
      }
      for (const extension of ['.cmd', '.exe', '.bat']) {
        candidates.push(path.join(directory.replace(/^"|"$/g, ''), `codex${extension}`));
      }
    }
    return candidates.find(candidate => fs.existsSync(candidate));
  }
}
