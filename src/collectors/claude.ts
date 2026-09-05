import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { requestJson } from '../http';
import { clampPercent, CollectionError, FailureKind, parseReset, ProviderSnapshot, UsageCollector, UsageWindow } from '../usage';
import { VERSION } from '../version';

export const MIN_REFRESH_MS = 5 * 60 * 1000;

export function claudeThrottleReason(now: number, lastAttemptAt: number, backoffUntil: number): 'backoff' | 'floor' | undefined {
  if (now < backoffUntil) { return 'backoff'; }
  if (lastAttemptAt > 0 && now - lastAttemptAt < MIN_REFRESH_MS) { return 'floor'; }
  return undefined;
}

export class ClaudeHttpError extends CollectionError {
  public constructor(public readonly statusCode: number, public readonly retryAt?: number) {
    super(statusCode === 401 ? 'A sessão do Claude expirou. Abra o Claude Code e use /login.'
      : statusCode === 429 ? 'O Claude limitou as consultas. A próxima tentativa será automática.'
      : `Claude respondeu HTTP ${statusCode}.`, statusCode === 401 ? 'auth' : statusCode === 429 ? 'rate-limit' : 'network');
  }
}

interface ClaudeCredentials {
  claudeAiOauth?: { accessToken?: string; subscriptionType?: string; expiresAt?: number };
}

interface ClaudeCollectorOptions {
  now?: () => number;
  readCredentials?: (signal?: AbortSignal) => Promise<ClaudeCredentials>;
  requestUsage?: (accessToken: string, signal?: AbortSignal) => Promise<unknown>;
}

export function parseRetryAfter(headerValue?: string | string[], now = Date.now()): number | undefined {
  const value = (Array.isArray(headerValue) ? headerValue[0] : headerValue)?.trim();
  if (!value) { return undefined; }
  // RFC 9110: número inteiro de segundos ou uma data HTTP. Não é um epoch.
  if (/^\d+$/.test(value)) {
    const timestamp = now + Number(value) * 1000;
    return Number.isSafeInteger(timestamp) && timestamp <= 8.64e15 ? timestamp : undefined;
  }
  if (!/^[A-Za-z]{3,9}[, ]/.test(value)) { return undefined; }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CollectionError('O Claude retornou uma estrutura de cota inválida.', 'invalid-response');
  }
  return value as Record<string, unknown>;
}

export function parseClaudeUsage(value: unknown): UsageWindow[] {
  const usage = record(value);
  const windows: UsageWindow[] = [];
  for (const [id, label] of [['five_hour', 'Janela de 5 horas'], ['seven_day', 'Janela semanal']]) {
    if (usage[id] === null || usage[id] === undefined) { continue; }
    const window = record(usage[id]);
    windows.push({ id, label, usedPercent: clampPercent(window.utilization), resetsAt: parseReset(window.resets_at) });
  }
  if (usage.limits != null && !Array.isArray(usage.limits)) {
    throw new CollectionError('O Claude retornou uma lista de limites inválida.', 'invalid-response');
  }
  for (const value of (usage.limits ?? []) as unknown[]) {
    const limit = record(value);
    if (limit.kind !== 'weekly_scoped') { continue; }
    const scope = limit.scope == null ? undefined : record(limit.scope);
    const model = scope?.model == null ? undefined : record(scope.model).display_name;
    if (model !== undefined && typeof model !== 'string') {
      throw new CollectionError('O Claude retornou um nome de modelo inválido.', 'invalid-response');
    }
    windows.push({ id: `weekly_${model ?? windows.length}`, label: model ? `Semanal · ${model}` : 'Semanal por modelo',
      usedPercent: clampPercent(limit.percent), resetsAt: parseReset(limit.resets_at), detail: 'Limite separado por modelo' });
  }
  return windows;
}

export class ClaudeCollector implements UsageCollector {
  public readonly provider = 'claude' as const;
  private lastSnapshot?: ProviderSnapshot;
  private lastAttemptAt = 0;
  private backoffUntil = 0;
  private lastFailure?: { message: string; status: 'unavailable' | 'error'; kind?: FailureKind };
  private readonly now: () => number;

  public constructor(initialSnapshot?: ProviderSnapshot, private readonly options: ClaudeCollectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lastSnapshot = initialSnapshot?.windows.length ? initialSnapshot : undefined;
    const attempt = Date.parse(initialSnapshot?.lastAttemptAt ?? (this.lastSnapshot?.collectedAt ?? ''));
    this.lastAttemptAt = Number.isFinite(attempt) ? attempt : 0;
    const retryAt = Date.parse(initialSnapshot?.nextRetryAt ?? '');
    this.backoffUntil = initialSnapshot?.retryReason === 'rate-limit' && Number.isFinite(retryAt) ? retryAt : 0;
    if (initialSnapshot && initialSnapshot.status !== 'ok' && initialSnapshot.message) {
      this.lastFailure = { message: initialSnapshot.message, status: initialSnapshot.status, kind: initialSnapshot.failureKind };
    }
  }

