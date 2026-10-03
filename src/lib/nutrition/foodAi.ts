import type { BetaContentBlock, BetaContentBlockParam, BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { getAnthropicKey } from './keys';
import { buildPrompt } from './prompt';
import { MEAL_SCHEMA, parseMealOutput } from './schema';
import type { Confidence } from './types';

/*
 * Claude, called straight from the phone with the user's own key (keys.ts — device only, never logged).
 *
 * - Official SDK, imported dynamically so it stays out of the main bundle (the Food tab chunks load it).
 * - Model claude-opus-5-5. Thinking is always on for this model (a `thinking` param that disables it 400s),
 *   so there is no `thinking` field; `output_config.effort` is the dial (medium; one retry at low when the
 *   answer is cut off).
 * - Structured outputs (`output_config.format`) guarantee the JSON shape; schema.ts still validates + clamps.
 * - Server-side refusal fallback (`fallbacks: "default"`, beta server-side-fallback-2026-07-01): when the
 *   safety classifiers decline a (benign) meal photo, the API re-runs it on Anthropic's recommended fallback
 *   model inside the same call. The response then starts with a `fallback` block, so the answer is the LAST
 *   text block after the last `fallback` block.
 * - The SDK's own retries are off (maxRetries 0): this module decides what to retry, and every BILLED
 *   response (ok or not) is returned in `calls` so the app can show real spend.
 */

export const AI_MODEL = 'claude-opus-5-5';
export const AI_MAX_TOKENS = 16000;
export const AI_TIMEOUT_MS = 180_000;
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_IMAGES = 4;
const RATE_LIMIT_WAIT_CAP_MS = 20_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 2_000;
const OVERLOAD_WAIT_MS = 2_000;

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

// ------------------------------------------------------------------ pricing

/** USD per million tokens (input / output). Unknown models are priced as Claude Opus 5.5. */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

/** Price row for a model id (exact, else the longest known prefix, e.g. a dated snapshot; else Opus 5.5). */
export function priceFor(model: string | null | undefined): { input: number; output: number } {
  const id = (model ?? '').trim();
  if (PRICES[id]) return PRICES[id];
  const prefix = Object.keys(PRICES)
    .filter((k) => id.startsWith(k + '-'))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? PRICES[prefix] : PRICES[AI_MODEL];
}

interface TokenUse {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const n0 = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** USD for one attempt (cache writes at 1.25× and reads at 0.1× the input rate; we don't cache today). */
export function costUsd(model: string | null | undefined, u: TokenUse): number {
  const p = priceFor(model);
  const input = n0(u.input_tokens) + n0(u.cache_creation_input_tokens) * 1.25 + n0(u.cache_read_input_tokens) * 0.1;
  return (input * p.input + n0(u.output_tokens) * p.output) / 1e6;
}

type Call = AnalyzeResult['calls'][number];

/** One billed response → one call record. With fallback hops, each iteration is priced by its own model. */
export function billedCall(msg: Pick<BetaMessage, 'model' | 'usage'>, ok: boolean, error?: string): Call {
  const iterations = (msg.usage?.iterations ?? []) as (TokenUse & { model?: string | null })[];
  const parts = iterations.length ? iterations.map((it) => ({ model: it.model || msg.model, u: it })) : [{ model: msg.model, u: msg.usage as TokenUse }];
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  for (const { model, u } of parts) {
    inputTokens += n0(u.input_tokens) + n0(u.cache_creation_input_tokens) + n0(u.cache_read_input_tokens);
    outputTokens += n0(u.output_tokens);
    cost += costUsd(model, u);
  }
  const call: Call = { model: msg.model || AI_MODEL, inputTokens, outputTokens, costUsd: cost, ok };
  if (error) call.error = error;
  return call;
}

// ------------------------------------------------------------------ request / response

type Sdk = typeof import('@anthropic-ai/sdk');

export interface AiDeps {
  fetch?: typeof fetch;
  apiKey?: string;
  /** How many times a 429 / overload may be retried (default 1). The SDK's own retries are always off. */
  maxRetries?: number;
  /** Injected in tests so retries don't really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Request timeout (default 180 s). */
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeClient(sdk: Sdk, apiKey: string, deps: Pick<AiDeps, 'fetch' | 'timeoutMs'>, timeout: number) {
  return new sdk.default({
    apiKey,
    dangerouslyAllowBrowser: true, // the user's own key, on their own device — see keys.ts
    maxRetries: 0,
    timeout: deps.timeoutMs ?? timeout,
    fetch: deps.fetch,
  });
}

/** The answer text: the LAST text block after the last `fallback` block (thinking blocks come first). */
export function answerText(content: BetaContentBlock[]): string | null {
  let start = 0;
  content.forEach((b, i) => {
    if (b.type === 'fallback') start = i + 1;
  });
  for (let i = content.length - 1; i >= start; i--) {
    const b = content[i];
    if (b.type === 'text') return b.text;
  }
  return null;
}

/** The API's own error message (not the SDK's "429 {json}" string). */
function apiMessage(e: { error?: unknown; message: string }): string {
  const m = (e.error as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof m === 'string' && m.trim() ? m.trim() : e.message;
}

function retryAfterMs(headers: Headers | undefined): number | null {
  const ms = parseFloat(headers?.get('retry-after-ms') ?? '');
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers?.get('retry-after');
  if (raw != null && raw.trim() !== '') {
    const s = parseFloat(raw);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return null;
}

/** Run the meal through Claude. Throws AiError (with any billed calls attached). */
export async function analyzeMeal(input: AnalyzeInput, deps: AiDeps = {}): Promise<AnalyzeResult> {
  const apiKey = (deps.apiKey ?? getAnthropicKey())?.trim();
  if (!apiKey) throw new AiError('no_key', 'No Claude API key is saved on this device.');
  const images = input.images.slice(0, MAX_IMAGES);
  const description = input.description?.trim() ?? '';
  if (!images.length && !description) throw new AiError('bad_request', 'Add a photo or describe the food.');

  const sdk: Sdk = await import('@anthropic-ai/sdk');
  const client = makeClient(sdk, apiKey, deps, AI_TIMEOUT_MS);
  const sleep = deps.sleep ?? realSleep;
  const retryBudget = Math.max(0, Math.floor(deps.maxRetries ?? 1));

  const content: BetaContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i + 1} of ${images.length}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  });
  content.push({ type: 'text', text: buildPrompt({ imageCount: images.length, description, weightG: input.weightG }) });

  const calls: Call[] = [];
  let effort: 'medium' | 'low' = 'medium';
  let rateRetries = retryBudget;
  let overloadRetries = retryBudget;

  for (;;) {
    let msg: BetaMessage;
    try {
      msg = await client.beta.messages.create({
        model: AI_MODEL,
        max_tokens: AI_MAX_TOKENS,
        messages: [{ role: 'user', content }],
        output_config: { effort, format: { type: 'json_schema', schema: MEAL_SCHEMA } },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      });
    } catch (e) {
      // Typed SDK errors, most specific first (APIConnectionTimeoutError extends APIConnectionError extends APIError).
      if (e instanceof sdk.AuthenticationError) throw new AiError('key_rejected', apiMessage(e), calls);
      if (e instanceof sdk.PermissionDeniedError) throw new AiError('forbidden', apiMessage(e), calls);
      if (e instanceof sdk.RateLimitError) {
        if (rateRetries-- > 0) {
          await sleep(Math.min(RATE_LIMIT_WAIT_CAP_MS, retryAfterMs(e.headers) ?? DEFAULT_RATE_LIMIT_WAIT_MS));
          continue;
        }
        throw new AiError('rate_limited', apiMessage(e), calls);
      }
      if (e instanceof sdk.APIConnectionTimeoutError) throw new AiError('timeout', 'Claude took too long to answer.', calls);
      if (e instanceof sdk.APIConnectionError) throw new AiError('network', "Couldn't reach Anthropic.", calls);
      if (e instanceof sdk.BadRequestError) throw new AiError('bad_request', apiMessage(e), calls);
      if (e instanceof sdk.APIError && typeof e.status === 'number') {
        const overloaded = e.status === 529 || e.type === 'overloaded_error';
        if (overloaded || e.status >= 500) {
          if (overloadRetries-- > 0) {
            await sleep(OVERLOAD_WAIT_MS);
            continue;
          }
          if (overloaded) throw new AiError('overloaded', apiMessage(e), calls);
          throw new AiError('unknown', `Anthropic server error (${e.status}): ${apiMessage(e)}`, calls);
        }
        if (e.status === 402) throw new AiError('forbidden', apiMessage(e), calls); // billing
        throw new AiError('bad_request', apiMessage(e), calls);
      }
      throw new AiError('unknown', e instanceof Error ? e.message : String(e), calls);
    }

    // Billed from here on. Check stop_reason BEFORE reading content.
    const stop = msg.stop_reason;
    if (stop === 'refusal') {
      calls.push(billedCall(msg, false, 'refused'));
      throw new AiError('refused', 'Claude declined to analyze this meal.', calls);
    }
    if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') {
      calls.push(billedCall(msg, false, 'truncated'));
      if (stop === 'max_tokens' && effort === 'medium') {
        effort = 'low';
        continue;
      }
      throw new AiError('truncated', "Claude's answer was cut off.", calls);
    }
    if (stop !== 'end_turn' && stop !== 'stop_sequence') {
      calls.push(billedCall(msg, false, 'invalid_output'));
      throw new AiError('invalid_output', `Unexpected stop reason: ${stop ?? 'none'}.`, calls);
    }

    const text = answerText(msg.content);
    let parsed: ReturnType<typeof parseMealOutput>;
    try {
      if (text == null) throw new Error('no text block');
      parsed = parseMealOutput(JSON.parse(text));
    } catch {
      calls.push(billedCall(msg, false, 'invalid_output'));
      throw new AiError('invalid_output', "Claude's answer couldn't be read.", calls);
    }
    calls.push(billedCall(msg, true));
    return { ...parsed, calls };
  }
}

/** Check a pasted key without spending tokens (GET /v1/models/{id}). */
export async function testApiKey(key: string, deps: { fetch?: typeof fetch } = {}): Promise<{ ok: boolean; message: string }> {
  const apiKey = key.trim();
  if (!apiKey) return { ok: false, message: 'Paste a key first.' };
  const sdk: Sdk = await import('@anthropic-ai/sdk');
  const client = makeClient(sdk, apiKey, deps, 20_000);
  try {
    await client.models.retrieve(AI_MODEL);
    return { ok: true, message: 'Key works' };
  } catch (e) {
    if (e instanceof sdk.AuthenticationError) return { ok: false, message: 'That key was rejected' };
    if (e instanceof sdk.PermissionDeniedError) return { ok: false, message: apiMessage(e) };
    if (e instanceof sdk.NotFoundError) return { ok: false, message: `The key works, but it can't use ${AI_MODEL}: ${apiMessage(e)}` };
    if (e instanceof sdk.RateLimitError) return { ok: true, message: 'Key works (Anthropic is rate-limiting it right now)' };
    if (e instanceof sdk.APIConnectionError) return { ok: false, message: "Couldn't reach Anthropic" };
    if (e instanceof sdk.APIError) return { ok: false, message: apiMessage(e) };
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
