import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { clampPercent, ProviderSnapshot, unavailable, UsageCollector } from '../usage';

const MIN_REFRESH_MS = 5 * 60 * 1000;

class ClaudeHttpError extends Error {
  public constructor(public readonly statusCode: number, message: string, public readonly retryAt?: number) {
    super(message);
  }
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    subscriptionType?: string;
  };
}

interface ClaudeUsageWindow {
  utilization?: number;
  resets_at?: string;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  limits?: Array<{
    kind?: string;
    group?: string;
    percent?: number;
    resets_at?: string;
    scope?: { model?: { display_name?: string } } | null;
  }>;
}

export class ClaudeCollector implements UsageCollector {
  public readonly provider = 'claude' as const;
  private lastSnapshot?: ProviderSnapshot;
  private lastAttemptAt = 0;
  private backoffUntil = 0;

  public constructor(initialSnapshot?: ProviderSnapshot) {
    this.lastSnapshot = initialSnapshot;
    const collectedAt = initialSnapshot ? Date.parse(initialSnapshot.collectedAt) : 0;
    this.lastAttemptAt = Number.isFinite(collectedAt) ? collectedAt : 0;
  }

  public async collect(): Promise<ProviderSnapshot> {
    const now = Date.now();
    if (this.lastSnapshot && (now < this.backoffUntil || now - this.lastAttemptAt < MIN_REFRESH_MS)) {
      return this.cachedSnapshot(now < this.backoffUntil
        ? 'O Claude limitou novas consultas. Exibindo o último dado válido até a próxima tentativa.'
        : 'Exibindo o último dado válido; o Claude será consultado novamente em alguns minutos.');
    }

    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    let credentials: ClaudeCredentials;

    try {
      credentials = JSON.parse(await fs.promises.readFile(credentialsPath, 'utf8'));
    } catch {
      return unavailable(this.provider, 'Claude', 'Claude Code OAuth', 'Faça login no Claude Code para ler a cota da assinatura.');
    }

    const accessToken = credentials.claudeAiOauth?.accessToken;
    if (!accessToken) {
      return unavailable(this.provider, 'Claude', 'Claude Code OAuth', 'A sessão local do Claude Code não foi encontrada.');
    }

    try {
      this.lastAttemptAt = Date.now();
      const usage = await this.requestUsage(accessToken);
      const windows = [];

      if (usage.five_hour) {
        windows.push({
          id: 'five_hour',
          label: 'Janela de 5 horas',
          usedPercent: clampPercent(usage.five_hour.utilization),
          resetsAt: usage.five_hour.resets_at
        });
      }
      if (usage.seven_day) {
        windows.push({
          id: 'seven_day',
          label: 'Janela semanal',
          usedPercent: clampPercent(usage.seven_day.utilization),
          resetsAt: usage.seven_day.resets_at
        });
      }

      for (const limit of usage.limits ?? []) {
        if (limit.kind !== 'weekly_scoped') {
          continue;
        }
        const model = limit.scope?.model?.display_name;
        windows.push({
          id: `weekly_${model ?? windows.length}`,
          label: model ? `Semanal · ${model}` : 'Semanal por modelo',
          usedPercent: clampPercent(limit.percent),
          resetsAt: limit.resets_at,
          detail: 'Limite separado por modelo'
        });
      }

      const snapshot: ProviderSnapshot = {
        provider: this.provider,
        label: 'Claude',
        status: windows.length ? 'ok' : 'unavailable',
        source: 'Claude Code OAuth',
        collectedAt: new Date().toISOString(),
        plan: credentials.claudeAiOauth?.subscriptionType,
        windows,
        message: windows.length ? undefined : 'A conta não retornou janelas de assinatura.'
      };
      if (windows.length) {
        this.lastSnapshot = snapshot;
        this.backoffUntil = 0;
      }
      return snapshot;
    } catch (error) {
      if (error instanceof ClaudeHttpError && error.statusCode === 429) {
        this.backoffUntil = error.retryAt ?? Date.now() + 10 * 60 * 1000;
        if (this.lastSnapshot) {
          return this.cachedSnapshot('O Claude limitou temporariamente as consultas. Exibindo o último dado válido.');
        }
        return unavailable(this.provider, 'Claude', 'Claude Code OAuth', 'Limite temporário de consultas do Claude. Tente novamente em alguns minutos.');
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.lastSnapshot) {
        return this.cachedSnapshot(`Não foi possível atualizar o Claude: ${message}`);
      }
      return unavailable(this.provider, 'Claude', 'Claude Code OAuth', message, 'error');
    }
  }

  private cachedSnapshot(message: string): ProviderSnapshot {
    return {
      ...this.lastSnapshot!,
      status: 'ok',
      source: 'Claude Code OAuth · cache local',
      message,
      stale: true
    };
  }

  private requestUsage(accessToken: string): Promise<ClaudeUsageResponse> {
    return new Promise((resolve, reject) => {
      const request = https.request({
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'Anthropic-Beta': 'oauth-2025-04-20',
          'User-Agent': 'tokenbar/0.1.0'
        },
        timeout: 10_000
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((response.statusCode ?? 500) >= 300) {
            const status = response.statusCode ?? 500;
            const retryAfter = Number(response.headers['retry-after']);
            const retryAt = Number.isFinite(retryAfter) ? Date.now() + retryAfter * 1000 : undefined;
            reject(new ClaudeHttpError(status, status === 401 ? 'A sessão do Claude expirou; entre novamente no Claude Code.' : `Claude respondeu HTTP ${status}.`, retryAt));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('O Claude retornou uma resposta de cota inválida.'));
          }
        });
      });
      request.on('timeout', () => request.destroy(new Error('Tempo esgotado ao consultar o Claude.')));
      request.on('error', reject);
      request.end();
    });
  }
}
