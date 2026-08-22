export type ProviderId = 'claude' | 'codex';

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
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
}

export interface UsageSnapshot {
  collectedAt: string;
  providers: ProviderSnapshot[];
}

export interface UsageCollector {
  readonly provider: ProviderId;
  collect(): Promise<ProviderSnapshot>;
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
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(100, Math.max(0, parsed));
}
