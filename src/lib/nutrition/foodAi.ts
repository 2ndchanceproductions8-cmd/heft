import type { Confidence } from './types';

// CONTRACT STUB (foundation). The engine builder replaces the bodies; exported names/types are fixed.

export const AI_MODEL = 'claude-opus-5-5';

export interface AnalyzeImage {
  /** base64 (no data: prefix) */
  data: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export interface AnalyzeInput {
  images: AnalyzeImage[]; // 0..4
  description?: string;
  weightG?: number | null;
}

/** One food as Claude reports it (recognition + portion; nutrients are only a fallback estimate for weightG). */
export interface AiItem {
  name: string;
  fdcQuery: string;
  portion: string;
  weightG: number;
  estimate: { kcal: number; proteinG: number; carbsG: number; fatG: number; fiberG: number; sugarG: number; sodiumMg: number };
}

export interface AnalyzeResult {
  isFood: boolean;
  items: AiItem[];
  confidence: Confidence;
  scaleReference: string | null;
  notes: string;
  /** The billed calls this analysis made (one, or more with retries/fallback). */
  calls: { model: string; inputTokens: number; outputTokens: number; costUsd: number; ok: boolean; error?: string }[];
}

export type AiErrorCode = 'no_key' | 'key_rejected' | 'refused' | 'rate_limited' | 'overloaded' | 'bad_request' | 'network' | 'timeout' | 'truncated' | 'invalid_output' | 'forbidden' | 'unknown';

export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    message: string,
    public calls: AnalyzeResult['calls'] = [],
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** Run the meal through Claude. Throws AiError (with any billed calls attached). */
export async function analyzeMeal(_input: AnalyzeInput, _deps: { fetch?: typeof fetch; apiKey?: string; maxRetries?: number } = {}): Promise<AnalyzeResult> {
  throw new Error('not implemented: foodAi.analyzeMeal');
}

/** Check a pasted key without spending tokens (GET /v1/models/{id}). */
export async function testApiKey(_key: string, _deps: { fetch?: typeof fetch } = {}): Promise<{ ok: boolean; message: string }> {
  throw new Error('not implemented: foodAi.testApiKey');
}
