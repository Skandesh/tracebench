// Local embedding model via @huggingface/transformers (optional dependency).
// Lazily acquired; returns null if the dependency or model is unavailable so
// callers degrade to lexical-only. No static import — the dep is optional.

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);

export const EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBED_DTYPE = 'q8';

/** Embed a batch of texts → one vector (number[]) per text. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface Embedder {
  modelId: string;
  dtype: string;
  embed: EmbedFn;
}

export interface CreateEmbedderOptions {
  modelId?: string;
  dtype?: string;
  /** Model cache dir; defaults to ~/.tracebench/models (never cwd-relative). */
  cacheDir?: string;
}

/**
 * Build a local embedder. Returns null when the optional dependency is missing
 * or the model can't be loaded (e.g. offline with no cache) — the caller then
 * runs lexical-only. The model downloads on first use to the cache dir.
 */
export async function createEmbedder(opts: CreateEmbedderOptions = {}): Promise<Embedder | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let transformers: any;
  try {
    transformers = nodeRequire('@huggingface/transformers');
  } catch {
    return null; // optional dep not installed
  }
  try {
    const { pipeline, env } = transformers;
    env.cacheDir = opts.cacheDir ?? join(homedir(), '.tracebench', 'models');
    const modelId = opts.modelId ?? EMBED_MODEL_ID;
    const dtype = opts.dtype ?? EMBED_DTYPE;
    const extractor = await pipeline('feature-extraction', modelId, { dtype });
    const embed: EmbedFn = async (texts) => {
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      return out.tolist() as number[][];
    };
    return { modelId, dtype, embed };
  } catch {
    return null; // model acquisition / load failure → degrade
  }
}
