// Organizing in the background, with a stand-in for the organizer's agent: words an assistant
// records are folded into their matter by a detached process, grounded on those words; the
// organizer's own runs cannot start it again; the sweep folds what nobody folded and calls no
// model when nothing changed; and the log never holds the words.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { askModel, foldInput, foldPatch, jsonObject, runSweep } from '../organize.mjs';

const SERVER = fileURLToPath(new URL('../index.mjs', import.meta.url));
const folders = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

// A stand-in for \`dsh --profile headless --json\`: logs its arguments, its overlay, its input and
// one variable, and answers with the JSON in answer.json next to it, as DeepSeek Harness's event
// stream. With a file named tool next to it, the run also calls a tool.
const FAKE_AGENT = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const here = __dirname;
  const args = process.argv.slice(2);
  const overlay = readFileSync(args[args.indexOf('--patch') + 1], 'utf8');
  appendFileSync(join(here, 'calls.jsonl'), JSON.stringify({ args, overlay, input, organizing: process.env.PROTOCOL_CHAOS_ORGANIZING }) + '\\n');
  const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  say({ type: 'session', sessionId: 'session-1', cwd: process.cwd() });
  if (existsSync(join(here, 'tool'))) say({ type: 'tool_call', name: 'bash', arguments: {} });
  say({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 1200, outputTokens: 50, cacheReadTokens: 0 } });
  say({ type: 'final', sessionId: 'session-1', reason: { kind: 'completed' }, text: 'Here is the answer:\\n' + readFileSync(join(here, 'answer.json'), 'utf8') });
});
`;

function setup(answer) {
  const folder = mkdtempSync(join(tmpdir(), 'protocol-chaos-organize-'));
  folders.push(folder);
  const data = join(folder, 'data');
  const bin = join(folder, 'bin');
  mkdirSync(data, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'dsh'), FAKE_AGENT);
  chmodSync(join(bin, 'dsh'), 0o755);
  writeFileSync(join(bin, 'answer.json'), JSON.stringify(answer));
  const config = { agent: 'dsh', command: join(bin, 'dsh'), actor: 'organizer', enabled: true, settleMs: 100 };
  return { folder, data, bin, config, calls: () => (existsSync(join(bin, 'calls.jsonl')) ? readFileSync(join(bin, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []) };
}

const enable = ({ data, config }) => writeFileSync(join(data, 'organizer.json'), JSON.stringify(config));

async function connect(data, client) {
  const mcp = new Client({ name: 'organize-test', version: '0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, '--data', data, '--client', client], stderr: 'ignore' }));
  const call = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    const body = JSON.parse(result.content[0].text);
    if (result.isError) throw Object.assign(new Error(`${name}: ${body.code}: ${body.message}`), { code: body.code });
    return body;
  };
  return { call, close: () => mcp.close() };
}

async function until(check, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 100));
  }
}

// A stand-in that writes its answer in two pieces, the first ending inside the bytes of a character.
const SPLIT_AGENT = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const line = JSON.stringify({ type: 'final', reason: { kind: 'completed' }, text: '{"change": true, "title": "学做陶艺（周末有空为前提）"}' }) + '\\n';
  const bytes = Buffer.from(line, 'utf8');
  const cut = bytes.indexOf(Buffer.from('提', 'utf8')) + 1;
  process.stdout.write(bytes.subarray(0, cut), () => setTimeout(() => process.stdout.write(bytes.subarray(cut)), 100));
});
`;

test('an answer whose characters arrive split across two chunks is read whole', async () => {
  const world = setup({});
  writeFileSync(join(world.bin, 'dsh'), SPLIT_AGENT);
  chmodSync(join(world.bin, 'dsh'), 0o755);
  const reply = await askModel(world.data, world.config, 'rules', 'input');
  assert.equal(reply.error, undefined, reply.error);
  assert.equal(jsonObject(reply.text).title, '学做陶艺（周末有空为前提）');
});

const WORDS = 'I want to repaint the hallway grey before Christmas, my sister will help';

