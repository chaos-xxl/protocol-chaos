// How a conversation ends: which failures are the model's and which the infrastructure's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError, createScriptedProvider } from '../lib/provider.mjs';
import { converse, errorCode, isInfrastructure } from '../lib/session.mjs';

const store = (call) => ({ tools: [], has: (name) => name === 'memory', call });
const failing = (error) => ({ complete: async () => { throw error; } });

test('an endpoint that kept failing, or would not take the key, is the infrastructure', async () => {
  for (const error of [
    new ProviderError('HTTP 503', { status: 503, retryable: true }),
    new ProviderError('no response within 1000 ms', { retryable: true }),
    new ProviderError('HTTP 403', { status: 403 }),
  ]) {
    assert.ok(isInfrastructure(error));
    const result = await converse({ provider: failing(error), system: 's', user: 'u', store: store() });
    assert.equal(result.infrastructure, true, error.message);
    assert.equal(result.ok, false);
  }
});

test('a request the endpoint refused as it was counts against the model', async () => {
  const error = new ProviderError('HTTP 400: the conversation is too long', { status: 400 });
  assert.equal(isInfrastructure(error), false);
  const result = await converse({ provider: failing(error), system: 's', user: 'u', store: store() });
  assert.equal(result.infrastructure, undefined);
  assert.match(result.error, /^the endpoint refused the request/);
});

test('a bug in the harness is thrown, not recorded as the model\'s', async () => {
  await assert.rejects(converse({ provider: failing(new TypeError('x is undefined')), system: 's', user: 'u', store: store() }), TypeError);
});

test('a store that throws is the infrastructure; one that answers with an error is the model\'s call', async () => {
  const provider = createScriptedProvider(({ messages }) => (messages.length === 2 ? { tool_calls: [{ name: 'memory', arguments: { action: 'add' } }] } : { content: '好' }));
  const answered = await converse({ provider, system: 's', user: 'u', store: store(async () => ({ text: '出错：add 要给 content：新条目的内容。', isError: true })) });
  assert.equal(answered.ok, true);
  assert.deepEqual(answered.calls, [{ name: 'memory', args: { action: 'add' }, error: 'add 要给 content' }]);
  const thrown = await converse({ provider, system: 's', user: 'u', store: store(async () => { throw new Error('fetch failed'); }) });
  assert.equal(thrown.infrastructure, true);
  assert.match(thrown.error, /^store: memory: fetch failed/);
});

test('error codes: a server code, or the start of a message', () => {
  assert.equal(errorCode('{"code":"VERSION_REQUIRED","message":"..."}'), 'VERSION_REQUIRED');
  assert.equal(errorCode('出错：没找到这段原文。原文要和条目里的一字不差。'), '没找到这段原文');
});
