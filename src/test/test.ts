import { CodexCollector } from '../collectors/codex';
import { clampPercent } from '../usage';

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

console.log(`\n${passed} testes passaram; ${failed} falharam.`);
process.exitCode = failed ? 1 : 0;
