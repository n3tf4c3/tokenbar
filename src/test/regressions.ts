import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ClaudeCollector, ClaudeHttpError, MIN_REFRESH_MS, parseClaudeUsage, parseRetryAfter } from '../collectors/claude';
import { CodexCollector } from '../collectors/codex';
import { createDiagnosticLogger } from '../diagnostics';
import { requestJson } from '../http';
import { clampPercent, CollectionError, isProviderOutdated, parseReset, ProviderSnapshot, restoreSnapshot, worstCurrentUsage } from '../usage';
import { UsageManager } from '../usageManager';
import { renderDashboard } from '../webview/render';

const NOW = Date.parse('2026-09-05T13:00:00Z');
const iso = (value: number) => new Date(value).toISOString();
const credentials = () => Promise.resolve({ claudeAiOauth: { accessToken: 'SYNTHETIC_TEST_TOKEN', expiresAt: NOW + 86400_000 } });
const usage = { five_hour: { utilization: 21, resets_at: iso(NOW + 3600_000) } };
const fixture = (provider: 'claude' | 'codex' = 'claude'): ProviderSnapshot => ({
  provider, label: provider === 'claude' ? 'Claude' : 'Codex', status: 'ok', source: 'fixture',
  collectedAt: iso(NOW - 6 * 60_000), windows: [{ id: 'five_hour', label: 'Janela de 5 horas', usedPercent: 93, resetsAt: iso(NOW + 3600_000) }]
});

