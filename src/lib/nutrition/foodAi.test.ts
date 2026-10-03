import { describe, expect, it, vi } from 'vitest';
import { AI_MODEL, AI_TIMEOUT_MS, AiError, analyzeMeal, answerText, billedCall, priceFor, testApiKey, type AnalyzeInput } from './foodAi';
import { MEAL_SCHEMA } from './schema';

/*
 * Zero-spend: every request goes to a stubbed fetch passed through deps (the real Anthropic API is never
 * called), and retry waits go through an injected sleep.
 */

const KEY = 'test-key-not-a-real-anthropic-key';

const MEAL_JSON = {
  is_food: true,
  items: [
    { name: 'White rice', fdc_query: 'rice, white, cooked', portion: '1 cup', weight_g: 180, calories: 234, protein_g: 4.3, carbs_g: 51, fat_g: 0.5, fiber_g: 0.7, sugar_g: 0.1, sodium_mg: 2 },
    { name: 'Grilled chicken breast', fdc_query: 'chicken breast, grilled', portion: '1 breast', weight_g: 9000, calories: 280, protein_g: 53, carbs_g: 0, fat_g: 6, fiber_g: -2, sugar_g: 0, sodium_mg: 120 },
  ],
  confidence: 'medium',
  scale_reference: 'fork',
  notes: 'Fork for scale.',
};

const usage = (input: number, output: number, extra: Record<string, unknown> = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...extra,
});

function message(over: Record<string, unknown> = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: AI_MODEL,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: JSON.stringify(MEAL_JSON) },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: usage(1500, 400),
    ...over,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...headers } });
const apiError = (status: number, type: string, msg: string, headers: Record<string, string> = {}) =>
  json({ type: 'error', error: { type, message: msg } }, status, headers);

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

function stub(answers: (() => Response | Promise<Response>)[]) {
  const seen: Seen[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const next = answers[Math.min(seen.length - 1, answers.length - 1)];
    return next();
  });
  return { fetch: fetchFn as unknown as typeof fetch, seen };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};
const deps = (f: typeof fetch) => ({ fetch: f, apiKey: KEY, sleep });

const INPUT: AnalyzeInput = {
  images: [
    { data: 'AAAA', mediaType: 'image/jpeg' },
    { data: 'BBBB', mediaType: 'image/png' },
  ],
  description: 'rice and chicken',
  weightG: null,
};

async function expectAiError(p: Promise<unknown>, code: string): Promise<AiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AiError);
    expect((e as AiError).code).toBe(code);
    return e as AiError;
  }
  throw new Error('expected AiError ' + code);
}

describe('analyzeMeal request', () => {
  it('POSTs the documented request: model, headers, effort + JSON schema, fallbacks, labelled images before the prompt', async () => {
    const s = stub([() => json(message())]);
    await analyzeMeal(INPUT, deps(s.fetch));
    expect(s.seen).toHaveLength(1);
    const { url, method, headers, body } = s.seen[0];
    expect(method).toBe('POST');
    expect(url.origin + url.pathname).toBe('https://api.anthropic.com/v1/messages');
    expect(headers.get('x-api-key')).toBe(KEY);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(headers.get('anthropic-beta')?.split(',').map((b) => b.trim())).toContain('server-side-fallback-2026-07-01');

    expect(body).not.toBeNull();
    expect(body!.model).toBe('claude-opus-5-5');
    expect(body!.max_tokens).toBe(16000);
    expect('thinking' in body!).toBe(false);
    expect(body!.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: JSON.parse(JSON.stringify(MEAL_SCHEMA)) } });
    expect(body!.fallbacks).toBe('default');
    expect('betas' in body!).toBe(false); // sent as the anthropic-beta header

    const messages = body!.messages as { role: string; content: { type: string; text?: string; source?: Record<string, string> }[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    const c = messages[0].content;
    expect(c.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image', 'text']);
    expect(c[0].text).toBe('Photo 1 of 2:');
    expect(c[1].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'AAAA' });
    expect(c[2].text).toBe('Photo 2 of 2:');
    expect(c[3].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'BBBB' });
    expect(c[4].text).toContain('PORTION ESTIMATION');
    expect(c[4].text).toContain('Food description: rice and chicken');
    expect(c[4].text).not.toMatch(/STRICT JSON/i);
  });

  it('no key → no_key and no request; nothing to analyze → bad_request and no request', async () => {
    const s = stub([() => json(message())]);
    await expectAiError(analyzeMeal(INPUT, { fetch: s.fetch, sleep }), 'no_key'); // node: no localStorage key
    await expectAiError(analyzeMeal({ images: [], description: '  ' }, deps(s.fetch)), 'bad_request');
    expect(s.seen).toHaveLength(0);
  });
});

