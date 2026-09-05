import { ClaudeCollector } from './collectors/claude';
import { CodexCollector } from './collectors/codex';
import { DiagnosticEvent } from './diagnostics';
import { CollectionError, ProviderSnapshot, restoreSnapshot, unavailable, UsageCollector, UsageSnapshot } from './usage';

export class UsageManager {
  private readonly collectors: UsageCollector[];
  private snapshot: UsageSnapshot;
  private listeners = new Set<(snapshot: UsageSnapshot) => void>();
  private refreshPromise?: Promise<UsageSnapshot>;

  public constructor(initialSnapshot?: UsageSnapshot, private readonly options: {
    collectors?: UsageCollector[]; timeoutMs?: number; onDiagnostic?: (event: DiagnosticEvent) => void;
  } = {}) {
    this.snapshot = restoreSnapshot(initialSnapshot) ?? { collectedAt: new Date(0).toISOString(), providers: [] };
    const cachedClaude = this.snapshot.providers.find(provider => provider.provider === 'claude');
    this.collectors = options.collectors ?? [new ClaudeCollector(cachedClaude), new CodexCollector()];
  }

  public getSnapshot(): UsageSnapshot { return this.snapshot; }

  public onDidUpdate(listener: (snapshot: UsageSnapshot) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public refresh(options?: { force?: boolean }): Promise<UsageSnapshot> {
    if (this.refreshPromise) { return this.refreshPromise; }
    // Cada resultado é publicado imediatamente. O prazo individual libera novas coletas.
    this.refreshPromise = Promise.all(this.collectors.map(collector => this.refreshProvider(collector, options?.force)))
      .then(() => this.snapshot).finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  private async refreshProvider(collector: UsageCollector, force = false): Promise<void> {
    const started = Date.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let result: ProviderSnapshot;
    try {
      result = await new Promise<ProviderSnapshot>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new CollectionError('Tempo esgotado. Uma nova tentativa será feita automaticamente.', 'timeout'));
          controller.abort();
        }, this.options.timeoutMs ?? 15_000);
        Promise.resolve().then(() => collector.collect(force, controller.signal)).then(resolve, reject);
      });
    } catch (error) {
      result = unavailable(collector.provider, collector.provider === 'claude' ? 'Claude' : 'Codex', 'Coletor de cotas',
        error instanceof CollectionError ? error.message : 'Falha inesperada na coleta. A próxima tentativa é automática.', 'error');
      result.failureKind = error instanceof CollectionError ? error.kind : 'network';
    } finally { clearTimeout(timer); }

    const previous = this.snapshot.providers.find(provider => provider.provider === collector.provider);
    if (result.status !== 'ok' && !result.windows.length && previous?.windows.length) {
      result = { ...result, windows: previous.windows, collectedAt: previous.collectedAt, plan: previous.plan, stale: true };
    }
    result = { ...result, checkedAt: new Date().toISOString() };
    const providers = new Map(this.snapshot.providers.map(provider => [provider.provider, provider]));
    providers.set(collector.provider, result);
    this.snapshot = { collectedAt: result.checkedAt!, providers: this.collectors.map(item => providers.get(item.provider)).filter((item): item is ProviderSnapshot => !!item) };
    this.diagnose({ event: 'collection', provider: collector.provider, status: result.status, failureKind: result.failureKind,
      durationMs: Date.now() - started, collectedAt: result.collectedAt, lastAttemptAt: result.lastAttemptAt, nextRetryAt: result.nextRetryAt });
    for (const listener of this.listeners) {
      try { listener(this.snapshot); } catch { this.diagnose({ event: 'listener-error', provider: collector.provider }); }
    }
  }

  private diagnose(event: DiagnosticEvent): void {
    try { this.options.onDiagnostic?.(event); } catch { /* Diagnóstico não interrompe a coleta. */ }
  }
}
