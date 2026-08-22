/**
 * Renderiza o painel da extensão num HTML fora do VS Code, para gerar as capturas da
 * documentação. Equivalente ao `-PreviewPath` de tray/tokenbar.ps1.
 *
 *   node dist/preview.js saida.html [caminho/do/snapshot.json]
 *
 * Sem snapshot informado, usa o publicado pelo daemon em %LOCALAPPDATA%\tokenbar\.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageSnapshot } from '../usage';
import { renderDashboard } from '../webview/render';

const outputPath = process.argv[2] ?? 'dashboard.html';
const snapshotPath = process.argv[3] ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'tokenbar', 'snapshot.json');

let snapshot: UsageSnapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
} catch {
  console.error(`Não foi possível ler o snapshot em ${snapshotPath}.`);
  console.error('Rode o daemon (node dist/daemon.js) ou informe um arquivo de exemplo como segundo argumento.');
  process.exit(1);
}

fs.writeFileSync(outputPath, renderDashboard(snapshot, { interactive: false }), 'utf8');
console.log(`Preview salvo em ${path.resolve(outputPath)} (${snapshot.providers.length} provedores)`);
