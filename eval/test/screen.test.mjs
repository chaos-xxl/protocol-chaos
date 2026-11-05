import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { material } from '../lib/material.mjs';
import { rehearsalProvider } from '../lib/rehearsal.mjs';
import { modelFromGateway, renderScreen, screen } from '../lib/screen.mjs';

const out = mkdtempSync(join(tmpdir(), 'protocol-chaos-screen-test-'));
after(() => rmSync(out, { recursive: true, force: true }));

const gateway = {
  openaiEndpoint: 'https://gateway.example/v1/chat/completions',
  anthropicEndpoint: 'https://gateway.example/anthropic/v1/messages',
  anthropicPattern: 'claude',
  apiKeyEnv: 'GATEWAY_KEY',
  conversationHeader: 'X-Conversation-Id',
  models: { 'vendor/thinker': { body: { thinking: { type: 'enabled' } }, passback: ['reasoning_content'] } },
};

test('a gateway name becomes a model: the protocol by name, settings per model', () => {
  const claude = modelFromGateway(gateway, 'reseller/pa/claude-sonnet-4-6');
  assert.equal(claude.id, 'reseller-pa-claude-sonnet-4-6');
  assert.equal(claude.api, 'anthropic');
  assert.equal(claude.endpoint, gateway.anthropicEndpoint);
  const thinker = modelFromGateway(gateway, 'vendor/thinker');
  assert.deepEqual([thinker.api, thinker.body, thinker.passback], ['openai', { thinking: { type: 'enabled' } }, ['reasoning_content']]);
  assert.equal(thinker.conversationHeader, 'X-Conversation-Id');
});

test('the screen runs four conversations per model and says whether it can take part', async () => {
  const { cases, library } = material();
  const model = { id: 'rehearsal', model: 'rehearsal' };
  const [record] = await screen([model], { library, cases, out, providers: { rehearsal: rehearsalProvider() } });
  assert.deepEqual(Object.keys(record.conversations), ['P1', 'P2', 'T2', 'Q']);
  assert.deepEqual(record.verdict, { recordsAndOrganizes: true, writesFiles: true, answersInFormat: true, reportsUsage: true, reportsCache: false });
  assert.equal(record.conversations.Q.outcome, 'unknown');
  assert.equal(readdirSync(join(out, 'conversations', 'rehearsal')).length, 4);
  assert.match(renderScreen([record]), /\| rehearsal \| yes \| yes \| yes \(unknown\) \| yes \| no \|/);
});
