import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CODEX_LONG_CONTEXT_TOKENS, CostTracker, priceClaudeUsage, priceCodexUsage, restoreCosts } from '../cost';

const near = (actual: number | undefined, expected: number, message: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message}: esperado ${expected}, obtido ${actual}`);

export async function runCostTests(): Promise<number> {
  let passed = 0;
  const check = async (name: string, run: () => void | Promise<void>) => { await run(); passed++; console.log(`PASS: ${name}`); };

  await check('preço do Claude por resposta segue a tabela, com cache de 5 min e 1 h', () => {
    // 1M de cada: 8 + 40 + 0,20 + 10 (5 min = 1,25x) + 16 (1 h = 2x).
    near(priceClaudeUsage('claude-fable-5-2', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6,
      cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } }), 74.2, 'Fable 5.2');
    near(priceClaudeUsage('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 }), 24.2, 'Opus 5.5');
    // Sem a divisão por TTL, a escrita em cache conta como 5 minutos.
    near(priceClaudeUsage('claude-sonnet-5-5', { cache_creation_input_tokens: 1e6 }), 2.5, 'escrita sem TTL');
    near(priceClaudeUsage('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40, 'modo rápido dobra o preço');
    near(priceClaudeUsage('claude-haiku-5-5', { server_tool_use: { web_search_requests: 3 } }), 0.03, 'busca na web');
    near(priceClaudeUsage('claude-haiku-4-5-20251001', { input_tokens: 1e6 }), 1, 'sufixo de data é ignorado');
    near(priceClaudeUsage('claude-opus-5-5[1m]', { input_tokens: 1e6 }), 4, 'sufixo de contexto é ignorado');
    assert.equal(priceClaudeUsage('claude-desconhecido', { input_tokens: 1 }), undefined);
    assert.equal(priceClaudeUsage(undefined, { input_tokens: 1 }), undefined);
    near(priceClaudeUsage('claude-opus-5-5', { input_tokens: -5, output_tokens: 'x' }), 0, 'contadores inválidos valem zero');
  });

  await check('preço do Codex desconta o cache da entrada e usa a tabela longa acima de 272 mil tokens', () => {
    // input inclui o cache: 0,1M a $1 + 0,1M a $0,05 + 1M a $5.
    near(priceCodexUsage('gpt-6.1-terra', { input_tokens: 2e5, cached_input_tokens: 1e5, output_tokens: 1e6 }), 0.1 + 0.005 + 5, 'Terra');
    near(priceCodexUsage('gpt-6-astra', { input_tokens: CODEX_LONG_CONTEXT_TOKENS, output_tokens: 0 }), CODEX_LONG_CONTEXT_TOKENS * 10 / 1e6, 'no limite fica a tabela padrão');
    near(priceCodexUsage('gpt-6-astra', { input_tokens: CODEX_LONG_CONTEXT_TOKENS + 1, output_tokens: 0 }), (CODEX_LONG_CONTEXT_TOKENS + 1) * 20 / 1e6, 'acima, a longa');
    near(priceCodexUsage('gpt-6.1-sol', { input_tokens: 10, cached_input_tokens: 50 }), 10 * 0.1 / 1e6, 'cache nunca passa da entrada');
    assert.equal(priceCodexUsage('codex-auto-review', { input_tokens: 1 }), undefined);
  });

  await check('snapshot salvo só devolve estimativas bem formadas', () => {
    assert.equal(restoreCosts(undefined), undefined);
    assert.equal(restoreCosts([{ provider: 'antigravity', todayUsd: 1, weekUsd: 1, computedAt: '2026-11-12T00:00:00Z' }]), undefined);
    assert.equal(restoreCosts([{ provider: 'claude', todayUsd: -1, weekUsd: 1, computedAt: '2026-11-12T00:00:00Z' }]), undefined);
    assert.deepEqual(restoreCosts([{ provider: 'codex', todayUsd: 1, weekUsd: 2, partial: true, computedAt: '2026-11-12T00:00:00Z', extra: 'x' }]),
      [{ provider: 'codex', todayUsd: 1, weekUsd: 2, partial: true, computedAt: '2026-11-12T00:00:00Z' }]);
  });

  // Registros sintéticos numa pasta exclusiva do teste, removida no final.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbar-cost-test-'));
  try {
    const now = new Date(2026, 10, 12, 15, 0, 0).getTime(); // 15h locais
    const hour = 3_600_000;
    const at = (offset: number) => new Date(now + offset).toISOString();
    const claudeDir = path.join(fixture, 'claude', 'projects');
    const codexDir = path.join(fixture, 'codex', 'sessions');
    fs.mkdirSync(path.join(claudeDir, 'proj', 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(codexDir, '2026', '11', '12'), { recursive: true });
    const assistant = (id: string, offset: number, model = 'claude-opus-5-5', output = 1e6) => JSON.stringify({ type: 'assistant', timestamp: at(offset),
      requestId: `req_${id}`, message: { id: `msg_${id}`, model, content: [{ type: 'text', text: 'conteúdo sintético "usage"' }], usage: { output_tokens: output } } });
    const sessionA = path.join(claudeDir, 'proj', 'a.jsonl');
    fs.writeFileSync(sessionA, [
      JSON.stringify({ type: 'user', message: { content: 'texto qualquer' } }),
      assistant('1', -hour),               // hoje: $20
      assistant('1', -hour),               // mesma resposta em outro bloco: não conta de novo
      assistant('2', -20 * hour),          // ontem: $20 só na semana
      assistant('3', -9 * 24 * hour),      // fora da janela de 7 dias
      assistant('4', -2 * hour, '<synthetic>'),
      'linha que não é JSON "usage"'
    ].join('\n') + '\n');
    // Sessão retomada copia a resposta 2 para outro arquivo.
    fs.writeFileSync(path.join(claudeDir, 'proj', 'subagents', 'b.jsonl'), assistant('2', -20 * hour) + '\n' + assistant('5', -30 * 60_000, 'claude-sonnet-5-5') + '\n');
    const rollout = path.join(codexDir, '2026', '11', '12', 'rollout.jsonl');
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6.1-terra' } }),
      JSON.stringify({ type: 'token_usage_record', timestamp: at(-hour), payload: { turn_id: 't1', response_id: 'r1', usage: { input_tokens: 0, output_tokens: 1e6 } } }),
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 't2', model: 'codex-auto-review' } }),
      JSON.stringify({ type: 'token_usage_record', timestamp: at(-3 * 24 * hour), payload: { turn_id: 't2', response_id: 'r2', usage: { input_tokens: 5, output_tokens: 5 } } })
    ].join('\n') + '\n');

    const tracker = new CostTracker({ claudeDir, codexDir, now: () => now });
    const first = await tracker.refresh();
    const claude = first.find(item => item.provider === 'claude');
    const codex = first.find(item => item.provider === 'codex');

    await check('custo do Claude separa hoje e 7 dias, sem repetir respostas nem contar fora da janela', () => {
      // Hoje: resposta 1 ($20) + resposta 5 (Sonnet 5.5, $10). Semana: + resposta 2 ($20).
      assert.equal(claude?.todayUsd, 30); assert.equal(claude?.weekUsd, 50); assert.equal(claude?.partial, undefined);
    });

    await check('custo do Codex usa o modelo do turno e marca piso quando há modelo sem preço', () => {
      assert.equal(codex?.todayUsd, 5); assert.equal(codex?.weekUsd, 5); assert.equal(codex?.partial, true);
    });

    await check('leitura incremental pega só o que foi acrescentado, inclusive linha gravada pela metade', async () => {
      const line = assistant('6', -10 * 60_000, 'claude-fable-5-2');
      fs.appendFileSync(sessionA, line.slice(0, 40));
      assert.equal((await tracker.refresh()).find(item => item.provider === 'claude')?.todayUsd, 30);
      fs.appendFileSync(sessionA, line.slice(40) + '\n');
      assert.equal((await tracker.refresh()).find(item => item.provider === 'claude')?.todayUsd, 70);
    });

    await check('arquivo reescrito menor é relido do início', async () => {
      fs.writeFileSync(sessionA, assistant('7', -hour, 'claude-haiku-5-5') + '\n');
      const result = (await tracker.refresh()).find(item => item.provider === 'claude');
      // Sobram a resposta 7 ($0,50), a 5 ($10) e a 2 copiada no outro arquivo ($20, ontem).
      assert.equal(result?.todayUsd, 10.5); assert.equal(result?.weekUsd, 30.5);
    });

    await check('sem a pasta de registros o provedor fica fora da estimativa', async () => {
      const result = await new CostTracker({ claudeDir: path.join(fixture, 'nada'), codexDir, now: () => now }).refresh();
      assert.deepEqual(result.map(item => item.provider), ['codex']);
    });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  return passed;
}
