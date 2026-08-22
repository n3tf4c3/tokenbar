import { CodexCollector } from '../collectors/codex';
import { clampPercent, UsageSnapshot } from '../usage';
import { renderDashboard } from '../webview/render';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

assert(clampPercent(-20) === 0, 'percentual não fica abaixo de zero');
assert(clampPercent(140) === 100, 'percentual não ultrapassa cem');
assert(clampPercent('42.5') === 42.5, 'percentual numérico em texto é aceito');

const codex = new CodexCollector() as any;
const codexWindows: any[] = [];
codex.appendWindow(codexWindows, { limitId: 'codex' }, {
  usedPercent: 17,
  windowDurationMins: 300,
  resetsAt: 1_784_000_000
}, 'primary');
codex.appendWindow(codexWindows, { limitId: 'codex' }, {
  usedPercent: 23,
  windowDurationMins: 10_080,
  resetsAt: 1_784_500_000
}, 'secondary');
assert(codexWindows[0].label === 'Janela de 5 horas', 'Codex identifica a janela de cinco horas');
assert(codexWindows[1].label === 'Janela semanal', 'Codex identifica a janela semanal');

const snapshotDeTeste: UsageSnapshot = {
  collectedAt: new Date().toISOString(),
  providers: [{
    provider: 'claude',
    label: 'Claude',
    status: 'ok',
    source: 'Claude Code OAuth',
    collectedAt: new Date().toISOString(),
    windows: [{ id: 'five_hour', label: '<img src=x onerror=alert(1)>', usedPercent: 30 }]
  }]
};

const htmlInterativo = renderDashboard(snapshotDeTeste);
const htmlPreview = renderDashboard(snapshotDeTeste, { interactive: false });

assert(!htmlInterativo.includes('<img src=x'), 'rótulo vindo do provedor é escapado no HTML');
assert(htmlInterativo.includes('&lt;img src=x'), 'rótulo escapado aparece como texto');
assert(/script-src 'nonce-[^']+'/.test(htmlInterativo), 'painel do VS Code declara CSP com nonce');
assert(htmlInterativo.includes('acquireVsCodeApi'), 'painel do VS Code inclui o script de refresh');
assert(htmlPreview.includes("script-src 'none'"), 'preview declara CSP sem script');
assert(!htmlPreview.includes('acquireVsCodeApi'), 'preview não chama a API do VS Code');
assert(htmlInterativo.includes('30% usado'), 'painel mostra o percentual usado, como a bandeja');
assert(!htmlInterativo.includes('restante'), 'painel não fala mais em restante');

const tons: UsageSnapshot = {
  collectedAt: new Date().toISOString(),
  providers: [{
    provider: 'codex', label: 'Codex', status: 'ok', source: 'Codex app-server',
    collectedAt: new Date().toISOString(),
    windows: [
      { id: 'a', label: 'tranquila', usedPercent: 69 },
      { id: 'b', label: 'atencao', usedPercent: 70 },
      { id: 'c', label: 'critica', usedPercent: 90 }
    ]
  }]
};
const htmlTons = renderDashboard(tons);
assert(htmlTons.includes('width:69%') && /healthy">69% usado/.test(htmlTons), 'abaixo de 70% usado fica verde');
assert(/warning">70% usado/.test(htmlTons), 'a partir de 70% usado fica âmbar, como a bandeja');
assert(/danger">90% usado/.test(htmlTons), 'a partir de 90% usado fica vermelho, como a bandeja');

console.log(`\n${passed} testes passaram; ${failed} falharam.`);
process.exitCode = failed ? 1 : 0;
