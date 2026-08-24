import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clampPercent, ProviderSnapshot, unavailable, UsageCollector, UsageWindow } from '../usage';
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
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

export class CodexCollector implements UsageCollector {
  public readonly provider = 'codex' as const;

  public async collect(): Promise<ProviderSnapshot> {
    try {
      const result = await this.readRateLimits();
      const snapshots = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
        ? Object.values(result.rateLimitsByLimitId)
        : [result.rateLimits];
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
      return unavailable(this.provider, 'Codex', 'Codex app-server', message, 'error');
    }
  }

  private appendWindow(target: UsageWindow[], snapshot: RateLimitSnapshot, window: RateLimitWindow | null | undefined, position: string): void {
    if (!window) {
      return;
    }
    const duration = window.windowDurationMins ?? undefined;
    const durationLabel = duration === 300 ? 'Janela de 5 horas' : duration === 10_080 ? 'Janela semanal' : duration ? `Janela de ${this.formatDuration(duration)}` : 'Limite da assinatura';
    target.push({
      id: `${snapshot.limitId ?? 'codex'}_${position}`,
      label: snapshot.limitName ? `${durationLabel} · ${snapshot.limitName}` : durationLabel,
      usedPercent: clampPercent(window.usedPercent),
      durationMinutes: duration,
      resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : undefined
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

  private readRateLimits(): Promise<RateLimitResponse> {
    return new Promise((resolve, reject) => {
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
        child.stdin.end();
        setTimeout(() => child.kill(), 250);
        error ? reject(error) : resolve(value!);
      };
      const timer = setTimeout(() => finish(new Error('Tempo esgotado ao consultar o Codex.')), 12_000);

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
