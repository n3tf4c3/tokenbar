export type ProviderId = 'claude' | 'codex' | 'antigravity';
export const PROVIDER_LABELS: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
export type FailureKind = 'auth' | 'rate-limit' | 'network' | 'timeout' | 'invalid-response';
export const MAX_DATA_AGE_MS = 10 * 60 * 1000;

export class CollectionError extends Error {
  public constructor(message: string, public readonly kind: FailureKind) { super(message); }
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  shortLabel?: string;
  resetsAt?: string;
  durationMinutes?: number;
  detail?: string;
}

export interface ProviderSnapshot {
  provider: ProviderId;
  label: string;
  status: 'ok' | 'unavailable' | 'error';
  source: string;
  collectedAt: string;
  plan?: string;
  windows: UsageWindow[];
  message?: string;
  stale?: boolean;
  checkedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  retryReason?: 'interval' | 'rate-limit';
  failureKind?: FailureKind;
}

export interface UsageSnapshot {
  collectedAt: string;
  providers: ProviderSnapshot[];
}

export interface UsageCollector {
  readonly provider: ProviderId;
  collect(force?: boolean, signal?: AbortSignal): Promise<ProviderSnapshot>;
}

export function unavailable(
  provider: ProviderId,
  label: string,
  source: string,
  message: string,
  status: 'unavailable' | 'error' = 'unavailable'
): ProviderSnapshot {
  return {
    provider,
    label,
    status,
    source,
    collectedAt: new Date().toISOString(),
    windows: [],
    message
  };
}

export function clampPercent(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) {
    throw new CollectionError('O serviço retornou um percentual inválido.', 'invalid-response');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CollectionError('O serviço retornou um percentual inválido.', 'invalid-response');
  }
  return Math.min(100, Math.max(0, parsed));
}

export function parseReset(value: unknown): string | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CollectionError('O serviço retornou um horário de renovação inválido.', 'invalid-response');
  }
  return new Date(value).toISOString();
}

export function isWindowExpired(window: UsageWindow, now = Date.now()): boolean {
  return window.resetsAt !== undefined && (!Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) <= now);
}

export function isProviderOutdated(provider: ProviderSnapshot, now = Date.now()): boolean {
  const collected = Date.parse(provider.collectedAt);
  return provider.status !== 'ok' || !Number.isFinite(collected) || now - collected >= MAX_DATA_AGE_MS;
}

export function providerNeedsAttention(provider: ProviderSnapshot, now = Date.now()): boolean {
  return isProviderOutdated(provider, now) || !provider.windows.length || provider.windows.some(window => isWindowExpired(window, now));
}

export function worstCurrentUsage(snapshot: UsageSnapshot, now = Date.now()): { provider: ProviderSnapshot; window: UsageWindow } | undefined {
  return snapshot.providers.filter(provider => !isProviderOutdated(provider, now))
    .flatMap(provider => provider.windows.filter(window => !isWindowExpired(window, now)).map(window => ({ provider, window })))
    .sort((a, b) => b.window.usedPercent - a.window.usedPercent)[0];
}

export function formatAge(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) { return 'horário desconhecido'; }
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (!minutes) { return 'há menos de 1 min'; }
  if (minutes < 60) { return `há ${minutes} min`; }
  if (minutes < 1440) { return `há ${Math.floor(minutes / 60)}h ${minutes % 60}min`; }
  return `há ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
}

/** Snapshots antigos continuam compatíveis; conteúdo corrompido nunca vira cota válida. */
export function restoreSnapshot(value: unknown): UsageSnapshot | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const candidate = value as UsageSnapshot;
  if (!Array.isArray(candidate.providers)) { return undefined; }
  const providers = candidate.providers.filter(provider => {
    try {
      return provider && typeof provider.provider === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, provider.provider)
        && ['ok', 'error', 'unavailable'].includes(provider.status)
        && typeof provider.label === 'string' && typeof provider.source === 'string'
        && typeof provider.collectedAt === 'string' && Number.isFinite(Date.parse(provider.collectedAt))
        && [provider.message, provider.plan, provider.nextRetryAt, provider.lastAttemptAt].every(item => item === undefined || typeof item === 'string')
        && Array.isArray(provider.windows) && provider.windows.every(window =>
          typeof window.id === 'string' && typeof window.label === 'string'
          && (window.shortLabel === undefined || typeof window.shortLabel === 'string')
          && typeof window.usedPercent === 'number' && clampPercent(window.usedPercent) === window.usedPercent
          && (window.resetsAt === undefined || parseReset(window.resetsAt) !== undefined));
    } catch { return false; }
  });
  return { collectedAt: typeof candidate.collectedAt === 'string' ? candidate.collectedAt : new Date(0).toISOString(), providers };
}
