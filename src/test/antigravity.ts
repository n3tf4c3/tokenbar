import * as assert from 'assert/strict';
import { AntigravityCollector, ANTIGRAVITY_REFRESH_MS, antigravityCliFailure, parseAntigravityUsage } from '../collectors/antigravity';
import { CollectionError, ProviderSnapshot, restoreSnapshot, worstCurrentUsage } from '../usage';
import { UsageManager } from '../usageManager';
import { renderDashboard } from '../webview/render';

const NOW = Date.parse('2026-09-06T03:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const output = [
  'Gemini Models\tWeekly Limit Remaining\t25%\t2026-09-12T13:50:06Z',
  'Gemini Models\tFive Hour Limit Remaining\t62.5%\t2026-09-06T08:00:00Z',
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-13T03:00:00Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-09-06T08:00:00Z'
].join('\r\n');

export async function runAntigravityTests(): Promise<number> {
  let passed = 0;
  const check = async (name: string, run: () => void | Promise<void>) => {
    await run(); passed++; console.log(`PASS: ${name}`);
  };

  await check('Antigravity converte restante em usado e separa grupos e períodos', () => {
    const windows = parseAntigravityUsage(`\n${output}\r\n`);
    assert.deepEqual(windows.map(window => window.usedPercent), [37.5, 75, 100, 0]);
    assert.deepEqual(windows.map(window => window.durationMinutes), [300, 10_080, 300, 10_080]);
    assert.deepEqual(windows.map(window => window.shortLabel), ['Gem 5h', 'Gem sem', 'C/G 5h', 'C/G sem']);
    assert.equal(windows[0].resetsAt, '2026-09-06T08:00:00.000Z');
    assert.equal(windows[2].label, 'Claude/GPT · 5 horas');
    assert.equal(new Set(windows.map(window => window.id)).size, 4);
  });

  await check('Antigravity aceita grupos parciais e rejeita cotas malformadas sem inventar zero', () => {
    const valid = output.split('\r\n')[0];
    assert.equal(parseAntigravityUsage(valid).length, 1);
    assert.deepEqual(parseAntigravityUsage(' \r\n '), []);
    for (const invalid of ['NaN%', '-1%', '101%', '', '10', 'Infinity%', 'true%', '1e2%']) {
      assert.throws(() => parseAntigravityUsage(valid.replace('25%', invalid)), CollectionError);
    }
    for (const invalid of [valid.replace('2026-09-12T13:50:06Z', 'invalid'), valid.replace('Gemini Models', 'Unknown'),
      valid.replace('Weekly Limit Remaining', 'Unknown'), `${valid}\tunexpected`, `${valid}\n${valid}`, 'Warning: auth failed']) {
      assert.throws(() => parseAntigravityUsage(invalid), CollectionError);
    }
  });

  await check('Antigravity respeita intervalo inclusive no refresh manual e após reiniciar', async () => {
    let now = NOW; let calls = 0;
    const options = { now: () => now, readUsage: async () => { calls++; return output; } };
    const collector = new AntigravityCollector(undefined, options);
    const first = await collector.collect(); now += 1000;
    const cached = await collector.collect(true);
    assert.equal(calls, 1); assert.equal(cached.stale, true); assert.equal(cached.collectedAt, first.collectedAt);
    const restarted = new AntigravityCollector(JSON.parse(JSON.stringify(cached)), options);
    await restarted.collect(true); assert.equal(calls, 1);
    now = NOW + ANTIGRAVITY_REFRESH_MS;
    const fresh = await restarted.collect();
    assert.equal(calls, 2); assert.equal(fresh.stale, undefined); assert.equal(fresh.collectedAt, iso(now));
  });

  await check('Antigravity sem CLI ou login fica indisponível e não expõe mensagens privadas', async () => {
    for (const [code, text, kind] of [
      ['ENOENT', 'PRIVATE_SECRET', undefined],
      [1, 'authentication required PRIVATE_SECRET', 'auth']
    ] as const) {
      const collector = new AntigravityCollector(undefined, { now: () => NOW, readUsage: async () => {
        throw antigravityCliFailure({ code }, text);
      } });
      const snapshot = await collector.collect();
      assert.equal(snapshot.status, 'unavailable'); assert.equal(snapshot.failureKind, kind);
      assert.deepEqual(snapshot.windows, []); assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_SECRET'));
    }
  });

  await check('Antigravity preserva última coleta em falhas e recupera depois', async () => {
    let now = NOW; let invalid = false;
    const collector = new AntigravityCollector(undefined, { now: () => now, readUsage: async () => invalid ? 'bad data PRIVATE_SECRET' : output });
    const first = await collector.collect(); invalid = true; now += ANTIGRAVITY_REFRESH_MS;
    const failed = await collector.collect();
    assert.equal(failed.status, 'error'); assert.equal(failed.failureKind, 'invalid-response');
    assert.equal(failed.stale, true); assert.equal(failed.collectedAt, first.collectedAt); assert.deepEqual(failed.windows, first.windows);
    assert.ok(!JSON.stringify(failed).includes('PRIVATE_SECRET'));
    invalid = false; now += ANTIGRAVITY_REFRESH_MS;
    assert.equal((await collector.collect()).status, 'ok');
  });

  for (const cached of [false, true]) {
    await check(`Antigravity preserva espera por 429 ${cached ? 'com' : 'sem'} cache após reinício`, async () => {
      let now = NOW; let calls = 0; let limited = !cached;
      const options = { now: () => now, readUsage: async () => {
        calls++; if (limited) { throw antigravityCliFailure({ code: 1 }, '429 too many requests PRIVATE_SECRET'); } return output;
      } };
      const collector = new AntigravityCollector(undefined, options);
      if (cached) { await collector.collect(); now += ANTIGRAVITY_REFRESH_MS; limited = true; }
      const failed = await collector.collect(); const count = calls;
      assert.equal(failed.failureKind, 'rate-limit'); assert.equal(failed.retryReason, 'rate-limit');
      assert.equal(failed.nextRetryAt, iso(now + 5 * 60_000)); assert.equal(failed.windows.length, cached ? 4 : 0);
      const restarted = new AntigravityCollector(JSON.parse(JSON.stringify(failed)), options);
      await restarted.collect(true); assert.equal(calls, count);
      limited = false; now += 5 * 60_000;
      assert.equal((await restarted.collect()).status, 'ok'); assert.equal(calls, count + 1);
    });
  }

  await check('Antigravity classifica cancelamento, timeout e excesso de saída sem vazar dados', () => {
    for (const [error, kind] of [
      [{ code: 'ABORT_ERR' }, 'timeout'], [{ killed: true }, 'timeout'],
      [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'invalid-response'], [{ code: 1 }, 'network']
    ] as const) {
      const failure = antigravityCliFailure(error, 'PRIVATE_SECRET https://example.invalid/login?token=PRIVATE_SECRET');
      assert.ok(failure instanceof CollectionError); assert.equal(failure.kind, kind); assert.ok(!failure.message.includes('PRIVATE_SECRET'));
    }
  });

  await check('Snapshot e dashboard preservam Antigravity como provedor independente', async () => {
    const provider = await new AntigravityCollector(undefined, { now: () => NOW, readUsage: async () => output }).collect();
    const snapshot = { collectedAt: iso(NOW), providers: [provider] };
    assert.deepEqual(restoreSnapshot(snapshot), snapshot);
    const html = renderDashboard(snapshot, { interactive: false, now: NOW });
    assert.ok(html.includes('provider antigravity')); assert.ok(html.includes('Claude/GPT · 5 horas'));
    assert.equal(worstCurrentUsage(snapshot, NOW)?.provider.provider, 'antigravity');
    for (const invalidId of ['unknown', '__proto__', ['antigravity']]) {
      assert.equal(restoreSnapshot({ ...snapshot, providers: [{ ...provider, provider: invalidId }] })?.providers.length, 0);
    }
    assert.equal(restoreSnapshot({ ...snapshot, providers: [{ ...provider, windows: [{ ...provider.windows[0], shortLabel: 123 }] }] })?.providers.length, 0);
  });

  await check('Timeout do Antigravity não bloqueia Codex nem troca o rótulo do provedor', async () => {
    let aborted = false;
    const codex: ProviderSnapshot = { provider: 'codex', label: 'Codex', source: 'fixture', status: 'ok', collectedAt: iso(NOW), windows: [] };
    const manager = new UsageManager(undefined, { timeoutMs: 30, collectors: [
      { provider: 'codex', collect: async () => codex },
      { provider: 'antigravity', collect: async (_force, signal) => new Promise<ProviderSnapshot>(() => {
        signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      }) }
    ] });
    await manager.refresh();
    const providers = manager.getSnapshot().providers;
    assert.equal(providers[0].status, 'ok'); assert.equal(providers[1].label, 'Antigravity');
    assert.equal(providers[1].failureKind, 'timeout'); assert.equal(aborted, true);
  });
  return passed;
}
