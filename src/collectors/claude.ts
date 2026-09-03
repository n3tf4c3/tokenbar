import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { clampPercent, ProviderSnapshot, unavailable, UsageCollector } from '../usage';
import { VERSION } from '../version';

export const MIN_REFRESH_MS = 5 * 60 * 1000;

/**
 * Decide se a consulta de rede pode sair agora. Pura e sem qualquer noção de cache: foi
 * justamente o acoplamento entre "tenho snapshot guardado" e "posso consultar" que fazia o
 * backoff de 429 e o piso de 5 minutos serem ignorados em instalações que ainda não tinham
 * coletado com sucesso.
 */
export function claudeThrottleReason(now: number, lastAttemptAt: number, backoffUntil: number): 'backoff' | 'floor' | undefined {
  if (now < backoffUntil) {
    return 'backoff';
  }
  if (now - lastAttemptAt < MIN_REFRESH_MS) {
    return 'floor';
  }
  return undefined;
}

class ClaudeHttpError extends Error {
  public constructor(public readonly statusCode: number, message: string, public readonly retryAt?: number) {
    super(message);
  }
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    subscriptionType?: string;
    expiresAt?: number;
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

export function parseRetryAfter(headerValue?: string | string[]): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const value = (Array.isArray(headerValue) ? headerValue[0] : headerValue).trim();
  if (!value) {
    return undefined;
  }
  const num = Number(value);
  if (Number.isFinite(num)) {
    if (num > 1e9) {
      // Timestamp epoch em segundos
      return num * 1000;
    }
    // Delay em segundos relativo ao momento atual (limitado a no máximo 1 hora)
    const delaySeconds = Math.max(1, Math.min(3600, num));
    return Date.now() + delaySeconds * 1000;
  }
  const parsedDate = Date.parse(value);
  if (Number.isFinite(parsedDate) && parsedDate > Date.now()) {
    // Limitado a no máximo 1 hora no futuro
    return Math.min(parsedDate, Date.now() + 3600 * 1000);
  }
  return undefined;
}

export class ClaudeCollector implements UsageCollector {
  public readonly provider = 'claude' as const;
  private lastSnapshot?: ProviderSnapshot;
  private lastAttemptAt = 0;
  private backoffUntil = 0;
  private lastFailure?: { message: string; status: 'unavailable' | 'error' };

  public constructor(initialSnapshot?: ProviderSnapshot) {
    this.lastSnapshot = initialSnapshot;
    const collectedAt = initialSnapshot ? Date.parse(initialSnapshot.collectedAt) : 0;
    this.lastAttemptAt = Number.isFinite(collectedAt) ? collectedAt : 0;
  }

  public async collect(force = false): Promise<ProviderSnapshot> {
    if (force) {
      this.backoffUntil = 0;
    } else {
      const reason = claudeThrottleReason(Date.now(), this.lastAttemptAt, this.backoffUntil);
      if (reason === 'backoff') {
        return this.throttled(
          'O Claude limitou novas consultas. Exibindo o último dado válido até a próxima tentativa.',
          'Limite temporário de consultas do Claude. Tente novamente em alguns minutos.'
        );
      }
      if (reason === 'floor') {
        return this.throttled(
          'Exibindo o último dado válido; o Claude será consultado novamente em alguns minutos.',
          'Aguardando o intervalo mínimo de 5 minutos entre consultas ao Claude.'
        );
      }
    }

    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    let credentials: ClaudeCredentials;

    try {
      credentials = JSON.parse(await fs.promises.readFile(credentialsPath, 'utf8'));
    } catch {
      this.lastFailure = { message: 'Faça login no Claude Code para ler a cota da assinatura.', status: 'unavailable' };
      if (this.lastSnapshot) {
        return this.cachedSnapshot(this.lastFailure.message);
      }
      return unavailable(this.provider, 'Claude', 'Claude Code OAuth', this.lastFailure.message);
    }

    const accessToken = credentials.claudeAiOauth?.accessToken;
    if (!accessToken) {
      this.lastFailure = { message: 'A sessão local do Claude Code não foi encontrada.', status: 'unavailable' };
      if (this.lastSnapshot) {
        return this.cachedSnapshot(this.lastFailure.message);
      }
      return unavailable(this.provider, 'Claude', 'Claude Code OAuth', this.lastFailure.message);
    }

    const expiresAt = credentials.claudeAiOauth?.expiresAt;
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      this.lastFailure = { message: 'A sessão do Claude Code expirou. Abra o Claude Code para renovar.', status: 'unavailable' };
      if (this.lastSnapshot) {
        return this.cachedSnapshot(this.lastFailure.message);
      }
      return unavailable(this.provider, 'Claude', 'Claude Code OAuth', this.lastFailure.message);
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
        this.lastFailure = undefined;
      } else {
        this.lastFailure = { message: snapshot.message!, status: 'unavailable' };
      }
      return snapshot;
    } catch (error) {
      if (error instanceof ClaudeHttpError && error.statusCode === 429) {
        this.backoffUntil = error.retryAt ?? (Date.now() + 5 * 60 * 1000);
        this.lastFailure = { message: 'Limite temporário de consultas do Claude. Tente novamente em alguns minutos.', status: 'unavailable' };
        if (this.lastSnapshot) {
          return this.cachedSnapshot(this.lastFailure.message);
        }
        return unavailable(this.provider, 'Claude', 'Claude Code OAuth', this.lastFailure.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.lastFailure = { message: `Não foi possível atualizar o Claude: ${message}`, status: 'error' };
      if (this.lastSnapshot) {
        return this.cachedSnapshot(this.lastFailure.message);
      }
      return unavailable(this.provider, 'Claude', 'Claude Code OAuth', message, 'error');
    }
  }

  /**
   * Resposta enquanto a cadência trava a consulta: com cache, mostra o último dado válido;
   * sem cache, repete o último diagnóstico — que é mais acionável que "aguarde".
   */
  private throttled(cachedMessage: string, emptyMessage: string): ProviderSnapshot {
    if (this.lastSnapshot) {
      return this.cachedSnapshot(this.lastFailure?.message ?? cachedMessage);
    }
    return unavailable(
      this.provider,
      'Claude',
      'Claude Code OAuth',
      this.lastFailure?.message ?? emptyMessage,
      this.lastFailure?.status
    );
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
          'User-Agent': `tokenbar/${VERSION}`
        },
        timeout: 10_000
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((response.statusCode ?? 500) >= 300) {
            const status = response.statusCode ?? 500;
            const retryAt = parseRetryAfter(response.headers['retry-after']);
            reject(new ClaudeHttpError(
              status,
              status === 401
                ? 'A sessão do Claude expirou; entre novamente no Claude Code.'
                : status === 429
                ? 'Limite de consultas atingido no Claude (HTTP 429).'
                : `Claude respondeu HTTP ${status}.`,
              retryAt
            ));
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
