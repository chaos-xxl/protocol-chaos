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

test('model settings are checked, and a missing key stops before any request', () => {
  assert.throws(() => checkModel({ id: 'm', endpoint: 'http://example.com/v1', model: 'x' }), /loopback/);
  assert.throws(() => checkModel({ id: 'm', endpoint: 'https://user:pw@example.com/v1', model: 'x' }), /credentials/);
  assert.throws(() => checkModel({ id: 'M M', endpoint: 'https://example.com', model: 'x' }), /id must/);
  assert.throws(() => createProvider(model(), { env: {} }), /TEST_KEY is not set/);
});
