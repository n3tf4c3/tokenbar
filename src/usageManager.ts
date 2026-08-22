import { ClaudeCollector } from './collectors/claude';
import { CodexCollector } from './collectors/codex';
import { UsageCollector, UsageSnapshot } from './usage';

export class UsageManager {
  private readonly collectors: UsageCollector[];
  private snapshot: UsageSnapshot;
  private listeners = new Set<(snapshot: UsageSnapshot) => void>();
  private refreshPromise?: Promise<UsageSnapshot>;

  public constructor(initialSnapshot?: UsageSnapshot) {
    this.snapshot = initialSnapshot ?? { collectedAt: new Date(0).toISOString(), providers: [] };
    const cachedClaude = this.snapshot.providers.find(provider => provider.provider === 'claude' && provider.windows.length > 0);
    this.collectors = [new ClaudeCollector(cachedClaude), new CodexCollector()];
  }

  public getSnapshot(): UsageSnapshot {
    return this.snapshot;
  }

  public onDidUpdate(listener: (snapshot: UsageSnapshot) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public refresh(): Promise<UsageSnapshot> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = Promise.all(this.collectors.map(collector => collector.collect()))
      .then(providers => {
        this.snapshot = { collectedAt: new Date().toISOString(), providers };
        for (const listener of this.listeners) {
          listener(this.snapshot);
        }
        return this.snapshot;
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }
}
