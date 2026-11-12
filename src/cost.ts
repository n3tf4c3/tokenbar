import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Estimativa do valor equivalente em API do uso das assinaturas, a partir dos registros
 * locais das sessões. Não é cobrança: a assinatura tem preço fixo. Dos registros só saem
 * modelo, contadores de tokens, horário e identificador da resposta; o texto das conversas
 * nunca é guardado, gravado ou registrado.
 */
export interface CostEstimate {
  provider: 'claude' | 'codex';
  /** Desde a meia-noite local. */
  todayUsd: number;
  /** Últimos 7 dias corridos. */
  weekUsd: number;
  /** Houve uso de um modelo sem preço conhecido: o valor é um piso. */
  partial?: boolean;
  computedAt: string;
}

interface Rate { input: number; output: number; cacheRead: number }

/** US$ por milhão de tokens. Escrita em cache: 1,25x a entrada (5 min) e 2x (1 h). */
const CLAUDE_RATES: Record<string, Rate> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 }
};

/** Acima de 272 mil tokens de entrada, a requisição inteira usa a tabela longa. */
export const CODEX_LONG_CONTEXT_TOKENS = 272_000;
const CODEX_RATES: Record<string, { standard: Rate; long: Rate }> = {
  'gpt-6-astra': { standard: { input: 10, output: 50, cacheRead: 1 }, long: { input: 20, output: 75, cacheRead: 2 } },
  'gpt-6.1-sol': { standard: { input: 2, output: 10, cacheRead: 0.1 }, long: { input: 4, output: 15, cacheRead: 0.2 } },
  'gpt-6.1-terra': { standard: { input: 1, output: 5, cacheRead: 0.05 }, long: { input: 2, output: 7.5, cacheRead: 0.1 } }
};

const WEB_SEARCH_USD = 0.01;

const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Tira sufixo de data (`-20251001`) e de contexto (`[1m]`) do identificador do modelo. */
function normalizeModel(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/** Valor em US$ de uma resposta do Claude, ou `undefined` para modelo sem preço conhecido. */
export function priceClaudeUsage(model: unknown, usage: unknown): number | undefined {
  if (typeof model !== 'string' || !usage || typeof usage !== 'object') { return undefined; }
  const rate = CLAUDE_RATES[normalizeModel(model)];
  if (!rate) { return undefined; }
  const u = usage as Record<string, any>;
  const write5m = count(u.cache_creation?.ephemeral_5m_input_tokens);
  const write1h = count(u.cache_creation?.ephemeral_1h_input_tokens);
  // Registros antigos só trazem o total de escrita em cache; vale como 5 minutos.
  const writeUnsplit = Math.max(0, count(u.cache_creation_input_tokens) - write5m - write1h);
  const tokens = count(u.input_tokens) * rate.input + count(u.output_tokens) * rate.output
    + count(u.cache_read_input_tokens) * rate.cacheRead + (write5m + writeUnsplit) * rate.input * 1.25 + write1h * rate.input * 2;
  // Modo rápido custa o dobro em todos os modelos que o oferecem.
  const speed = u.speed === 'fast' ? 2 : 1;
  return tokens * speed / 1e6 + count(u.server_tool_use?.web_search_requests) * WEB_SEARCH_USD;
}

/**
 * Valor em US$ de uma resposta do Codex. `input_tokens` já inclui os tokens lidos do cache
 * e `output_tokens` já inclui o raciocínio.
 */
export function priceCodexUsage(model: unknown, usage: unknown): number | undefined {
  if (typeof model !== 'string' || !usage || typeof usage !== 'object') { return undefined; }
  const rates = CODEX_RATES[normalizeModel(model)];
  if (!rates) { return undefined; }
  const u = usage as Record<string, unknown>;
  const input = count(u.input_tokens);
  const cached = Math.min(input, count(u.cached_input_tokens));
  const rate = input > CODEX_LONG_CONTEXT_TOKENS ? rates.long : rates.standard;
  return ((input - cached) * rate.input + cached * rate.cacheRead + count(u.output_tokens) * rate.output) / 1e6;
}

const DAY_MS = 86_400_000;
/** Arquivos parados há mais que isto não podem ter uso dentro da janela de 7 dias. */
const FILE_WINDOW_MS = 8 * DAY_MS;
/** Uma linha maior que isto é descartada sem ser interpretada. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 8;

interface Entry { at: number; usd: number; priced: boolean; key?: string }

interface FileState {
  offset: number;
  rest?: Buffer;
  skipping?: boolean;
  entries: Entry[];
  /** Codex: modelo de cada turno, que vem em linhas anteriores às de uso. */
  turns?: Map<string, string>;
  lastModel?: string;
}

