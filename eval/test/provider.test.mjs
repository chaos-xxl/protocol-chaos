import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { checkModel, createProvider, usageOf } from '../lib/provider.mjs';

const KEY = 'sk-test-0123456789abcdef';
let server;
let url;
let queue = [];
const seen = [];
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      const next = queue.shift() ?? { status: 500, body: 'empty queue' };
      res.writeHead(next.status, { 'Content-Type': 'application/json', ...(next.headers ?? {}) });
      res.end(typeof next.body === 'string' ? next.body.replace('$AUTH', req.headers.authorization) : JSON.stringify(next.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
});
after(() => server.close());

const deepseekReply = {
  id: 'r1', model: 'deepseek-v4-pro', system_fingerprint: 'fp1',
  choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: '想一想', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'memory', arguments: '{}' } }] } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } },
};
const model = (extra = {}) => ({ id: 'm', endpoint: url, model: 'deepseek-v4-pro', apiKeyEnv: 'TEST_KEY', ...extra });
const env = { TEST_KEY: KEY };
const noWait = async () => {};

test('transient failures are retried; usage and the fields to send back are kept', async () => {
  queue = [{ status: 429, body: '{"error":"slow down"}' }, { status: 503, body: 'busy' }, { status: 200, body: deepseekReply }];
  const provider = createProvider(model({ body: { thinking: { type: 'enabled' } }, passback: ['reasoning_content'] }), { env, sleep: noWait });
  const out = await provider.complete([{ role: 'user', content: '你好' }], [{ type: 'function', function: { name: 'memory', parameters: {} } }]);
  assert.equal(out.attempts, 3);
  assert.deepEqual(out.usage, { input: 100, cached: 80, output: 20, reasoning: 12 });
  assert.equal(out.message.reasoning_content, '想一想');
  assert.equal(out.message.tool_calls[0].function.name, 'memory');
  assert.equal(out.finishReason, 'tool_calls');
  const request = seen.at(-1);
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(request.body.thinking, { type: 'enabled' });
  assert.equal(request.body.model, 'deepseek-v4-pro');
  assert.equal(request.body.tools.length, 1);
});

test('fields not listed are not sent back', async () => {
  queue = [{ status: 200, body: deepseekReply }];
  const out = await createProvider(model(), { env, sleep: noWait }).complete([{ role: 'user', content: 'x' }], []);
  assert.equal(out.message.reasoning_content, undefined);
  assert.equal(seen.at(-1).body.tools, undefined, 'no tools, no tools field');
});

