// One conversation: the system prompt and one user message, then the model's turns. Each tool
// call is run against the arm's store and its result sent back, until the model answers
// without calling a tool. A failure ends the conversation and is recorded, never retried here.
//
// Failures are of two kinds. The model's: no answer within the call limit, a reply cut off, an
// empty reply, a request the endpoint refused as it was (a conversation too long for the
// model, content it would not take). These count as failed, in whichever arm they happen. The
// infrastructure's: an endpoint that kept failing after its retries (no response, rate limits,
// server errors), a key or a model name it would not accept, a store that threw instead of
// answering (a reference server that stopped). These are marked `infrastructure`: the case run
// is repeated, and left out of the analysis if it keeps failing. Any other error is a bug of
// the harness and is thrown.
import { ProviderError } from './provider.mjs';

/** Statuses that say the endpoint, not the request, is the problem: a key, a network, a model name. */
const INFRASTRUCTURE_STATUSES = new Set([401, 403, 404, 407]);

/** Whether a provider error is the infrastructure's (see above). */
export const isInfrastructure = (error) => Boolean(error.retryable) || INFRASTRUCTURE_STATUSES.has(error.status);

/** The first words of a tool's error, for counting: the code of a server error, the start of a message otherwise. */
export function errorCode(text) {
  try {
    const body = JSON.parse(text);
    if (body && typeof body.code === 'string') return body.code;
  } catch {
    // not JSON
  }
  return String(text).replace(/^出错：/u, '').split(/[。，；：:,(（\n]/u)[0].trim().slice(0, 40);
}

/**
 * @param {object} o
 * @param {{complete: Function}} o.provider
 * @param {string} o.system
 * @param {string} o.user
 * @param {{tools: object[], has: Function, call: Function}} o.store the arm's store, open for this conversation
 * @param {number} [o.maxModelCalls]
 * @param {string} [o.conversationId] passed to the gateway, which may use it to route the conversation to its cache
 * @returns {Promise<{ok: boolean, reply?: string, error?: string, infrastructure?: boolean, messages: object[], requests: object[],
 *   calls: {name: string, args: object|null, error: string|null}[], toolCalls: number, toolErrors: number}>}
 */
export async function converse({ provider, system, user, store, maxModelCalls = 25, conversationId }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const requests = [];
  const calls = [];
  let toolCalls = 0;
  let toolErrors = 0;
  const end = (fields) => ({ messages, requests, calls, toolCalls, toolErrors, ...fields });
  for (let step = 0; step < maxModelCalls; step += 1) {
    let response;
    try {
      response = await provider.complete(messages, store.tools, { conversationId });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (isInfrastructure(error)) return end({ ok: false, error: `model: ${error.message}`, infrastructure: true });
      return end({ ok: false, error: `the endpoint refused the request: ${error.message}` });
    }
    const { message } = response;
    requests.push({
      usage: response.usage, reasoningChars: response.reasoningChars, finishReason: response.finishReason, model: response.model,
      fingerprint: response.fingerprint, latencyMs: response.latencyMs, attempts: response.attempts,
    });
    messages.push(message);
    if (response.finishReason === 'length') return end({ ok: false, error: 'the reply was cut off (finish_reason "length")' });
    const toolCallsHere = message.tool_calls ?? [];
    if (toolCallsHere.length === 0) {
      if (typeof message.content !== 'string' || !message.content.trim()) return end({ ok: false, error: 'an empty reply' });
      return end({ ok: true, reply: message.content });
    }
    for (const call of toolCallsHere) {
      toolCalls += 1;
      const name = call.function?.name;
      let result;
      let args = null;
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
      } catch {
        args = null;
        result = { text: '出错：参数不是一个合法的 JSON 对象。', isError: true };
      }
      if (!result) {
        if (!store.has(name)) {
          result = { text: `出错：没有 ${name} 这个工具。`, isError: true };
        } else {
          try {
            result = await store.call(name, args);
          } catch (error) {
            // A store answers every call, its errors included; one that throws has failed.
            calls.push({ name, args, error: 'store failed' });
            return end({ ok: false, error: `store: ${name}: ${error.message}`, infrastructure: true });
          }
        }
      }
      if (result.isError) toolErrors += 1;
      calls.push({ name, args, error: result.isError ? errorCode(result.text) : null });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
  }
  return end({ ok: false, error: `no answer within ${maxModelCalls} model calls` });
}

/** Token counts of a conversation; null when any request did not report that count. */
export function totals(requests) {
  const sum = (field) => (requests.every((r) => Number.isInteger(r.usage?.[field])) ? requests.reduce((n, r) => n + r.usage[field], 0) : null);
  return {
    requests: requests.length,
    input: sum('input'),
    cached: sum('cached'),
    output: sum('output'),
    reasoning: sum('reasoning'),
    latencyMs: requests.reduce((n, r) => n + (r.latencyMs ?? 0), 0),
    retries: requests.reduce((n, r) => n + Math.max(0, (r.attempts ?? 1) - 1), 0),
  };
}
