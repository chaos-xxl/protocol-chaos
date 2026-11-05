// One conversation: the system prompt and one user message, then the model's turns. Each tool
// call is run against the arm's store and its result sent back, until the model answers
// without calling a tool. A failure ends the conversation and is recorded, never retried here.

/**
 * @param {object} o
 * @param {{complete: Function}} o.provider
 * @param {string} o.system
 * @param {string} o.user
 * @param {{tools: object[], has: Function, call: Function}} o.store the arm's store, open for this conversation
 * @param {number} [o.maxModelCalls]
 * @returns {Promise<{ok: boolean, reply?: string, error?: string, messages: object[], requests: object[], toolCalls: number, toolErrors: number}>}
 */
export async function converse({ provider, system, user, store, maxModelCalls = 25 }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const requests = [];
  let toolCalls = 0;
  let toolErrors = 0;
  const end = (fields) => ({ messages, requests, toolCalls, toolErrors, ...fields });
  for (let step = 0; step < maxModelCalls; step += 1) {
    let response;
    try {
      response = await provider.complete(messages, store.tools);
    } catch (error) {
      return end({ ok: false, error: `model: ${error.message}` });
    }
    const { message } = response;
    requests.push({
      usage: response.usage, reasoningChars: response.reasoningChars, finishReason: response.finishReason, model: response.model,
      fingerprint: response.fingerprint, latencyMs: response.latencyMs, attempts: response.attempts,
    });
    messages.push(message);
    if (response.finishReason === 'length') return end({ ok: false, error: 'the reply was cut off (finish_reason "length")' });
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      if (typeof message.content !== 'string' || !message.content.trim()) return end({ ok: false, error: 'an empty reply' });
      return end({ ok: true, reply: message.content });
    }
    for (const call of calls) {
      toolCalls += 1;
      const name = call.function?.name;
      let result;
      let args;
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
      } catch {
        result = { text: '出错：参数不是一个合法的 JSON 对象。', isError: true };
      }
      if (!result) {
        if (!store.has(name)) {
          result = { text: `出错：没有 ${name} 这个工具。`, isError: true };
        } else {
          try {
            result = await store.call(name, args);
          } catch (error) {
            result = { text: `出错：工具没能执行（${error.message}）。`, isError: true };
          }
        }
      }
      if (result.isError) toolErrors += 1;
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
