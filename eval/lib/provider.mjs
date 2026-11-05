// The model behind assistants A, B and C: any OpenAI-compatible Chat Completions endpoint
// with tool calling. Each model in the run's list (eval/models.example.json) names its
// endpoint, the environment variable holding its key, the model name, extra request fields,
// and which fields of an assistant message must be sent back on later requests. Transient
// failures are retried with backoff; the key never reaches anything written to disk.
import { pause, redact } from './util.mjs';

export class ProviderError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const first = (...values) => values.find((v) => Number.isInteger(v));

/** Token usage in one shape; a count the endpoint did not report is null. */
export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return { input: null, cached: null, output: null, reasoning: null };
  return {
    input: first(usage.prompt_tokens, usage.input_tokens) ?? null,
    cached: first(usage.prompt_tokens_details?.cached_tokens, usage.prompt_cache_hit_tokens, usage.cache_read_input_tokens,
      usage.input_tokens_details?.cached_tokens) ?? null,
    output: first(usage.completion_tokens, usage.output_tokens) ?? null,
    reasoning: first(usage.completion_tokens_details?.reasoning_tokens, usage.output_tokens_details?.reasoning_tokens) ?? null,
  };
}

/** The settings of one model, checked. */
export function checkModel(model) {
  const problems = [];
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(model?.id ?? '')) problems.push('id must be lowercase letters, digits, dots, hyphens or underscores');
  if (typeof model?.endpoint !== 'string' || !/^https?:\/\//.test(model.endpoint)) problems.push('endpoint must be an http(s) URL');
  else {
    const url = new URL(model.endpoint);
    if (url.username || url.password) problems.push('endpoint must not hold credentials; use apiKeyEnv');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) problems.push('plain http only on a loopback address');
  }
  if (typeof model?.model !== 'string' || !model.model) problems.push('model must name the model');
  if (model?.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(model.apiKeyEnv)) problems.push('apiKeyEnv must be an environment variable name');
  if (problems.length) throw new Error(`model ${model?.id ?? '?'}: ${problems.join('; ')}`);
  return model;
}

/**
 * A client for one model: complete(messages, tools) resolves with
 * {message, finishReason, usage, model, id, fingerprint, latencyMs, attempts}.
 */
export function createProvider(model, { env = process.env, fetchImpl = fetch, sleep = pause } = {}) {
  checkModel(model);
  const key = model.apiKeyEnv ? env[model.apiKeyEnv] : undefined;
  if (model.apiKeyEnv && !key) throw new Error(`model ${model.id}: the environment variable ${model.apiKeyEnv} is not set`);
  const secrets = [key];
  const headers = { 'Content-Type': 'application/json', ...(model.headers ?? {}) };
  if (key) headers[model.authHeader ?? 'Authorization'] = model.authScheme === '' ? key : `${model.authScheme ?? 'Bearer'} ${key}`;
  const maxAttempts = 1 + (model.maxRetries ?? 8);
  const timeoutMs = model.timeoutMs ?? 300_000;
  const passback = model.passback ?? [];

  async function complete(messages, tools) {
    const body = JSON.stringify({ model: model.model, messages, ...(tools.length ? { tools } : {}), ...(model.body ?? {}) });
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      let status;
      let retryAfter;
      let problem;
      try {
        const response = await fetchImpl(model.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        status = response.status;
        retryAfter = Number(response.headers.get?.('retry-after'));
        const text = await response.text();
        if (response.ok) {
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw new ProviderError(`model ${model.id}: the response is not JSON`, { status, retryable: true });
          }
          const choice = data?.choices?.[0];
          if (!choice?.message) throw new ProviderError(`model ${model.id}: the response holds no message`, { status, retryable: true });
          const message = { role: 'assistant', content: choice.message.content ?? null };
          if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length) message.tool_calls = choice.message.tool_calls;
          for (const field of passback) if (choice.message[field] !== undefined) message[field] = choice.message[field];
          return {
            message,
            finishReason: choice.finish_reason ?? null,
            usage: usageOf(data.usage),
            reasoningChars: typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content.length : null,
            model: data.model ?? null,
            id: data.id ?? null,
            fingerprint: data.system_fingerprint ?? null,
            latencyMs: Date.now() - started,
            attempts: attempt,
          };
        }
        problem = new ProviderError(`model ${model.id}: HTTP ${status}: ${redact(text, secrets).slice(0, 300)}`, { status, retryable: RETRYABLE.has(status) });
      } catch (error) {
        problem = error instanceof ProviderError ? error
          : new ProviderError(`model ${model.id}: ${redact(error.name === 'TimeoutError' ? `no response within ${timeoutMs} ms` : error.message, secrets)}`, { retryable: true });
      }
      if (!problem.retryable || attempt >= maxAttempts) throw problem;
      const backoff = Math.min(60_000, 2000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(120_000, retryAfter * 1000) : backoff);
    }
  }

  return { id: model.id, model: model.model, concurrency: model.concurrency ?? 4, complete };
}

/**
 * A provider that plays the model from a function, for tests and dry runs:
 * respond({messages, tools}) returns {content, tool_calls?} (tool call arguments as objects or strings).
 */
export function createScriptedProvider(respond, { id = 'scripted' } = {}) {
  let calls = 0;
  return {
    id,
    model: id,
    concurrency: 4,
    async complete(messages, tools) {
      calls += 1;
      const out = await respond({ messages, tools });
      const message = { role: 'assistant', content: out.content ?? null };
      if (out.tool_calls?.length) {
        message.tool_calls = out.tool_calls.map((call, index) => ({
          id: call.id ?? `call_${calls}_${index}`,
          type: 'function',
          function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) },
        }));
      }
      const input = Math.ceil(JSON.stringify(messages).length / 3);
      return {
        message,
        finishReason: out.finishReason ?? (message.tool_calls ? 'tool_calls' : 'stop'),
        usage: { input, cached: 0, output: Math.ceil((out.content ?? '').length / 3) + 1, reasoning: null },
        reasoningChars: null,
        model: id,
        id: `scripted-${calls}`,
        fingerprint: null,
        latencyMs: 0,
        attempts: 1,
      };
    },
  };
}