test('recorded words are folded into their matter in the background, grounded on them', async () => {
  const world = setup({ change: true, plan: 'Grey walls before Christmas 2026.', involves: ['my sister', 'me'], progress: null });
  enable(world);
  const codex = await connect(world.data, 'codex');
  try {
    const receipt = await codex.call('event_note', { actor: { kind: 'agent', id: 'codex' }, text: WORDS, title: 'Repaint the hallway, 2026' });
    const read = async () => (await codex.call('event_get_protocol', { eventId: receipt.eventId })).event;
    const event = await until(async () => { const doc = await read(); return doc.facts?.plan ? doc : undefined; });
    assert.equal(event.facts.plan, 'Grey walls before Christmas 2026.');
    assert.deepEqual(event.refs, [{ criteria: 'my sister' }], 'the user is never a ref');
    const { revisions } = await codex.call('event_get_revisions', { eventId: receipt.eventId });
    const folded = revisions.filter((revision) => revision.type === 'field.changed' && revision.actor.id === 'organizer');
    assert.ok(folded.length >= 1 && folded.every((revision) => revision.sourceAccountIds.includes(receipt.accountId)), 'grounded on the words');
    assert.ok(revisions.some((revision) => revision.type === 'field.changed' && revision.actor.id === 'codex'), 'the title is the note\'s own');
  } finally {
    await codex.close();
  }
  const [call] = world.calls();
  assert.deepEqual(call.args.slice(0, 2), ['--profile', 'headless']);
  for (const [flag, value] of [['--permission-mode', 'read-only'], ['--approval-policy', 'never']]) assert.equal(call.args[call.args.indexOf(flag) + 1], value);
  assert.ok(call.args.includes('--json'));
  assert.match(call.overlay, /- id: credentials\n {2}disabled: false/, 'the keys saved in the app are used');
  for (const id of ['tool-bash', 'tool-fs', 'tool-web', 'session-title-llm', 'session-log-deepseek', 'session-persistence-jsonl']) assert.match(call.overlay, new RegExp(`- id: ${id}\\n {2}disabled: true`));
  assert.match(call.overlay, /model: 'deepseek-flash'\n {4}reasoningEffort: 'off'/);
  assert.ok(call.input.includes(WORDS) && call.input.includes('The matter now:') && call.input.includes('Answer with one JSON object'));
  assert.equal(call.organizing, '1', 'whatever the organizer\'s agent starts knows it is the organizer');
  const log = readFileSync(join(world.data, 'organizer', 'log.jsonl'), 'utf8');
  assert.match(log, /"outcome":"changed"/);
  assert.match(log, /"usage":\{"input":1200,"output":50,"cached":0\}/, 'the tokens of the run are logged');
  assert.ok(!log.includes('hallway') && !log.includes('sister'), 'the log holds ids and outcomes, not words');
});

test('without an organizer nothing is queued; the organizer\'s own notes are not organized again', async () => {
  const world = setup({ change: true, plan: 'Anything.' });
  const codex = await connect(world.data, 'codex');
  try {
    await codex.call('event_note', { actor: { kind: 'agent', id: 'codex' }, text: 'Words with no organizer set up', title: 'No organizer, 2026' });
  } finally {
    await codex.close();
  }
  enable(world);
  const organizer = await connect(world.data, 'organizer');
  try {
    await organizer.call('event_note', { actor: { kind: 'agent', id: 'organizer' }, text: 'The organizer splitting a part out', title: 'A part, 2026' });
  } finally {
    await organizer.close();
  }
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal(world.calls().length, 0);
  assert.ok(!existsSync(join(world.data, 'organizer', 'queue')) || !readFileSync(join(world.data, 'organizer', 'log.jsonl'), { flag: 'a+' }).length);
});

test('the sweep folds the words nobody folded, and with nothing new it calls no model', async () => {
  const world = setup({ change: true, progress: 'Booked the painter for December.' });
  const codex = await connect(world.data, 'codex');
  let receipt;
  try {
    receipt = await codex.call('event_note', { actor: { kind: 'agent', id: 'codex' }, text: 'The painter comes in December', title: 'Repaint the hallway, 2026' });
  } finally {
    await codex.close();
  }
  enable(world);
  mkdirSync(join(world.data, 'organizer'), { recursive: true });
  writeFileSync(join(world.data, 'organizer', 'state.json'), JSON.stringify({ sweepCheckpoint: '2000-01-01T00:00:00.000Z', done: {} }));
  await runSweep(world.data);
  assert.equal(world.calls().length, 1);
  const repository = JSON.parse(readFileSync(join(world.data, 'repository.json'), 'utf8'));
  const event = repository.events.find((item) => item.event.id === receipt.eventId).event;
  assert.equal(event.progress.text, 'Booked the painter for December.');
  await runSweep(world.data);
  assert.equal(world.calls().length, 1, 'nothing recorded since: no model call');
  assert.match(readFileSync(join(world.data, 'organizer', 'log.jsonl'), 'utf8'), /"outcome":"no change"/);
});

