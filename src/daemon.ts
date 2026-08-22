import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageSnapshot } from './usage';
import { UsageManager } from './usageManager';

const stateDir = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'tokenbar');
const snapshotPath = path.join(stateDir, 'snapshot.json');
const refreshFlagPath = path.join(stateDir, 'refresh.flag');
const intervalSeconds = Math.min(3600, Math.max(15, Number(process.argv[2]) || 60));

fs.mkdirSync(stateDir, { recursive: true });

function readCachedSnapshot(): UsageSnapshot | undefined {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as UsageSnapshot;
  } catch {
    return undefined;
  }
}

function writeSnapshot(snapshot: UsageSnapshot): void {
  const temporary = `${snapshotPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot));
  fs.renameSync(temporary, snapshotPath);
}

const manager = new UsageManager(readCachedSnapshot());
manager.onDidUpdate(writeSnapshot);

fs.watch(stateDir, (_event, filename) => {
  if (filename !== 'refresh.flag' || !fs.existsSync(refreshFlagPath)) {
    return;
  }
  fs.rmSync(refreshFlagPath, { force: true });
  void manager.refresh();
});

void manager.refresh();
setInterval(() => void manager.refresh(), intervalSeconds * 1000);
