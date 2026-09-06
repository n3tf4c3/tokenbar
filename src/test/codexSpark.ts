import * as assert from 'assert/strict';
import { CodexCollector } from '../collectors/codex';
import { restoreSnapshot, UsageSnapshot, worstCurrentUsage } from '../usage';
import { UsageManager } from '../usageManager';
import { renderDashboard } from '../webview/render';

const NOW = Date.parse('2026-09-06T03:00:00Z');
const primary = { usedPercent: 40, windowDurationMins: 300, resetsAt: NOW / 1000 + 5 * 3600 };
const secondary = { usedPercent: 62, windowDurationMins: 10_080, resetsAt: NOW / 1000 + 7 * 86400 };
const codex = { limitId: 'codex', planType: 'pro', primary: { ...secondary, usedPercent: 20 }, secondary: null };
const spark = { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', planType: 'pro', primary, secondary };

function fixture(response: unknown): CodexCollector {
  const collector = new CodexCollector();
  (collector as any).readRateLimits = async () => response;
  return collector;
}

export async function runCodexSparkTests(): Promise<number> {
  let passed = 0;
  const check = async (name: string, run: () => void | Promise<void>) => {
    await run(); passed++; console.log(`PASS: ${name}`);
  };

  await check('Codex inclui Spark sem duplicar a cota principal ou fazer outra consulta', async () => {
    let calls = 0;
    const collector = new CodexCollector();
    (collector as any).readRateLimits = async () => { calls++; return { rateLimits: codex, rateLimitsByLimitId: { codex, codex_bengalfox: spark } }; };
    const result = await collector.collect();
    assert.equal(calls, 1); assert.equal(result.status, 'ok'); assert.equal(result.plan, 'pro');
    assert.deepEqual(result.windows.map(window => window.id), ['codex_primary', 'codex_bengalfox_primary', 'codex_bengalfox_secondary']);
    assert.deepEqual(result.windows.map(window => window.usedPercent), [20, 40, 62]);
    assert.deepEqual(result.windows.map(window => window.shortLabel), [undefined, 'Spark 5h', 'Spark 7d']);
    assert.equal(result.windows[1].label, 'Janela de 5 horas · Spark');
    assert.equal(result.windows[2].label, 'Janela semanal · Spark');
    assert.equal(result.windows[1].resetsAt, new Date(primary.resetsAt * 1000).toISOString());
  });

  await check('Codex prioriza a visão por limite e aceita Spark identificado pela chave ou pelo nome', async () => {
    for (const bucket of [
      { ...spark, limitId: null, limitName: null },
      { ...spark, limitId: 'outro_id_do_modelo' }
    ]) {
      const result = await fixture({ rateLimits: { ...codex, primary: { ...primary, usedPercent: 99 } },
        rateLimitsByLimitId: { codex: { ...codex, limitId: null }, codex_bengalfox: bucket } }).collect();
      assert.equal(result.windows.length, 3); assert.equal(result.windows[0].usedPercent, 20);
      assert.equal(result.windows[1].shortLabel, 'Spark 5h');
      assert.equal(new Set(result.windows.map(window => window.id)).size, 3);
    }
  });

  await check('Codex preserva respostas legadas e contas sem Spark sem inventar janelas', async () => {
    for (const response of [{ rateLimits: codex }, { rateLimitsByLimitId: { codex } }, { rateLimits: codex, rateLimitsByLimitId: null }]) {
      const result = await fixture(response).collect();
      assert.equal(result.status, 'ok'); assert.equal(result.windows.length, 1); assert.equal(result.windows[0].shortLabel, undefined);
    }
    const empty = await fixture({ rateLimitsByLimitId: {} }).collect();
    assert.equal(empty.status, 'unavailable'); assert.deepEqual(empty.windows, []);
    const emptySpark = await fixture({ rateLimits: codex, rateLimitsByLimitId: { codex_bengalfox: { ...spark, primary: null, secondary: null } } }).collect();
    assert.equal(emptySpark.windows.length, 1);
  });

  await check('Spark funciona como única cota e não se duplica entre os dois formatos', async () => {
    for (const response of [
      { rateLimits: spark },
      { rateLimitsByLimitId: { codex_bengalfox: spark } },
      { rateLimits: { ...spark, limitId: null }, rateLimitsByLimitId: { codex_bengalfox: spark } }
    ]) {
      const result = await fixture(response).collect();
      assert.equal(result.windows.length, 2); assert.deepEqual(result.windows.map(window => window.usedPercent), [40, 62]);
      assert.equal(result.windows[0].shortLabel, 'Spark 5h');
    }
  });

  await check('Codex não inclui reservas ou outras cotas junto de Codex e Spark', async () => {
    const reserve = { ...spark, limitId: 'base_model_inference', limitName: 'gpt-reserve' };
    const result = await fixture({ rateLimits: codex, rateLimitsByLimitId: { codex, codex_bengalfox: spark,
      base_model_inference: reserve, other: { ...reserve, limitId: 'other', limitName: 'other' } } }).collect();
    assert.equal(result.windows.length, 3);
    const fallback = await fixture({ rateLimitsByLimitId: { base_model_inference: reserve, codex_bengalfox: spark } }).collect();
    assert.equal(fallback.windows.length, 2); assert.ok(fallback.windows.every(window => window.shortLabel?.startsWith('Spark')));
  });

  await check('Resposta inválida do Spark mantém o último snapshot válido e recupera depois', async () => {
    const collector = fixture({ rateLimits: codex, rateLimitsByLimitId: { codex_bengalfox: spark } });
    const previous = await collector.collect();
    const manager = new UsageManager({ collectedAt: previous.collectedAt, providers: [previous] }, { collectors: [collector] });
    for (const invalid of [{ ...primary, usedPercent: 'invalid' }, { ...primary, resetsAt: 'invalid' }, { ...primary, windowDurationMins: -1 }]) {
      (collector as any).readRateLimits = async () => ({ rateLimits: codex, rateLimitsByLimitId: { codex_bengalfox: { ...spark, primary: invalid } } });
      await manager.refresh();
      const result = manager.getSnapshot().providers[0];
      assert.equal(result.failureKind, 'invalid-response'); assert.equal(result.stale, true);
      assert.equal(result.collectedAt, previous.collectedAt); assert.deepEqual(result.windows, previous.windows);
    }
    (collector as any).readRateLimits = async () => ({ rateLimits: codex, rateLimitsByLimitId: { codex_bengalfox: spark } });
    await manager.refresh(); assert.equal(manager.getSnapshot().providers[0].status, 'ok');
  });

  await check('Dashboard, persistência e maior uso reconhecem as janelas do Spark', async () => {
    const provider = await fixture({ rateLimits: codex, rateLimitsByLimitId: { codex_bengalfox: spark } }).collect();
    const snapshot: UsageSnapshot = { collectedAt: provider.collectedAt, providers: [provider] };
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snapshot)))!;
    assert.equal(restored.providers[0].windows[2].shortLabel, 'Spark 7d');
    const html = renderDashboard(restored, { interactive: false, now: NOW });
    assert.ok(html.includes('Janela de 5 horas · Spark')); assert.ok(html.includes('Janela semanal · Spark'));
    assert.ok(html.includes('62% usado')); assert.equal(worstCurrentUsage(restored, NOW)?.window.id, 'codex_bengalfox_secondary');
    assert.equal(worstCurrentUsage(restored, NOW + 8 * 86400_000), undefined);
  });
  return passed;
}