describe('analyzeMeal responses', () => {
  it('end_turn → validated, clamped, camelCase result with one billed call', async () => {
    const s = stub([() => json(message())]);
    const r = await analyzeMeal(INPUT, deps(s.fetch));
    expect(r.isFood).toBe(true);
    expect(r.confidence).toBe('medium');
    expect(r.scaleReference).toBe('fork');
    expect(r.notes).toBe('Fork for scale.');
    expect(r.items[0]).toEqual({
      name: 'White rice',
      fdcQuery: 'rice, white, cooked',
      portion: '1 cup',
      weightG: 180,
      estimate: { kcal: 234, proteinG: 4.3, carbsG: 51, fatG: 0.5, fiberG: 0.7, sugarG: 0.1, sodiumMg: 2 },
    });
    expect(r.items[1].weightG).toBe(5000); // clamped
    expect(r.items[1].estimate.fiberG).toBe(0); // clamped
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ model: AI_MODEL, inputTokens: 1500, outputTokens: 400, ok: true });
    expect(r.calls[0].costUsd).toBeCloseTo((1500 * 4 + 400 * 20) / 1e6, 10);
  });

  it('thinking + declined partial + fallback + text: parses the last text after the last fallback block, prices each hop', async () => {
    const s = stub([
      () =>
        json(
          message({
            model: 'claude-opus-4-8',
            content: [
              { type: 'thinking', thinking: '', signature: 'a' },
              { type: 'text', text: '{"is_food": tr' },
              { type: 'fallback', from: { model: AI_MODEL }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'bio' } },
              { type: 'thinking', thinking: '', signature: 'b' },
              { type: 'text', text: JSON.stringify(MEAL_JSON) },
            ],
            usage: usage(1000, 300, {
              iterations: [
                { type: 'message', model: AI_MODEL, ...usage(1000, 50), cache_creation: null },
                { type: 'fallback_message', model: 'claude-opus-4-8', ...usage(1000, 300), cache_creation: null },
              ],
            }),
          }),
        ),
    ]);
    const r = await analyzeMeal(INPUT, deps(s.fetch));
    expect(r.items).toHaveLength(2);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ model: 'claude-opus-4-8', inputTokens: 2000, outputTokens: 350, ok: true });
    expect(r.calls[0].costUsd).toBeCloseTo((1000 * 4 + 50 * 20) / 1e6 + (1000 * 5 + 300 * 25) / 1e6, 10);
  });

  it('max_tokens → exactly one retry at effort low (both calls recorded)', async () => {
    const s = stub([() => json(message({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 'x' }], usage: usage(1500, 16000) })), () => json(message())]);
    const r = await analyzeMeal(INPUT, deps(s.fetch));
    expect(s.seen.map((x) => (x.body!.output_config as { effort: string }).effort)).toEqual(['medium', 'low']);
    expect(r.calls.map((c) => c.ok)).toEqual([false, true]);
    expect(r.calls[0].error).toBe('truncated');

    const s2 = stub([() => json(message({ stop_reason: 'max_tokens', content: [] }))]);
    const e = await expectAiError(analyzeMeal(INPUT, deps(s2.fetch)), 'truncated');
    expect(s2.seen).toHaveLength(2);
    expect(e.calls).toHaveLength(2);
  });

  it('refusal → refused, no retry, the billed call recorded', async () => {
    const s = stub([() => json(message({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'bio', explanation: null }, usage: usage(1200, 0) }))]);
    const e = await expectAiError(analyzeMeal(INPUT, deps(s.fetch)), 'refused');
    expect(s.seen).toHaveLength(1);
    expect(e.calls).toEqual([{ model: AI_MODEL, inputTokens: 1200, outputTokens: 0, costUsd: (1200 * 4) / 1e6, ok: false, error: 'refused' }]);
  });

  it('unparseable text → invalid_output with the call recorded', async () => {
    const s = stub([() => json(message({ content: [{ type: 'text', text: 'not json' }] }))]);
    const e = await expectAiError(analyzeMeal(INPUT, deps(s.fetch)), 'invalid_output');
    expect(e.calls).toHaveLength(1);
    expect(e.calls[0].ok).toBe(false);
  });

  it('401 → key_rejected, no retry', async () => {
    const s = stub([() => apiError(401, 'authentication_error', 'invalid x-api-key')]);
    const e = await expectAiError(analyzeMeal(INPUT, deps(s.fetch)), 'key_rejected');
    expect(s.seen).toHaveLength(1);
    expect(e.calls).toEqual([]);
  });

  it('400 → bad_request with the API message, no retry', async () => {
    const s = stub([() => apiError(400, 'invalid_request_error', 'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum')]);
    const e = await expectAiError(analyzeMeal(INPUT, deps(s.fetch)), 'bad_request');
    expect(e.message).toBe('messages.0.content.1.image.source.base64: image exceeds 5 MB maximum');
    expect(s.seen).toHaveLength(1);
  });

  it('403 → forbidden with the API message', async () => {
    const s = stub([() => apiError(403, 'permission_error', 'Your organization does not have access to this model.')]);
    const e = await expectAiError(analyzeMeal(INPUT, deps(s.fetch)), 'forbidden');
    expect(e.message).toBe('Your organization does not have access to this model.');
  });

  it('529 → waits 2 s, retries once, then overloaded', async () => {
    sleeps.length = 0;
    const s = stub([() => apiError(529, 'overloaded_error', 'Overloaded')]);
    await expectAiError(analyzeMeal(INPUT, deps(s.fetch)), 'overloaded');
    expect(s.seen).toHaveLength(2);
    expect(sleeps).toEqual([2000]);

    const s2 = stub([() => apiError(529, 'overloaded_error', 'Overloaded'), () => json(message())]);
    expect((await analyzeMeal(INPUT, deps(s2.fetch))).isFood).toBe(true);
    expect(s2.seen).toHaveLength(2);
  });

  it('429 with retry-after 0 → retries once immediately; a second 429 → rate_limited with the API message', async () => {
    sleeps.length = 0;
    const s = stub([() => apiError(429, 'rate_limit_error', 'Slow down', { 'retry-after': '0' }), () => json(message())]);
    expect((await analyzeMeal(INPUT, deps(s.fetch))).items).toHaveLength(2);
    expect(sleeps).toEqual([0]);
    expect(s.seen).toHaveLength(2);

    const limit = 'This request would exceed your workspace spend limit.';
    const s2 = stub([() => apiError(429, 'rate_limit_error', limit, { 'retry-after': '0' })]);
    const e = await expectAiError(analyzeMeal(INPUT, deps(s2.fetch)), 'rate_limited');
    expect(e.message).toBe(limit);
    expect(s2.seen).toHaveLength(2);
  });

  it('429 waits honour retry-after-ms and are capped at 20 s', async () => {
    sleeps.length = 0;
    const s = stub([() => apiError(429, 'rate_limit_error', 'x', { 'retry-after-ms': '1500', 'retry-after': '2' }), () => json(message())]);
    await analyzeMeal(INPUT, deps(s.fetch));
    const s2 = stub([() => apiError(429, 'rate_limit_error', 'x', { 'retry-after': '90' }), () => json(message())]);
    await analyzeMeal(INPUT, deps(s2.fetch));
    expect(sleeps).toEqual([1500, 20000]);
  });

  it('maxRetries 0 disables the 429/529 retry', async () => {
    const s = stub([() => apiError(529, 'overloaded_error', 'Overloaded')]);
    await expectAiError(analyzeMeal(INPUT, { ...deps(s.fetch), maxRetries: 0 }), 'overloaded');
    expect(s.seen).toHaveLength(1);
  });

  it('network failure → network; request timeout → timeout', async () => {
    const s = stub([() => Promise.reject(new TypeError('Load failed'))]);
    await expectAiError(analyzeMeal(INPUT, deps(s.fetch)), 'network');
    expect(s.seen).toHaveLength(1);

    const hang = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
    );
    await expectAiError(analyzeMeal(INPUT, { ...deps(hang as unknown as typeof fetch), timeoutMs: 20 }), 'timeout');
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it('the default timeout is the SDK’s 10 minutes (not 180 s), still with no SDK retries', async () => {
    expect(AI_TIMEOUT_MS).toBe(600_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hang = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
      );
      const p = analyzeMeal(INPUT, deps(hang as unknown as typeof fetch));
      let settled = false;
      p.catch(() => undefined).finally(() => (settled = true));
      await vi.waitFor(() => expect(hang).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(599_000);
      expect(settled).toBe(false); // 180 s used to end it here, unbilled and unretried
      await vi.advanceTimersByTimeAsync(1_500);
      const e = await expectAiError(p, 'timeout');
      expect(e.calls).toEqual([]);
      expect(hang).toHaveBeenCalledTimes(1); // maxRetries 0: the SDK never retried the timeout
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow answer cut off at max_tokens after 5 minutes still gets its one low-effort retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const later = (ms: number, res: () => Response) => () => new Promise<Response>((r) => setTimeout(() => r(res()), ms));
      const s = stub([
        later(300_000, () => json(message({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 'x' }], usage: usage(1500, 16000) }))),
        later(60_000, () => json(message())),
      ]);
      const p = analyzeMeal(INPUT, deps(s.fetch));
      await vi.advanceTimersByTimeAsync(361_000);
      const r = await p;
      expect(s.seen.map((x) => (x.body!.output_config as { effort: string }).effort)).toEqual(['medium', 'low']);
      expect(r.calls.map((c) => [c.ok, c.error])).toEqual([
        [false, 'truncated'],
        [true, undefined],
      ]);
      expect(r.calls[0].outputTokens).toBe(16000); // the cut-off call is priced and recorded
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('testApiKey', () => {
  it('GET /v1/models/claude-opus-5-5 with the key; maps 200 / 401 / network', async () => {
    const s = stub([() => json({ type: 'model', id: AI_MODEL, display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z' })]);
    expect(await testApiKey(KEY, { fetch: s.fetch })).toEqual({ ok: true, message: 'Key works' });
    expect(s.seen[0].method).toBe('GET');
    expect(s.seen[0].url.href).toBe('https://api.anthropic.com/v1/models/claude-opus-5-5');
    expect(s.seen[0].headers.get('x-api-key')).toBe(KEY);

    const s2 = stub([() => apiError(401, 'authentication_error', 'invalid x-api-key')]);
    expect(await testApiKey(KEY, { fetch: s2.fetch })).toEqual({ ok: false, message: 'That key was rejected' });
    expect(s2.seen).toHaveLength(1);

    const s3 = stub([() => Promise.reject(new TypeError('Failed to fetch'))]);
    expect(await testApiKey(KEY, { fetch: s3.fetch })).toEqual({ ok: false, message: "Couldn't reach Anthropic" });
    expect(await testApiKey('   ')).toEqual({ ok: false, message: 'Paste a key first.' });
  });
});

describe('pricing + parsing helpers', () => {
  it('prices by model id, dated snapshots by prefix, unknown models as Opus 5.5', () => {
    expect(priceFor('claude-opus-5-5')).toEqual({ input: 4, output: 20 });
    expect(priceFor('claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(priceFor('claude-opus-5-20260101')).toEqual({ input: 5, output: 25 });
    expect(priceFor('claude-fable-5-1')).toEqual({ input: 10, output: 50 });
    expect(priceFor('claude-haiku-4-5')).toEqual({ input: 1, output: 5 });
    expect(priceFor('claude-sonnet-5-5')).toEqual({ input: 2, output: 10 });
    expect(priceFor('something-new')).toEqual({ input: 4, output: 20 });
    expect(billedCall({ model: 'claude-sonnet-5', usage: usage(1e6, 1e6) as never }, true).costUsd).toBeCloseTo(12, 10);
  });

  it('answerText ignores everything before the last fallback block', () => {
    expect(answerText([{ type: 'text', text: 'a', citations: null }] as never)).toBe('a');
    expect(answerText([{ type: 'text', text: 'a' }, { type: 'fallback' }] as never)).toBeNull();
    expect(answerText([{ type: 'text', text: 'a' }, { type: 'fallback' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c' }] as never)).toBe('c');
  });
});