test('a request the endpoint refuses is not retried, and the key never shows', async () => {
  queue = [{ status: 400, body: 'bad request from $AUTH' }, { status: 200, body: deepseekReply }];
  const provider = createProvider(model(), { env, sleep: noWait });
  await assert.rejects(provider.complete([{ role: 'user', content: 'x' }], []), (error) => {
    assert.equal(error.status, 400);
    assert.ok(!error.message.includes(KEY));
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  queue = [];
});

test('retries give up after the limit', async () => {
  queue = [{ status: 500, body: 'x' }, { status: 500, body: 'x' }, { status: 500, body: 'x' }];
  await assert.rejects(createProvider(model({ maxRetries: 2 }), { env, sleep: noWait }).complete([], []), /HTTP 500/);
});

test('usage in the shapes endpoints report it', () => {
  assert.deepEqual(usageOf({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } }), { input: 10, cached: 4, output: 2, reasoning: null });
  assert.deepEqual(usageOf({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 6 }), { input: 10, cached: 6, output: 2, reasoning: null });
  assert.deepEqual(usageOf(undefined), { input: null, cached: null, output: null, reasoning: null });
});

test('per-request headers: the conversation id, and a new request id on every attempt', async () => {
  queue = [{ status: 502, body: 'x' }, { status: 200, body: deepseekReply }];
  const provider = createProvider(model({ conversationHeader: 'X-Conversation-Id', requestIdHeader: 'X-Model-Request-Id' }), { env, sleep: noWait });
  await provider.complete([{ role: 'user', content: 'x' }], [], { conversationId: 'run/m/r1/case~1/P/s1' });
  const [a, b] = seen.slice(-2);
  assert.equal(a.headers['x-conversation-id'], 'run/m/r1/case~1/P/s1');
  assert.equal(b.headers['x-conversation-id'], 'run/m/r1/case~1/P/s1');
  assert.match(a.headers['x-model-request-id'], /^[0-9a-f-]{36}$/);
  assert.notEqual(a.headers['x-model-request-id'], b.headers['x-model-request-id']);
});

test('an Anthropic endpoint: system apart, tool results in user turns, tool use back as tool calls', async () => {
  queue = [{
    status: 200,
    body: {
      id: 'msg_1', model: 'claude-x', stop_reason: 'tool_use',
      content: [{ type: 'text', text: '我查一下。' }, { type: 'tool_use', id: 'tu_2', name: 'notes_view', input: { path: 'index.md' } }],
      usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 30 },
    },
  }];
  const provider = createProvider(model({ api: 'anthropic', model: 'claude-x', body: { max_tokens: 2000 } }), { env, sleep: noWait });
  const tools = [{ type: 'function', function: { name: 'notes_view', description: '看文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const messages = [
    { role: 'system', content: '你是助手 A。' },
    { role: 'user', content: '搬家预算多少？' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'notes_search', arguments: '{"query":"搬家"}' } }, { id: 'tu_1b', type: 'function', function: { name: 'notes_search', arguments: '{"query":"预算"}' } }] },
    { role: 'tool', tool_call_id: 'tu_1', content: '2026年11月搬家.md' },
    { role: 'tool', tool_call_id: 'tu_1b', content: '没有文件同时包含：预算。' },
  ];
  const out = await provider.complete(messages, tools);
  const { headers, body } = seen.at(-1);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(body.max_tokens, 2000);
  assert.deepEqual(body.system, [{ type: 'text', text: '你是助手 A。', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.tools, [{ name: 'notes_view', description: '看文件', input_schema: tools[0].function.parameters }]);
  assert.deepEqual(body.messages.map((m) => [m.role, m.content.map((c) => c.type)]), [
    ['user', ['text']], ['assistant', ['tool_use', 'tool_use']], ['user', ['tool_result', 'tool_result']],
  ]);
  assert.deepEqual(body.messages[1].content[0], { type: 'tool_use', id: 'tu_1', name: 'notes_search', input: { query: '搬家' } });
  assert.deepEqual(body.messages[2].content.at(-1).cache_control, { type: 'ephemeral' }, 'the newest turn is a cache breakpoint');
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(out.message.content, '我查一下。');
  assert.deepEqual(out.message.tool_calls, [{ id: 'tu_2', type: 'function', function: { name: 'notes_view', arguments: '{"path":"index.md"}' } }]);
  assert.deepEqual(out.usage, { input: 1000, cached: 900, output: 30, reasoning: null });
});

test('a Responses endpoint: instructions apart, earlier output items sent back as they came, nothing stored', async () => {
  const output = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'memory', arguments: '{"action":"add","content":"x"}', status: 'completed' },
  ];
  queue = [{ status: 200, body: { id: 'resp_1', model: 'gpt-x', status: 'completed', output, usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 6 } } } }];
  const provider = createProvider(model({ api: 'responses', model: 'gpt-x' }), { env, sleep: noWait });
  const tools = [{ type: 'function', function: { name: 'memory', description: '改记忆', parameters: { type: 'object', properties: { action: { type: 'string' } } } } }];
  const first = await provider.complete([{ role: 'system', content: '你是助手 B。' }, { role: 'user', content: '记一下。' }], tools);
  let { body } = seen.at(-1);
  assert.equal(body.instructions, '你是助手 B。');
  assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: '记一下。' }] }]);
  assert.deepEqual(body.tools, [{ type: 'function', name: 'memory', description: '改记忆', parameters: tools[0].function.parameters, strict: false }]);
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal(first.finishReason, 'tool_calls');
  assert.deepEqual(first.message.tool_calls, [{ id: 'call_9', type: 'function', function: { name: 'memory', arguments: '{"action":"add","content":"x"}' } }]);
  assert.deepEqual(first.usage, { input: 50, cached: 20, output: 9, reasoning: 6 });
  queue = [{ status: 200, body: { id: 'resp_2', model: 'gpt-x', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '记下了。' }] }], usage: { input_tokens: 80, output_tokens: 4 } } }];
  const second = await provider.complete([
    { role: 'system', content: '你是助手 B。' }, { role: 'user', content: '记一下。' }, first.message,
    { role: 'tool', tool_call_id: 'call_9', content: '已新增一条。' },
  ], tools);
  ({ body } = seen.at(-1));
  assert.deepEqual(body.input.slice(1), [...output, { type: 'function_call_output', call_id: 'call_9', output: '已新增一条。' }]);
  assert.equal(second.message.content, '记下了。');
  assert.equal(second.finishReason, 'stop');
});

test('model settings are checked, and a missing key stops before any request', () => {
  assert.throws(() => checkModel({ id: 'm', endpoint: 'http://example.com/v1', model: 'x' }), /loopback/);
  assert.throws(() => checkModel({ id: 'm', endpoint: 'https://user:pw@example.com/v1', model: 'x' }), /credentials/);
  assert.throws(() => checkModel({ id: 'M M', endpoint: 'https://example.com', model: 'x' }), /id must/);
  assert.throws(() => createProvider(model(), { env: {} }), /TEST_KEY is not set/);
});
