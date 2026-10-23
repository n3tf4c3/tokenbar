import * as fs from 'fs';
import * as path from 'path';
import { ClaudeCollector, claudeThrottleReason, MIN_REFRESH_MS } from '../collectors/claude';
import { CodexCollector } from '../collectors/codex';
import { clampPercent } from '../usage';
import { VERSION } from '../version';
import { runRegressionTests } from './regressions';
import { runAntigravityTests } from './antigravity';
import { runCodexSparkTests } from './codexSpark';
import { runCodexWindowsTests } from './codexWindows';

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

async function run(): Promise<void> {
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

  assert(codex.formatDuration(2880) === '2 dias', 'duração em múltiplo de dia vira dias');
  assert(codex.formatDuration(180) === '3 horas', 'duração em múltiplo de hora vira horas');
  assert(codex.formatDuration(45) === '45 minutos', 'duração quebrada fica em minutos');

  const agora = 1_800_000_000_000;
  assert(claudeThrottleReason(agora, 0, 0) === undefined, 'sem tentativa anterior, o Claude pode ser consultado');
  assert(claudeThrottleReason(agora, agora - 60_000, 0) === 'floor', 'o piso de 5 minutos bloqueia a consulta');
  assert(claudeThrottleReason(agora, agora - MIN_REFRESH_MS, 0) === undefined, 'passados 5 minutos, a consulta é liberada');
  assert(claudeThrottleReason(agora, 0, agora + 600_000) === 'backoff', 'o backoff de 429 bloqueia mesmo sem tentativa recente');
  assert(claudeThrottleReason(agora, 0, agora - 1) === undefined, 'backoff vencido não bloqueia');

  // Testes do coletor Claude
  const claudeCached = new ClaudeCollector({
    provider: 'claude',
    label: 'Claude',
    status: 'ok',
    source: 'Claude Code OAuth',
    collectedAt: new Date().toISOString(),
    windows: [{ id: 'five_hour', label: 'Janela de 5 horas', usedPercent: 42 }]
  });

  const cachedRes = await claudeCached.collect(false);
  assert(cachedRes.stale === true, 'Claude respeita intervalo mínimo e retorna cache como stale');
  assert(cachedRes.windows[0].usedPercent === 42, 'Claude preserva valores em cache');

  (claudeCached as any).lastFailure = { message: 'Falha de teste', status: 'error' };
  const cachedWithErr = await claudeCached.collect(false);
  assert(cachedWithErr.message === 'Falha de teste', 'Claude preserva mensagem de erro real no cache durante cooldown');

  const manifesto = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert(manifesto.version === VERSION, `versão anunciada aos provedores acompanha o package.json (${VERSION})`);

  passed += await runRegressionTests();
  passed += await runAntigravityTests();
  passed += await runCodexSparkTests();
  passed += await runCodexWindowsTests();
  console.log(`\n${passed} testes passaram; ${failed} falharam.`);
  process.exitCode = failed ? 1 : 0;
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
