// What the conformance tests cannot see: the repository survives a restart, several
// processes share one file without losing each other's writes, and a damaged file is
// reported and left alone.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../index.mjs', import.meta.url));
const directories = [];
after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function freshDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'protocol-chaos-store-'));
  directories.push(directory);
  return directory;
}

async function start(directory, ...flags) {
  const client = new Client({ name: 'store-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, '--data', directory, ...flags], stderr: 'ignore' }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const body = JSON.parse(result.content[0].text);
    if (result.isError) throw Object.assign(new Error(`${name}: ${body.code}: ${body.message}`), { code: body.code });
    return body;
  };
  return { client, call, close: () => client.close() };
}

const actor = { kind: 'agent', id: 'store-test' };
const note = (server, text, more = {}) => server.call('event_note', { actor, accountSource: 'user', text, ...more });
const directory = async (server) => (await server.call('context_pack', {})).events;

test('the repository survives a restart', async () => {
  const data = freshDirectory();
  const first = await start(data);
  const receipt = await note(first, 'I want to learn the cello this winter', { title: 'Learn the cello, winter 2026' });
  await first.close();
  const second = await start(data);
  try {
    const { event, accounts } = await second.call('event_get_protocol', { eventId: receipt.eventId });
    assert.equal(event.title, 'Learn the cello, winter 2026');
    assert.deepEqual(accounts.map((account) => account.text), ['I want to learn the cello this winter']);
    assert.equal(JSON.parse(readFileSync(join(data, 'repository.json'), 'utf8')).schemaVersion, '0.3.0', 'the file is an export (§8.6)');
  } finally {
    await second.close();
  }
});

test('two processes writing at once lose nothing', async () => {
  const data = freshDirectory();
  const a = await start(data);
  const b = await start(data);
  try {
    const writes = Array.from({ length: 30 }, (_, n) => note(n % 2 ? a : b, `parallel words ${n}`));
    const receipts = await Promise.all(writes);
    assert.equal(new Set(receipts.map((receipt) => receipt.eventId)).size, 30, 'thirty different Events');
    for (const server of [a, b]) assert.equal((await directory(server)).length, 30, 'each process sees every Event');
    const shared = await note(a, 'words on one Event from two processes');
    await Promise.all(Array.from({ length: 10 }, (_, n) => note(n % 2 ? a : b, `more words ${n}`, { eventId: shared.eventId })));
    const { accounts } = await b.call('event_get_protocol', { eventId: shared.eventId, accounts: 'all' });
    assert.equal(accounts.length, 11, 'every word on the shared Event is kept');
  } finally {
    await a.close();
    await b.close();
  }
});

test('a stale version from another process is refused', async () => {
  const data = freshDirectory();
  const a = await start(data);
  const b = await start(data);
  try {
    const created = await note(a, 'Repaint the kitchen in spring');
    await b.call('event_record_expression', { eventId: created.eventId, actor, accountSource: 'user', text: 'Make it green', expectedVersion: created.version, set: { facts: { plan: 'Green walls.' } } });
    await assert.rejects(
      a.call('event_record_expression', { eventId: created.eventId, actor, accountSource: 'user', text: 'Make it blue', expectedVersion: created.version, set: { facts: { plan: 'Blue walls.' } } }),
      (error) => error.code === 'VERSION_CONFLICT',
    );
    assert.equal((await a.call('event_get_protocol', { eventId: created.eventId })).event.facts.plan, 'Green walls.');
  } finally {
    await a.close();
    await b.close();
  }
});

test('a damaged file is reported and left as it is', async () => {
  const data = freshDirectory();
  const file = join(data, 'repository.json');
  writeFileSync(file, '{ this is not an export');
  const server = await start(data);
  try {
    await assert.rejects(directory(server), (error) => error.code === 'INTERNAL_ERROR');
    await assert.rejects(note(server, 'words that must not overwrite the file'), (error) => error.code === 'INTERNAL_ERROR');
    assert.equal(readFileSync(file, 'utf8'), '{ this is not an export');
  } finally {
    await server.close();
  }
});

test('export and import are offered only with --owner-tools', async () => {
  const plain = await start(freshDirectory());
  const owner = await start(freshDirectory(), '--owner-tools');
  try {
    const names = async (server) => (await server.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!(await names(plain)).includes('repository_export'));
    assert.ok((await names(owner)).includes('repository_export'));
    const instructions = plain.client.getInstructions() ?? '';
    assert.ok(instructions.length > 0 && instructions.length < 2000, `instructions are ${instructions.length} characters`);
  } finally {
    await plain.close();
    await owner.close();
  }
});
