import * as fs from 'fs';
import * as path from 'path';
import { FailureKind, ProviderId, ProviderSnapshot } from './usage';

export interface DiagnosticEvent {
  event: 'collection' | 'daemon-start' | 'publish-error' | 'listener-error' | 'unexpected-error';
  provider?: ProviderId;
  status?: ProviderSnapshot['status'];
  failureKind?: FailureKind;
  durationMs?: number;
  collectedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
}

/** Só campos de diagnóstico permitidos; nunca mensagens, headers, corpo ou credenciais. */
export function createDiagnosticLogger(directory: string, maxBytes = 256 * 1024): (event: DiagnosticEvent) => void {
  const current = path.join(directory, 'diagnostics.jsonl');
  const previous = path.join(directory, 'diagnostics.previous.jsonl');
  return event => {
    try {
      fs.mkdirSync(directory, { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(), event: event.event, provider: event.provider,
        status: event.status, failureKind: event.failureKind, durationMs: event.durationMs,
        collectedAt: event.collectedAt, lastAttemptAt: event.lastAttemptAt, nextRetryAt: event.nextRetryAt
      }) + '\n';
      if (fs.existsSync(current) && fs.statSync(current).size + Buffer.byteLength(line) > maxBytes) {
        fs.rmSync(previous, { force: true });
        fs.renameSync(current, previous);
      }
      fs.appendFileSync(current, line);
    } catch { console.error('TokenBar: não foi possível gravar o diagnóstico local.'); }
  };
}
