import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageSnapshot } from './usage';
import { UsageManager } from './usageManager';
import { createDiagnosticLogger } from './diagnostics';

const stateDir = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'tokenbar');
const snapshotPath = path.join(stateDir, 'snapshot.json');
const refreshFlagPath = path.join(stateDir, 'refresh.flag');
const intervalSeconds = Math.min(3600, Math.max(15, Number(process.argv[2]) || 60));

fs.mkdirSync(stateDir, { recursive: true });
const diagnose = createDiagnosticLogger(stateDir);
diagnose({ event: 'daemon-start' });

function readCachedSnapshot(): UsageSnapshot | undefined {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as UsageSnapshot;
  } catch {
    return undefined;
  }
}

let pendingSnapshot: UsageSnapshot | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let publishFailing = false;

/**
 * Publica o snapshot de forma atômica. No Windows, renomear por cima falha com EPERM
 * enquanto a bandeja tem o `snapshot.json` aberto para leitura — daí a repetição. A
 * exceção nunca pode escapar daqui: como isto roda dentro de um listener do
 * `UsageManager`, ela derrubaria o refresh e, sem ninguém para capturá-la, o daemon.
 */
function writeSnapshot(snapshot: UsageSnapshot): void {
  pendingSnapshot = snapshot;
  flushSnapshot();
}

function flushSnapshot(): void {
  if (!pendingSnapshot) {
    return;
  }
  const temporary = `${snapshotPath}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(pendingSnapshot));
    fs.renameSync(temporary, snapshotPath);
    pendingSnapshot = undefined;
    publishFailing = false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  } catch (error) {
    // Uma linha por rajada: enquanto a bandeja segura o arquivo, toda tentativa falha
    // igual, e repetir o log a cada 500 ms só afogaria o resto.
    if (!publishFailing) {
      publishFailing = true;
      diagnose({ event: 'publish-error' });
      console.error(`TokenBar: snapshot não publicado (${(error as NodeJS.ErrnoException).code ?? 'erro'}); tentando de novo.`);
    }
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        flushSnapshot();
      }, 500);
    }
  }
}

const manager = new UsageManager(readCachedSnapshot(), { onDiagnostic: diagnose });
manager.onDidUpdate(writeSnapshot);

function refresh(options?: { force?: boolean }): void {
  manager.refresh(options).catch(() => diagnose({ event: 'unexpected-error' }));
}

fs.watch(stateDir, (_event, filename) => {
  try {
    if (filename !== 'refresh.flag' || !fs.existsSync(refreshFlagPath)) {
      return;
    }
    fs.rmSync(refreshFlagPath, { force: true });
  } catch (error) {
    console.error('TokenBar: falha ao consumir o pedido de atualização.', error);
    return;
  }
  refresh({ force: true });
});

process.on('unhandledRejection', () => diagnose({ event: 'unexpected-error' }));

refresh();
setInterval(() => refresh(), intervalSeconds * 1000);
