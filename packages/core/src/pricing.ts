// Pricing layer. Loads the vendored LiteLLM-style JSON and provides
// computeCost(model, tokens). The methodology is explicit and surfaced in the
// UI so users can see when a value is logged vs. estimated.
//
// Methodology:
//   cost_usd = input * input_per_token
//            + output * output_per_token
//            + cache_read * cache_read_per_token
//            + cache_creation * cache_creation_per_token
//   reasoning tokens are billed as output (Anthropic-style).
//
// Cost reconciliation target: within 1% of ccusage for the same session
// (see pricing.test.ts).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EventTokens } from './schema.js';

export interface ModelPricing {
  input_per_token: number;
  output_per_token: number;
  cache_read_per_token: number;
  cache_creation_per_token: number;
  max_input_tokens: number;
}

export interface PricingTable {
  _meta: {
    source: string;
    fetched_at: string;
    notes: string;
  };
  models: Record<string, ModelPricing>;
  aliases: Record<string, string>;
}

export interface CostResult {
  usd: number;
  method: 'logged' | 'estimated' | null;
  /** Resolved canonical model name after alias lookup; null when unknown. */
  resolved_model: string | null;
}

let cachedTable: PricingTable | null = null;

/** Resolve a model id through the alias map to its canonical pricing key. */
export function resolveModel(
  table: PricingTable,
  model: string | null | undefined,
): string | null {
  if (!model) return null;
  if (table.models[model]) return model;
  const aliased = table.aliases[model];
  if (aliased && table.models[aliased]) return aliased;
  // Heuristic fallback: strip trailing -YYYYMMDD date suffix
  const stripped = model.replace(/-\d{8}$/, '');
  if (stripped !== model && table.models[stripped]) return stripped;
  return null;
}

export function loadPricingTable(path?: string): PricingTable {
  if (cachedTable && !path) return cachedTable;
  const resolved =
    path ??
    join(dirname(fileURLToPath(import.meta.url)), '..', 'pricing.json');
  const table = JSON.parse(readFileSync(resolved, 'utf8')) as PricingTable;
  if (!path) cachedTable = table;
  return table;
}

/** For tests. */
export function clearPricingCache(): void {
  cachedTable = null;
}

export interface ComputeCostInput {
  model: string | null;
  tokens: Partial<EventTokens>;
  /** If the harness logged a cost directly, pass it here. */
  logged_usd?: number | null;
  table?: PricingTable;
}

/**
 * Returns the cost in USD plus the methodology. If `logged_usd` is provided,
 * we use it and mark as `logged`; otherwise we compute from the pricing table
 * and mark as `estimated`. If the model is unknown, returns `{ usd: 0, method: null }`.
 */
export function computeCost(input: ComputeCostInput): CostResult {
  if (input.logged_usd != null) {
    return {
      usd: input.logged_usd,
      method: 'logged',
      resolved_model: resolveModel(
        input.table ?? loadPricingTable(),
        input.model,
      ),
    };
  }
  const table = input.table ?? loadPricingTable();
  const resolved = resolveModel(table, input.model);
  if (!resolved) {
    return { usd: 0, method: null, resolved_model: null };
  }
  const p = table.models[resolved]!;
  const t = input.tokens;
  const input_tok = t.input ?? 0;
  const output_tok = (t.output ?? 0) + (t.reasoning ?? 0);
  const cache_read_tok = t.cache_read ?? 0;
  const cache_creation_tok = t.cache_creation ?? 0;
  const usd =
    input_tok * p.input_per_token +
    output_tok * p.output_per_token +
    cache_read_tok * p.cache_read_per_token +
    cache_creation_tok * p.cache_creation_per_token;
  return { usd, method: 'estimated', resolved_model: resolved };
}

/** Aggregate cost across many events. */
export function sumCosts(
  events: { model: string | null; tokens: Partial<EventTokens>; logged_usd?: number | null }[],
  table?: PricingTable,
): { usd: number; logged_usd: number; estimated_usd: number } {
  const tbl = table ?? loadPricingTable();
  let logged = 0;
  let estimated = 0;
  for (const e of events) {
    const r = computeCost({ ...e, table: tbl });
    if (r.method === 'logged') logged += r.usd;
    else estimated += r.usd;
  }
  return { usd: logged + estimated, logged_usd: logged, estimated_usd: estimated };
}
