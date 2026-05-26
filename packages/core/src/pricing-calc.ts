// Browser-safe pricing calculations — no filesystem I/O.

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
  resolved_model: string | null;
}

export interface ComputeCostInput {
  model: string | null;
  tokens: Partial<EventTokens>;
  logged_usd?: number | null;
  table: PricingTable;
}

/** Resolve a model id through the alias map to its canonical pricing key. */
export function resolveModel(
  table: PricingTable,
  model: string | null | undefined,
): string | null {
  if (!model) return null;
  if (table.models[model]) return model;
  const aliased = table.aliases[model];
  if (aliased && table.models[aliased]) return aliased;
  const stripped = model.replace(/-\d{8}$/, '');
  if (stripped !== model && table.models[stripped]) return stripped;
  return null;
}

export function computeCost(input: ComputeCostInput): CostResult {
  if (input.logged_usd != null) {
    return {
      usd: input.logged_usd,
      method: 'logged',
      resolved_model: resolveModel(input.table, input.model),
    };
  }
  const resolved = resolveModel(input.table, input.model);
  if (!resolved) {
    return { usd: 0, method: null, resolved_model: null };
  }
  const p = input.table.models[resolved]!;
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