test('the fold input and patch follow the Hermes plugin\'s structure update', () => {
  const result = {
    event: { id: 'evt_1', title: 'Trip to Lisbon, spring 2027', state: 'emerging', facts: { constraint: 'Under 20,000 yuan.' }, parents: ['evt_0'], refs: [{ ref: 'ent_1' }] },
    accounts: [{ id: 'acc_1', text: 'Thinking about Lisbon', source: 'user', createdAt: '2026-11-01T10:00:00.000Z' }, { id: 'acc_2', text: 'Book flights in March', source: 'user', createdAt: '2026-11-16T10:00:00.000Z' }],
    entities: [{ id: 'ent_1', name: 'Mei' }],
  };
  const entries = [{ id: 'evt_0', title: 'Travel more' }, { id: 'evt_2', title: 'Lisbon flights', state: 'active', parents: ['evt_1'] }];
  const { text, clipped } = foldInput(result, result.accounts[1], entries);
  assert.match(text, /said on 2026-11-16/);
  assert.match(text, /involves: Mei/);
  assert.match(text, /part of: Travel more \(this matter is one part of it/);
  assert.match(text, /parts: Lisbon flights \(what holds only for one of them belongs on that part/);
  assert.match(text, /Earlier words, oldest first:\n- 2026-11-01: Thinking about Lisbon/);
  assert.ok(text.endsWith('The new words:\nBook flights in March'));
  const patch = foldPatch(result.event, { change: true, state: 'active', plan: 'Book flights in March 2027.', constraint: 'Under 20,000 yuan.', involves: ['Mei', 'the airline', '我'] }, result.accounts[1], clipped, ['Mei']);
  assert.deepEqual(patch, { state: 'active', facts: { plan: 'Book flights in March 2027.' }, refs: [{ ref: 'ent_1' }, { criteria: 'the airline' }] });
  assert.deepEqual(foldPatch(result.event, { change: false, plan: 'x' }, result.accounts[1], clipped), {});
  assert.deepEqual(jsonObject('Sure:\n```json\n{"change": false}\n```'), { change: false });
  assert.equal(jsonObject('no json here'), undefined);
});

test('an organizer run that calls a tool is not used, and words that keep failing are given up after three tries', async () => {
  const world = setup({ change: true, plan: 'Written after a tool call.' });
  writeFileSync(join(world.bin, 'tool'), '');
  const codex = await connect(world.data, 'codex');
  let receipt;
  try {
    receipt = await codex.call('event_note', { actor: { kind: 'agent', id: 'codex' }, text: 'Words whose fold calls a tool', title: 'A tool call, 2026' });
  } finally {
    await codex.close();
  }
  enable(world);
  mkdirSync(join(world.data, 'organizer'), { recursive: true });
  writeFileSync(join(world.data, 'organizer', 'state.json'), JSON.stringify({ sweepCheckpoint: '2000-01-01T00:00:00.000Z', done: {} }));
  for (let run = 1; run <= 4; run += 1) {
    writeFileSync(join(world.data, 'repository.json'), readFileSync(join(world.data, 'repository.json')));
    const state = JSON.parse(readFileSync(join(world.data, 'organizer', 'state.json'), 'utf8'));
    delete state.sweptMark;
    writeFileSync(join(world.data, 'organizer', 'state.json'), JSON.stringify({ ...state, sweepCheckpoint: '2000-01-01T00:00:00.000Z' }));
    await runSweep(world.data);
  }
  assert.equal(world.calls().length, 3, 'tried three times, then given up');
  const repository = JSON.parse(readFileSync(join(world.data, 'repository.json'), 'utf8'));
  assert.equal(repository.events.find((item) => item.event.id === receipt.eventId).event.facts, undefined, 'nothing written');
  assert.match(readFileSync(join(world.data, 'organizer', 'log.jsonl'), 'utf8'), /called 1 tool, so its answer is not used/);
  assert.equal(JSON.parse(readFileSync(join(world.data, 'organizer', 'state.json'), 'utf8')).done[receipt.accountId], 'gave up');
});
