import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CostTracker, restoreCosts } from './cost';
import { UsageSnapshot } from './usage';
import { UsageManager } from './usageManager';
import { createDiagnosticLogger } from './diagnostics';

const stateDir = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'tokenbar');
const snapshotPath = path.join(stateDir, 'snapshot.json');
const refreshFlagPath = path.join(stateDir, 'refresh.flag');
const intervalSeconds = Math.min(3600, Math.max(15, Number(process.argv[2]) || 60));
const COST_INTERVAL_MS = 5 * 60_000;

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

const cachedSnapshot = readCachedSnapshot();
const manager = new UsageManager(cachedSnapshot, { onDiagnostic: diagnose });
const costTracker = new CostTracker();
// A estimativa anterior continua no painel até a primeira leitura dos registros terminar.
let latestCosts = restoreCosts(cachedSnapshot?.costs);

function publish(snapshot: UsageSnapshot): void {
  writeSnapshot(latestCosts ? { ...snapshot, costs: latestCosts } : snapshot);
}
manager.onDidUpdate(publish);

function refresh(options?: { force?: boolean }): void {
  manager.refresh(options).catch(() => diagnose({ event: 'unexpected-error' }));
}

function refreshCosts(): void {
  const started = Date.now();
  costTracker.refresh().then(costs => {
    latestCosts = costs.length ? costs : undefined;
    diagnose({ event: 'cost', durationMs: Date.now() - started });
    publish(manager.getSnapshot());
  }, () => diagnose({ event: 'cost-error' }));
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
  refreshCosts();
});

process.on('unhandledRejection', () => diagnose({ event: 'unexpected-error' }));

refresh();
setInterval(() => refresh(), intervalSeconds * 1000);
// A primeira leitura dos registros é a mais pesada; espera a coleta das cotas.
setTimeout(refreshCosts, 15_000);
setInterval(refreshCosts, COST_INTERVAL_MS);
