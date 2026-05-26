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
import {
  computeCost as computeCostCore,
  resolveModel,
  type CostResult,
  type ModelPricing,
  type PricingTable,
} from './pricing-calc.js';

export type { CostResult, ModelPricing, PricingTable };
export { resolveModel };
export type { ComputeCostInput as ComputeCostCoreInput } from './pricing-calc.js';

let cachedTable: PricingTable | null = null;

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
  const table = input.table ?? loadPricingTable();
  return computeCostCore({ ...input, table });
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
    const r = computeCostCore({ ...e, table: tbl });
    if (r.method === 'logged') logged += r.usd;
    else estimated += r.usd;
  }
  return { usd: logged + estimated, logged_usd: logged, estimated_usd: estimated };
}