interface Source {
  provider: CostEstimate['provider'];
  root: string;
  marker: Buffer[];
  parse: (line: unknown, state: FileState) => Entry | undefined;
}

function parseClaudeLine(value: unknown): Entry | undefined {
  const line = value as { type?: unknown; timestamp?: unknown; requestId?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } };
  if (line?.type !== 'assistant' || !line.message?.usage || line.message.model === '<synthetic>') { return undefined; }
  const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
  if (!Number.isFinite(at)) { return undefined; }
  const usd = priceClaudeUsage(line.message.model, line.message.usage);
  // O Claude Code grava uma linha por bloco da resposta, todas com o mesmo uso.
  const key = typeof line.message.id === 'string' ? `claude:${line.message.id}:${String(line.requestId ?? '')}` : undefined;
  return { at, usd: usd ?? 0, priced: usd !== undefined, key };
}

function parseCodexLine(value: unknown, state: FileState): Entry | undefined {
  const line = value as { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };
  const payload = line?.payload;
  if (!payload) { return undefined; }
  if (line.type === 'turn_context') {
    if (typeof payload.model === 'string') {
      state.turns ??= new Map();
      if (typeof payload.turn_id === 'string') { state.turns.set(payload.turn_id, payload.model); }
      state.lastModel = payload.model;
    }
    return undefined;
  }
  if (line.type !== 'token_usage_record') { return undefined; }
  const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
  if (!Number.isFinite(at)) { return undefined; }
  const turn = (id: unknown) => typeof id === 'string' ? state.turns?.get(id) : undefined;
  const model = turn(payload.turn_id) ?? turn(payload.root_turn_id) ?? state.lastModel;
  const usd = priceCodexUsage(model, payload.usage);
  const key = typeof payload.response_id === 'string' ? `codex:${payload.response_id}` : undefined;
  return { at, usd: usd ?? 0, priced: usd !== undefined, key };
}

async function listJsonl(root: string, since: number): Promise<Map<string, fs.Stats>> {
  const found = new Map<string, fs.Stats>();
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      // Links simbólicos não são seguidos: a leitura fica dentro das pastas dos CLIs.
      if (entry.isDirectory() && depth < MAX_DEPTH) { await walk(full, depth + 1); }
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { const stats = await fs.promises.stat(full); if (stats.mtimeMs >= since) { found.set(full, stats); } } catch { /* sumiu */ }
      }
    }
  };
  await walk(root, 0);
  return found;
}

export class CostTracker {
  private readonly files = new Map<string, FileState>();
  private running?: Promise<CostEstimate[]>;
  private readonly sources: Source[];
  private readonly now: () => number;