export async function runRegressionTests(): Promise<number> {
  let passed = 0;
  const check = async (name: string, run: () => void | Promise<void>) => {
    await run(); passed++; console.log(`PASS: ${name}`);
  };

  await check('Retry-After respeita segundos, datas e esperas superiores a uma hora', () => {
    assert.equal(parseRetryAfter('7200', NOW), NOW + 7200_000);
    assert.equal(parseRetryAfter(new Date(NOW + 7200_000).toUTCString(), NOW), NOW + 7200_000);
    assert.equal(parseRetryAfter('0', NOW), NOW);
    for (const value of ['', '-1', '1.5', 'NaN', 'Infinity']) { assert.equal(parseRetryAfter(value, NOW), undefined); }
  });

  await check('Atualizar agora respeita o piso entre consultas', async () => {
    let now = NOW; let requests = 0;
    const collector = new ClaudeCollector(undefined, { now: () => now, readCredentials: credentials, requestUsage: async () => { requests++; return usage; } });
    await collector.collect(); now += 1000;
    const cached = await collector.collect(true); await collector.collect(true);
    assert.equal(requests, 1); assert.equal(cached.stale, true);
    assert.equal(cached.nextRetryAt, iso(NOW + MIN_REFRESH_MS));
  });

  for (const cached of [false, true]) {
    await check(`429 persiste a espera após reinício, ${cached ? 'com' : 'sem'} cache`, async () => {
      let now = NOW; let requests = 0; let limited = true;
      const options = { now: () => now, readCredentials: credentials, requestUsage: async () => {
        requests++; if (limited) { throw new ClaudeHttpError(429, NOW + 7200_000); } return usage;
      } };
      const collector = new ClaudeCollector(cached ? fixture() : undefined, options);
      const limitedSnapshot = await collector.collect();
      assert.equal(limitedSnapshot.status, 'unavailable'); assert.equal(limitedSnapshot.failureKind, 'rate-limit');
      assert.equal(limitedSnapshot.nextRetryAt, iso(NOW + 7200_000));
      await collector.collect(true); await collector.collect(true);
      const restarted = new ClaudeCollector(JSON.parse(JSON.stringify(limitedSnapshot)), options);
      const waiting = await restarted.collect(true);
      assert.equal(requests, 1); assert.equal(waiting.nextRetryAt, limitedSnapshot.nextRetryAt);
      assert.equal(waiting.failureKind, 'rate-limit');
      now += 7200_000; limited = false;
      const recovered = await restarted.collect();
      assert.equal(requests, 2); assert.equal(recovered.status, 'ok'); assert.equal(recovered.failureKind, undefined);
    });
  }

  await check('sessão expirada mantém os valores e o diagnóstico, e recupera após renovar credenciais', async () => {
    let expired = true; let requests = 0;
    const previous = fixture();
    const collector = new ClaudeCollector(previous, { now: () => NOW,
      readCredentials: async () => ({ claudeAiOauth: { accessToken: 'SYNTHETIC', expiresAt: expired ? NOW - 1 : NOW + 3600_000 } }),
      requestUsage: async () => { requests++; return usage; } });
    const result = await collector.collect(true);
    assert.equal(result.status, 'unavailable'); assert.equal(result.failureKind, 'auth'); assert.equal(result.stale, true);
    assert.equal(result.collectedAt, previous.collectedAt); assert.deepEqual(result.windows, previous.windows); assert.equal(requests, 0);
    const html = renderDashboard({ collectedAt: iso(NOW), providers: [result] }, { interactive: false, now: NOW });
    assert.ok(html.includes('/login')); assert.ok(html.includes('Última coleta válida')); assert.ok(html.includes('Último: 93%'));
    expired = false;
    assert.equal((await collector.collect()).status, 'ok'); assert.equal(requests, 1);
  });

  await check('401 fica visível mesmo quando existe cache', async () => {
    const collector = new ClaudeCollector(fixture(), { now: () => NOW, readCredentials: credentials,
      requestUsage: async () => { throw new ClaudeHttpError(401); } });
    assert.equal((await collector.collect()).failureKind, 'auth');
    assert.equal((await collector.collect(true)).status, 'unavailable');
  });

  await check('percentuais ausentes ou inválidos e datas inválidas são rejeitados', () => {
    for (const value of [undefined, null, true, false, {}, [], '', ' ', 'oops', NaN, Infinity]) {
      assert.throws(() => clampPercent(value), CollectionError);
    }
    assert.equal(clampPercent(0), 0); assert.equal(clampPercent('42.5'), 42.5);
    for (const value of ['', 'not-a-date', 12, {}]) { assert.throws(() => parseReset(value), CollectionError); }
    assert.throws(() => parseClaudeUsage({ five_hour: {} }), CollectionError);
    assert.throws(() => parseClaudeUsage({ five_hour: { utilization: 10, resets_at: 'bad-date' } }), CollectionError);
    assert.throws(() => parseClaudeUsage({ limits: {} }), CollectionError);
    assert.equal(parseClaudeUsage({ five_hour: { utilization: 0 } })[0].usedPercent, 0);
    assert.equal(parseClaudeUsage({ five_hour: { utilization: 0 }, limits: null })[0].usedPercent, 0);
  });

  await check('Codex rejeita percentuais e datas inválidos sem apagar a leitura anterior', async () => {
    const collector = new CodexCollector();
    let window: unknown = { usedPercent: 'invalid', windowDurationMins: 300 };
    (collector as any).readRateLimits = async () => ({ rateLimits: { primary: window } });
    const previous = fixture('codex');
    const manager = new UsageManager({ collectedAt: iso(NOW), providers: [previous] }, { collectors: [collector] });
    await manager.refresh();
    assert.equal(manager.getSnapshot().providers[0].failureKind, 'invalid-response');
    assert.deepEqual(manager.getSnapshot().providers[0].windows, previous.windows);
    window = { usedPercent: 0, resetsAt: 'not-a-date', windowDurationMins: 300 };
    assert.equal((await collector.collect()).failureKind, 'invalid-response');
    window = { usedPercent: 0, windowDurationMins: 300 };
    const recovered = await collector.collect();
    assert.equal(recovered.status, 'ok'); assert.equal(recovered.windows[0].usedPercent, 0);
  });

  await check('resposta inválida preserva a coleta válida e pode recuperar no próximo ciclo', async () => {
    let now = NOW; let invalid = true; const previous = fixture();
    const collector = new ClaudeCollector(previous, { now: () => now, readCredentials: credentials,
      requestUsage: async () => invalid ? { five_hour: { utilization: null } } : usage });
    const failed = await collector.collect();
    assert.equal(failed.status, 'error'); assert.equal(failed.failureKind, 'invalid-response');
    assert.equal(failed.windows[0].usedPercent, 93); assert.equal(failed.collectedAt, previous.collectedAt);
    now += MIN_REFRESH_MS; invalid = false;
    assert.equal((await collector.collect()).windows[0].usedPercent, 21);
  });

  await check('janela vencida deixa de preencher a barra e de determinar o maior uso', () => {
    const expired = fixture(); expired.windows[0].resetsAt = iso(NOW - 3600_000);
    const codex = fixture('codex'); codex.windows[0].usedPercent = 31;
    const snapshot = { collectedAt: iso(NOW), providers: [expired, codex] };
    assert.equal(worstCurrentUsage(snapshot, NOW)?.window.usedPercent, 31);
    const html = renderDashboard(snapshot, { interactive: false, now: NOW });
    assert.ok(html.includes('Último: 93%')); assert.ok(html.includes('Janela vencida'));
    assert.ok(!html.includes('width:93%'));
    assert.equal(isProviderOutdated(expired, NOW + 4 * 60_000), true);
  });

  await check('snapshot legado é aceito e campos de cota corrompidos são descartados', () => {
    assert.equal(restoreSnapshot({ providers: [fixture()] })?.providers.length, 1);
    assert.equal(restoreSnapshot({ providers: [{ ...fixture(), windows: [{ usedPercent: null }] }] })?.providers.length, 0);
    assert.equal(restoreSnapshot(null), undefined);
  });

  await check('provedor pendurado não bloqueia o outro, é cancelado e permite recuperação', async () => {
    let late: (snapshot: ProviderSnapshot) => void = () => undefined;
    let attempt = 0; let aborted = false; let codexPublished: () => void = () => undefined;
    const published = new Promise<void>(resolve => { codexPublished = resolve; });
    const manager = new UsageManager(undefined, { timeoutMs: 60, collectors: [
      { provider: 'claude', collect: async (_force, signal) => {
        attempt++;
        if (attempt > 1) { return { ...fixture(), windows: [{ ...fixture().windows[0], usedPercent: 21 }] }; }
        signal?.addEventListener('abort', () => { aborted = true; });
        return new Promise<ProviderSnapshot>(resolve => { late = resolve; });
      } },
      { provider: 'codex', collect: async () => fixture('codex') }
    ] });
    manager.onDidUpdate(snapshot => { if (snapshot.providers.some(provider => provider.provider === 'codex')) { codexPublished(); } });
    const refresh = manager.refresh();
    assert.equal(refresh, manager.refresh({ force: true }));
    await published;
    assert.equal(manager.getSnapshot().providers.some(provider => provider.provider === 'claude'), false);
    await refresh; assert.equal(aborted, true);
    assert.equal(manager.getSnapshot().providers.find(provider => provider.provider === 'claude')?.failureKind, 'timeout');
    await manager.refresh(); late(fixture()); await Promise.resolve();
    assert.equal(manager.getSnapshot().providers.find(provider => provider.provider === 'claude')?.windows[0].usedPercent, 21);
  });

  await check('falha de um listener ou do diagnóstico não interrompe publicação e novas coletas', async () => {
    let updates = 0;
    const manager = new UsageManager(undefined, { collectors: [{ provider: 'codex', collect: async () => fixture('codex') }],
      onDiagnostic: () => { throw new Error('synthetic logging failure'); } });
    manager.onDidUpdate(() => { throw new Error('synthetic listener failure'); });
    manager.onDidUpdate(() => { updates++; });
    await manager.refresh(); await manager.refresh(); assert.equal(updates, 2);
  });

  const server = http.createServer((request, response) => {
    if (request.url === '/truncate') {
      response.writeHead(200, { 'Content-Length': '1000' }); response.write('{');
      setTimeout(() => response.destroy(), 15);
    } else if (request.url === '/drip') {
      response.writeHead(200); response.write('{');
      const pulse = setInterval(() => response.write(' '), 5);
      response.on('close', () => clearInterval(pulse));
    } else if (request.url === '/invalid') { response.end('{'); }
    else if (request.url === '/large') { response.end('x'.repeat(200)); }
    else if (request.url === '/429') { response.writeHead(429, { 'Retry-After': '7200' }); response.end('rate limited'); }
    else { response.end(JSON.stringify(usage)); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address() as { port: number };
    const get = (route: string, options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}) => requestJson({
      hostname: '127.0.0.1', port: address.port, path: route, agent: false
    }, { request: http.request, timeoutMs: 500, ...options });
    await check('HTTP interrompido após os headers rejeita a consulta e permite consultar novamente', async () => {
      await assert.rejects(get('/truncate'), (error: unknown) => error instanceof CollectionError && error.kind === 'network');
      assert.deepEqual((await get('/ok')).body, usage);
    });
    await check('HTTP com bytes contínuos também respeita o prazo total', async () => {
      await assert.rejects(get('/drip', { timeoutMs: 80 }), (error: unknown) => error instanceof CollectionError && error.kind === 'timeout');
    });
    await check('HTTP inválido ou excessivo é rejeitado; 429 preserva Retry-After sem exigir JSON', async () => {
      await assert.rejects(get('/invalid'), (error: unknown) => error instanceof CollectionError && error.kind === 'invalid-response');
      await assert.rejects(get('/large', { maxBytes: 32 }), (error: unknown) => error instanceof CollectionError && error.kind === 'invalid-response');
      const response = await get('/429'); assert.equal(response.statusCode, 429); assert.equal(response.headers['retry-after'], '7200');
    });
    await check('cancelamento externo encerra a requisição em andamento', async () => {
      const controller = new AbortController(); const pending = get('/drip', { signal: controller.signal });
      const rejection = assert.rejects(pending, (error: unknown) => error instanceof CollectionError && error.kind === 'timeout');
      controller.abort(); await rejection;
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  await check('diagnóstico tem rotação limitada e não grava campos sensíveis', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbar-test-'));
    try {
      const log = createDiagnosticLogger(directory, 400);
      for (let i = 0; i < 12; i++) { log(Object.assign({ event: 'collection' as const, provider: 'claude' as const, status: 'error' as const },
        { accessToken: 'PRIVATE_SECRET', message: 'PRIVATE_SECRET', headers: { Authorization: 'PRIVATE_SECRET' } })); }
      const files = fs.readdirSync(directory); assert.equal(files.length, 2);
      for (const file of files) {
        const content = fs.readFileSync(path.join(directory, file), 'utf8');
        assert.ok(!content.includes('PRIVATE_SECRET')); assert.ok(Buffer.byteLength(content) <= 400);
        for (const line of content.trim().split('\n')) { assert.equal(JSON.parse(line).event, 'collection'); }
      }
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('tokenbar-test-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return passed;
}