  public async collect(_force = false, signal?: AbortSignal): Promise<ProviderSnapshot> {
    // A atualização manual também respeita o piso e a espera solicitada pelo serviço.
    const reason = claudeThrottleReason(this.now(), this.lastAttemptAt, this.backoffUntil);
    if (reason) {
      return this.currentSnapshot(this.lastFailure?.message ?? (reason === 'backoff'
        ? 'O Claude limitou as consultas. A próxima tentativa será automática.'
        : 'Último dado válido. Aguardando o intervalo entre consultas.'));
    }

    let credentials: ClaudeCredentials;
    try {
      credentials = this.options.readCredentials ? await this.options.readCredentials(signal)
        : JSON.parse(await fs.promises.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), { encoding: 'utf8', signal }));
    } catch {
      if (signal?.aborted) { throw new CollectionError('Tempo esgotado ao ler a sessão do Claude.', 'timeout'); }
      return this.failed('Faça login no Claude Code para ler a cota da assinatura.', 'unavailable', 'auth');
    }
    if (signal?.aborted) { throw new CollectionError('A consulta do Claude foi cancelada.', 'timeout'); }
    const accessToken = credentials?.claudeAiOauth?.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) {
      return this.failed('A sessão local do Claude Code não foi encontrada. Use /login no Claude Code.', 'unavailable', 'auth');
    }
    const expiresAt = credentials.claudeAiOauth?.expiresAt;
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= this.now()) {
      return this.failed('A sessão do Claude expirou. Abra o Claude Code e use /login.', 'unavailable', 'auth');
    }

    try {
      this.lastAttemptAt = this.now();
      const usage = this.options.requestUsage ? await this.options.requestUsage(accessToken, signal) : await this.requestUsage(accessToken, signal);
      if (signal?.aborted) { throw new CollectionError('A consulta do Claude foi cancelada.', 'timeout'); }
      const windows = parseClaudeUsage(usage);
      if (!windows.length) {
        return this.failed('A conta não retornou janelas de assinatura.', 'unavailable', 'invalid-response');
      }
      this.backoffUntil = 0;
      this.lastFailure = undefined;
      this.lastSnapshot = {
        provider: this.provider, label: 'Claude', status: 'ok', source: 'Claude Code OAuth',
        collectedAt: new Date(this.now()).toISOString(),
        plan: typeof credentials.claudeAiOauth?.subscriptionType === 'string' ? credentials.claudeAiOauth.subscriptionType : undefined,
        windows
      };
      return this.withSchedule(this.lastSnapshot);
    } catch (error) {
      if (signal?.aborted) { throw new CollectionError('A consulta do Claude foi cancelada.', 'timeout'); }
      if (error instanceof ClaudeHttpError && error.statusCode === 429) {
        this.backoffUntil = Math.max(this.lastAttemptAt + MIN_REFRESH_MS, error.retryAt ?? this.now() + MIN_REFRESH_MS);
      }
      const kind = error instanceof CollectionError ? error.kind : 'network';
      return this.failed(error instanceof CollectionError ? error.message : 'Não foi possível atualizar o Claude. Uma nova tentativa será feita automaticamente.',
        kind === 'auth' || kind === 'rate-limit' ? 'unavailable' : 'error', kind);
    }
  }

  private failed(message: string, status: 'unavailable' | 'error', kind: FailureKind): ProviderSnapshot {
    this.lastFailure = { message, status, kind };
    return this.currentSnapshot(message);
  }

  private currentSnapshot(message: string): ProviderSnapshot {
    return this.withSchedule({
      ...(this.lastSnapshot ?? { provider: this.provider, label: 'Claude', collectedAt: new Date(this.now()).toISOString(), windows: [] }),
      status: this.lastFailure?.status ?? (this.lastSnapshot ? 'ok' : 'unavailable'),
      source: this.lastSnapshot ? 'Claude Code OAuth · cache local' : 'Claude Code OAuth',
      message, stale: !!this.lastSnapshot, failureKind: this.lastFailure?.kind
    });
  }

  private withSchedule(snapshot: ProviderSnapshot): ProviderSnapshot {
    const next = Math.max(this.lastAttemptAt ? this.lastAttemptAt + MIN_REFRESH_MS : 0, this.backoffUntil);
    return { ...snapshot, checkedAt: new Date(this.now()).toISOString(),
      lastAttemptAt: this.lastAttemptAt ? new Date(this.lastAttemptAt).toISOString() : undefined,
      nextRetryAt: next > this.now() ? new Date(next).toISOString() : undefined,
      retryReason: next > this.now() ? (this.backoffUntil > this.now() ? 'rate-limit' : 'interval') : undefined };
  }

  private async requestUsage(accessToken: string, signal?: AbortSignal): Promise<unknown> {
    const response = await requestJson({
      hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`,
        'Anthropic-Beta': 'oauth-2025-04-20', 'User-Agent': `tokenbar/${VERSION}` }
    }, { signal });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ClaudeHttpError(response.statusCode, parseRetryAfter(response.headers['retry-after'], this.now()));
    }
    return response.body;
  }
}