  public constructor(options: { claudeDir?: string; codexDir?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    const home = os.homedir();
    const claudeDir = options.claudeDir ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
    const codexDir = options.codexDir ?? path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
    this.sources = [
      { provider: 'claude', root: claudeDir, marker: [Buffer.from('"usage"')], parse: parseClaudeLine },
      { provider: 'codex', root: codexDir, marker: [Buffer.from('"token_usage_record"'), Buffer.from('"turn_context"')], parse: parseCodexLine }
    ];
  }

  /** Lê só o que foi acrescentado aos registros desde a última chamada. */
  public refresh(): Promise<CostEstimate[]> {
    this.running ??= this.collect().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async collect(): Promise<CostEstimate[]> {
    const now = this.now();
    const results: CostEstimate[] = [];
    for (const source of this.sources) {
      try { if (!(await fs.promises.stat(source.root)).isDirectory()) { continue; } } catch { continue; }
      const listed = await listJsonl(source.root, now - FILE_WINDOW_MS);
      for (const file of this.files.keys()) {
        if (file.startsWith(source.root + path.sep) && !listed.has(file)) { this.files.delete(file); }
      }
      for (const [file, stats] of listed) { await this.readFile(source, file, stats.size); }
      results.push(this.total(source.provider, source.root, now));
    }
    return results;
  }

  private async readFile(source: Source, file: string, size: number): Promise<void> {
    let state = this.files.get(file);
    if (state && size < state.offset) { state = undefined; } // reescrito ou truncado: relê do início
    if (!state) { state = { offset: 0, entries: [] }; this.files.set(file, state); }
    if (size === state.offset) { return; }
    const current = state;
    try {
      const stream = fs.createReadStream(file, { start: current.offset, end: size - 1 });
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        current.offset += chunk.length;
        this.consume(source, current, chunk);
      }
    } catch { /* arquivo removido ou bloqueado: tenta de novo no próximo ciclo a partir do ponto lido */ }
  }

  private consume(source: Source, state: FileState, chunk: Buffer): void {
    let start = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, newline);
      start = newline + 1;
      if (state.skipping) { state.skipping = false; state.rest = undefined; continue; }
      const line = state.rest ? Buffer.concat([state.rest, piece]) : piece;
      state.rest = undefined;
      this.parseLine(source, state, line);
    }
    if (start < chunk.length && !state.skipping) {
      const tail = chunk.subarray(start);
      const rest = state.rest ? Buffer.concat([state.rest, tail]) : Buffer.from(tail);
      if (rest.length > MAX_LINE_BYTES) { state.rest = undefined; state.skipping = true; } else { state.rest = rest; }
    }
  }

  private parseLine(source: Source, state: FileState, line: Buffer): void {
    // Só interpreta linhas que podem ter uso; as demais (o texto da conversa) nem viram string.
    if (!source.marker.some(marker => line.includes(marker))) { return; }
    let value: unknown;
    try { value = JSON.parse(line.toString('utf8')); } catch { return; }
    const entry = source.parse(value, state);
    if (entry && entry.at >= this.now() - FILE_WINDOW_MS) { state.entries.push(entry); }
  }

  private total(provider: CostEstimate['provider'], root: string, now: number): CostEstimate {
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const today = midnight.getTime(); const week = now - 7 * DAY_MS;
    let todayUsd = 0; let weekUsd = 0; let partial = false;
    // A mesma resposta aparece em vários blocos e em sessões retomadas: conta uma vez só.
    // A repetição fica guardada para continuar valendo se o arquivo da primeira for reescrito.
    const counted = new Set<string>();
    for (const [file, state] of this.files) {
      if (!file.startsWith(root + path.sep)) { continue; }
      // Descarta o que saiu da janela, para a memória não crescer com o daemon ligado.
      const kept: Entry[] = [];
      for (const entry of state.entries) {
        if (entry.at < now - FILE_WINDOW_MS) { continue; }
        kept.push(entry);
        if (entry.at < week || entry.at > now) { continue; }
        if (entry.key) {
          if (counted.has(entry.key)) { continue; }
          counted.add(entry.key);
        }
        weekUsd += entry.usd;
        if (entry.at >= today) { todayUsd += entry.usd; }
        if (!entry.priced) { partial = true; }
      }
      state.entries = kept;
    }
    return { provider, todayUsd: Math.round(todayUsd * 100) / 100, weekUsd: Math.round(weekUsd * 100) / 100,
      partial: partial || undefined, computedAt: new Date(now).toISOString() };
  }
}

/** Aceita só estimativas bem formadas de um snapshot salvo. */
export function restoreCosts(value: unknown): CostEstimate[] | undefined {
  if (!Array.isArray(value)) { return undefined; }
  const costs = value.filter((item): item is CostEstimate => !!item && (item.provider === 'claude' || item.provider === 'codex')
    && [item.todayUsd, item.weekUsd].every(amount => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0)
    && typeof item.computedAt === 'string' && Number.isFinite(Date.parse(item.computedAt))
    && (item.partial === undefined || typeof item.partial === 'boolean'))
    .map(item => ({ provider: item.provider, todayUsd: item.todayUsd, weekUsd: item.weekUsd, partial: item.partial || undefined, computedAt: item.computedAt }));
  return costs.length ? costs : undefined;
}
