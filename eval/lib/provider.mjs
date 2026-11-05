// The model behind assistants A, B and C, reached through an OpenAI-compatible Chat
// Completions endpoint with tool calling, or through an Anthropic Messages endpoint (some
// gateways serve Claude only that way). Each model in the run's list
// (eval/models.example.json) names its endpoint, the environment variable holding its key,
// the model name, extra request fields, which fields of an assistant message must be sent
// back on later requests, and optional per-request headers a gateway uses (a conversation
// id for its cache, a request id for its logs). Transient failures are retried with backoff;
// the key never reaches anything written to disk.
import { randomUUID } from 'node:crypto';
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
  if (model?.api !== undefined && !['openai', 'anthropic'].includes(model.api)) problems.push('api must be "openai" or "anthropic"');
  if (model?.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(model.apiKeyEnv)) problems.push('apiKeyEnv must be an environment variable name');
  for (const field of ['conversationHeader', 'requestIdHeader']) {
    if (model?.[field] !== undefined && !/^[A-Za-z0-9-]+$/.test(model[field])) problems.push(`${field} must be a header name`);
  }
  if (problems.length) throw new Error(`model ${model?.id ?? '?'}: ${problems.join('; ')}`);
  return model;
}

// ---- OpenAI Chat Completions ----

const openai = {
  body(model, messages, tools) {
    return { model: model.model, messages, ...(tools.length ? { tools } : {}), ...(model.body ?? {}) };
  },
  parse(model, data) {
    const choice = data?.choices?.[0];
    if (!choice?.message) return undefined;
    const message = { role: 'assistant', content: choice.message.content ?? null };
    if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length) message.tool_calls = choice.message.tool_calls;
    for (const field of model.passback ?? []) if (choice.message[field] !== undefined) message[field] = choice.message[field];
    return {
      message,
      finishReason: choice.finish_reason ?? null,
      usage: usageOf(data.usage),
      reasoningChars: typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content.length : null,
      model: data.model ?? null,
      id: data.id ?? null,
      fingerprint: data.system_fingerprint ?? null,
    };
  },
};

// ---- Anthropic Messages ----

const parseArguments = (text) => {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};
const STOP = { tool_use: 'tool_calls', end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', pause_turn: 'stop', refusal: 'stop' };

/** Chat Completions messages as Anthropic Messages: system apart, tool results inside user turns. */
export function toAnthropic(messages, { cache = true } = {}) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    else if (m.role === 'assistant') {
      if (Array.isArray(m.anthropic_content)) {
        out.push({ role: 'assistant', content: m.anthropic_content });
        continue;
      }
      const blocks = [];
      if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.tool_calls ?? []) blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '…' }] });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      const last = out.at(-1);
      if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  if (cache && out.length) {
    const lastBlock = out.at(-1).content.at(-1);
    out.at(-1).content[out.at(-1).content.length - 1] = { ...lastBlock, cache_control: { type: 'ephemeral' } };
  }
  return {
    system: system ? [{ type: 'text', text: system, ...(cache ? { cache_control: { type: 'ephemeral' } } : {}) }] : undefined,
    messages: out,
  };
}

const anthropic = {
  body(model, messages, tools) {
    const { system, messages: converted } = toAnthropic(messages, { cache: model.cache !== false });
    return {
      model: model.model,
      max_tokens: 8192,
      ...(system ? { system } : {}),
      messages: converted,
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: 'object' } })) } : {}),
      ...(model.body ?? {}),
    };
  },
  parse(model, data) {
    if (!Array.isArray(data?.content)) return undefined;
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const calls = data.content.filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    const message = { role: 'assistant', content: text || null };
    if (calls.length) message.tool_calls = calls;
    const thinking = data.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
    if (thinking.length && (model.passback ?? []).includes('thinking')) message.anthropic_content = data.content;
    const u = data.usage ?? {};
    const read = Number.isInteger(u.cache_read_input_tokens) ? u.cache_read_input_tokens : null;
    const created = Number.isInteger(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0;
    return {
      message,
      finishReason: STOP[data.stop_reason] ?? data.stop_reason ?? null,
      usage: {
        input: Number.isInteger(u.input_tokens) ? u.input_tokens + (read ?? 0) + created : null,
        cached: read,
        output: Number.isInteger(u.output_tokens) ? u.output_tokens : null,
        reasoning: null,
      },
      reasoningChars: thinking.length ? thinking.reduce((n, b) => n + (b.thinking?.length ?? 0), 0) : null,
      model: data.model ?? null,
      id: data.id ?? null,
      fingerprint: null,
    };
  },
};

const WIRES = { openai, anthropic };

/**
 * A client for one model: complete(messages, tools, {conversationId}) resolves with
 * {message, finishReason, usage, model, id, fingerprint, latencyMs, attempts}.
 */
export function createProvider(model, { env = process.env, fetchImpl = fetch, sleep = pause } = {}) {
  checkModel(model);
  const wire = WIRES[model.api ?? 'openai'];
  const key = model.apiKeyEnv ? env[model.apiKeyEnv] : undefined;
  if (model.apiKeyEnv && !key) throw new Error(`model ${model.id}: the environment variable ${model.apiKeyEnv} is not set`);
  const secrets = [key];
  const base = { 'Content-Type': 'application/json', ...(model.api === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}), ...(model.headers ?? {}) };
  if (key) base[model.authHeader ?? 'Authorization'] = model.authScheme === '' ? key : `${model.authScheme ?? 'Bearer'} ${key}`;
  const maxAttempts = 1 + (model.maxRetries ?? 8);
  const timeoutMs = model.timeoutMs ?? 300_000;

  async function complete(messages, tools, { conversationId } = {}) {
    const body = JSON.stringify(wire.body(model, messages, tools));
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      const headers = { ...base };
      if (model.conversationHeader && conversationId) headers[model.conversationHeader] = conversationId;
      if (model.requestIdHeader) headers[model.requestIdHeader] = randomUUID();
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
          const parsed = wire.parse(model, data);
          if (!parsed) throw new ProviderError(`model ${model.id}: the response holds no message: ${redact(text, secrets).slice(0, 200)}`, { status, retryable: true });
          return { ...parsed, latencyMs: Date.now() - started, attempts: attempt };
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

/** The models a gateway lists at GET <base>/models, as ids. Tries a bearer token, then an api-key header. */
export async function listModels({ base, key, fetchImpl = fetch }) {
  const url = `${base.replace(/\/+$/, '')}/models`;
  let last;
  for (const headers of [{ Authorization: `Bearer ${key}` }, { 'api-key': key }]) {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    const text = await response.text();
    if (response.ok) {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      return list.map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => typeof m.id === 'string');
    }
    last = `HTTP ${response.status}: ${redact(text, [key]).slice(0, 200)}`;
  }
  throw new Error(`could not list the models at ${url}: ${last}`);
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
