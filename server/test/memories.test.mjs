// Importing other assistants' memories (memories.mjs) in a throwaway home folder: which files
// are read and which are left out, that secrets never reach the model, that only matters resting
// on sentences of the notes are written, in the right places, and that the tool offers, runs and
// reports an import as the assistants are told, then goes away.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { instructions } from '../instructions.mjs';
import {
  applyExtraction, findSources, importOffer, makeChunks, memoriesTool, pendImport, planImport, readImport, redact, renderTree, runImport, undoImport,
} from '../memories.mjs';
import { runSweep } from '../organize.mjs';
import { Store } from '../store.mjs';

const SERVER = fileURLToPath(new URL('../index.mjs', import.meta.url));
const homes = [];
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const TRIP = '明年春天和朋友去葡萄牙玩一周，预算一万五以内。';
const LISBON = 'Sam 想住在里斯本老城附近。';
const STUDIO = 'Sam is building a home photo studio in the spare room, budget 8,000 yuan, done by June 2027.';
const PROFILE = 'Sam was born in 1994 and lives in Hangzhou.';

/** A home folder with the memories of several assistants, and a repository folder. */
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'protocol-chaos-memories-'));
  homes.push(home);
  put(join(home, '.claude', 'CLAUDE.md'), `# Notes\n\n${PROFILE}\n\nMy key is sk-abcdefghijklmnopqrstuvwx and password: hunter2-secret.\n`);
  put(join(home, '.claude', 'projects', '-tmp-photo', 'memory', 'MEMORY.md'), '- [studio](project-studio.md) — the photo studio\n');
  put(join(home, '.claude', 'projects', '-tmp-photo', 'memory', 'project-studio.md'), `---\nname: studio\ndescription: the photo studio\n---\n\n${STUDIO}\n`);
  put(join(home, '.codex', 'AGENTS.md'), `Be brief.\n\n<!-- protocol-chaos:begin (added by init) -->\nUse the protocol_chaos server.\n<!-- protocol-chaos:end -->\n`);
  put(join(home, '.kiro', 'steering', 'methods.md'), '---\ninclusion: manual\n---\n\n# How to write keynotes\n');
  put(join(home, '.kiro', 'steering', 'agreement.md'), '# Working agreement\n\nRead the directory with context_pack before answering.\n');
  put(join(home, '.hermes', 'memories', 'MEMORY.md'), `${TRIP}\n§\n${LISBON}`);
  const data = join(home, '.protocol-chaos');
  mkdirSync(data, { recursive: true });
  return { home, data, env: { HOME: home, PATH: '/usr/bin:/bin' } };
}

test('the files read, the ones left out and why, and nothing secret in what is sent', () => {
  const { env } = freshHome();
  const { files, skipped } = findSources(env);
  const vias = files.map((file) => file.via).sort();
  assert.deepEqual(vias, ['Claude Code memory: project-studio.md', 'Claude Code: CLAUDE.md', 'Codex: AGENTS.md', 'Hermes memory: MEMORY.md']);
  assert.ok(!vias.some((via) => via.includes('MEMORY.md') && via.startsWith('Claude')), 'the index of a memory folder is not read: its files are');
  const codex = files.find((file) => file.agent === 'codex');
  assert.equal(codex.text, 'Be brief.', 'the block init wrote is left out, the user\'s own text kept');
  const why = Object.fromEntries(skipped.map((file) => [file.path.split('/').pop(), file.why]));
  assert.match(why['methods.md'], /only in some conversations, by inclusion: manual/);
  assert.match(why['agreement.md'], /rules for using this repository/);
  const claude = files.find((file) => file.via === 'Claude Code: CLAUDE.md');
  assert.ok(!claude.text.includes('sk-abc') && !claude.text.includes('hunter2'), claude.text);
  assert.equal(claude.hidden, 2);
  assert.equal(redact('身份证 110101199001011234，卡号 6222020200112233445').count, 2, 'ID and card numbers too');
  assert.equal(redact('a project named sk-learn and 2026-11-17').count, 0, 'ordinary words and dates are kept');
});

test('parts stay under the limit, keep whole files together where they fit, and name their files', () => {
  const files = [
    { path: '/a', via: 'A: a.md', mtime: '2026-11-01T00:00:00.000Z', text: 'one\n\ntwo', kind: 'markdown' },
    { path: '/b', via: 'B: b.md', mtime: '2026-11-02T00:00:00.000Z', text: Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(200)}`).join('\n\n'), kind: 'markdown' },
  ];
  const chunks = makeChunks(files, 3000);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) assert.ok(chunk.text.length <= 3000 + 200, `part of ${chunk.text.length} characters`);
  assert.match(chunks[0].text, /^=== A: a\.md \(last changed 2026-11-01\) ===\none\n\ntwo/);
  assert.ok(chunks.flatMap((chunk) => chunk.parts).every((part) => ['/a', '/b'].includes(part.path)));
});

/** A stand-in for the organizer's model: lists what it finds in the notes it is given. */
function fakeModel(calls) {
  return async (directory, config, rules, input) => {
    calls.push(input);
    const matters = [];
    if (input.includes(TRIP)) {
      matters.push({ ref: 'm1', existing: null, title: '2027 年春天葡萄牙行（和朋友）', parent: null, state: 'active', progress: null, goal: '和朋友去葡萄牙玩一周', constraint: '预算一万五以内；想住在里斯本老城附近', plan: null, quotes: [TRIP, LISBON] });
      matters.push({ ref: 'm2', title: 'A made-up matter', quotes: ['Nobody ever wrote this sentence.'] });
    }
    if (input.includes(STUDIO)) {
      matters.push({ ref: 'm3', existing: null, title: 'Home photo studio, 2027', parent: null, state: null, goal: 'A photo studio in the spare room', constraint: 'Budget 8,000 yuan; done by June 2027', plan: null, progress: null, quotes: [`**${STUDIO}**`] });
    }
    return { text: `Here it is:\n${JSON.stringify({ matters })}`, usage: { input: 1000, output: 100, cached: 0 }, ms: 5 };
  };
}

test('a background import writes what rests on the notes, folds its own fields, reports a tree, and the sweep leaves it alone', async () => {
  const { home, data, env } = freshHome();
  writeFileSync(join(data, 'organizer.json'), JSON.stringify({ agent: 'dsh', command: '/bin/true', actor: 'organizer', enabled: true }));
  const store = new Store(data);
  const existing = await store.write((repo) => repo.eventNote({ actor: { kind: 'agent', id: 'kiro' }, text: 'I want my own photo studio.', title: 'Home photo studio, 2027' }));

  pendImport(data);
  assert.equal(importOffer(data), 'pending');
  const offer = await memoriesTool(data, { action: 'status' }, { env, store });
  assert.equal(offer.status, 'pending');
  assert.deepEqual(offer.plan.read.map((group) => group.id).sort(), ['claude-code', 'codex', 'hermes']);
  assert.match(offer.plan.where, /only read, never changed/);
  assert.match(offer.plan.where, /DeepSeek's API/);
  assert.ok(offer.plan.estimate.tokens > 0 && offer.plan.estimate.minutes >= 1);
  assert.match(offer.tell, /Ask whether to import/);

  const started = await memoriesTool(data, { action: 'start' }, { env, store, spawnWorker: false });
  assert.equal(started.status, 'running');
  assert.equal(started.mode, 'background');
  assert.ok(existsSync(readImport(data).run.backup), 'the repository is copied before anything is written');
  assert.equal(importOffer(data), 'running');

  const calls = [];
  assert.equal(await runImport(data, { env, ask: fakeModel(calls) }), 0);
  assert.ok(calls.every((input) => !input.includes('hunter2') && !input.includes('sk-abc')), 'no secret reaches the model');
  const state = readImport(data);
  assert.equal(state.status, 'done');
  assert.equal(state.run.created.length, 1, 'one new matter: the made-up one rests on no sentence, the studio is the one there');
  assert.deepEqual(state.run.noted, [existing.eventId]);
  assert.equal(state.run.dropped, 1);

  const trip = store.read((repo) => repo.getProtocol({ eventId: state.run.created[0], accounts: 'all' }));
  assert.equal(trip.event.title, '2027 年春天葡萄牙行（和朋友）');
  assert.equal(trip.event.state, 'active');
  assert.equal(trip.event.facts.constraint, '预算一万五以内；想住在里斯本老城附近');
  assert.equal(trip.accounts[0].text, `${TRIP}\n${LISBON}`, 'the sentences, as written');
  assert.equal(trip.accounts[0].source, 'authorized_external');
  assert.equal(trip.accounts[0].via, 'Hermes memory: MEMORY.md');
  assert.equal(trip.accounts[0].actor.id, 'importer');
  assert.equal(trip.event.metadata['dev.protocol-chaos/import'].run, state.run.id);
  const studio = store.read((repo) => repo.getProtocol({ eventId: existing.eventId, accounts: 'all' }));
  assert.equal(studio.accounts.length, 2, 'words added to the matter the repository held');
  assert.equal(studio.accounts[1].text, `**${STUDIO}**`);
  assert.equal(studio.event.facts.constraint, 'Budget 8,000 yuan; done by June 2027', 'and the facts it lacked');

  assert.equal(importOffer(data), 'done');
  const report = await memoriesTool(data, { action: 'status' }, { env, store });
  assert.equal(report.report.newMatters, 1);
  assert.equal(report.report.wordsAddedToExisting, 1);
  assert.match(report.report.tree, /^\+ 2027 年春天葡萄牙行（和朋友）$/m);
  assert.match(report.report.tree, /^- Home photo studio, 2027$/m);
  assert.equal(calls.length, 1, 'notes this short are one part, one call');
  assert.deepEqual(report.report.tokens, { input: 1000, output: 100, cached: 0 });
  assert.match(report.tell, /show the tree exactly as given/);
  assert.equal((await memoriesTool(data, { action: 'finish' }, { env, store })).status, 'reported');
  assert.equal(importOffer(data), undefined, 'reported: the tool is not offered again');

  put(join(data, 'organizer', 'state.json'), JSON.stringify({ sweepCheckpoint: '2000-01-01T00:00:00.000Z', done: { [existing.accountId]: 'changed' } }));
  const swept = [];
  await runSweep(data, { ask: async (...args) => { swept.push(args); return { text: '{"change": false}' }; } });
  assert.equal(swept.length, 0, 'the sweep does not fold the import\'s words again');

  const undone = await undoImport(data);
  assert.equal(undone.cancelled, 1);
  assert.equal(store.read((repo) => repo.getProtocol({ eventId: state.run.created[0] })).event.state, 'cancelled');
  assert.equal(store.read((repo) => repo.getProtocol({ eventId: existing.eventId })).event.state, 'emerging', 'a matter it did not start is not touched');
  assert.ok(home);
});

test('without an organizer the import runs in the conversation, part by part, and declining ends the offer', async () => {
  const { data, env } = freshHome();
  const store = new Store(data);
  pendImport(data);
  const offer = await memoriesTool(data, { action: 'status' }, { env, store });
  assert.match(offer.plan.runs, /in this conversation/);
  assert.match(offer.plan.where, /model of the assistant you are talking to/);

  let step = await memoriesTool(data, { action: 'start', sources: ['hermes', 'claude-code'] }, { env, store });
  assert.equal(step.mode, 'conversation');
  assert.equal(step.part, 1);
  assert.match(step.instructions, /call memories_import with action "record"/);
  assert.ok(step.notes.includes('The notes, part 1 of'));
  await assert.rejects(memoriesTool(data, { action: 'record', part: 2, matters: [] }, { env, store }), /part 1 is the next one/);
  const answer = fakeModel([]);
  while (step.status === 'running') {
    const { text } = await answer(data, {}, '', step.notes);
    step = await memoriesTool(data, { action: 'record', part: step.part, matters: JSON.parse(text.slice(text.indexOf('{'))).matters }, { env, store });
  }
  assert.equal(step.status, 'done');
  assert.equal(step.report.newMatters, 2, 'the trip and the studio');
  assert.equal((await memoriesTool(data, { action: 'finish' }, { env, store })).status, 'reported');

  const other = freshHome();
  pendImport(other.data);
  assert.equal((await memoriesTool(other.data, { action: 'decline' }, { env: other.env })).status, 'declined');
  assert.equal(importOffer(other.data), undefined);
});

test('an import nobody answers is offered on three days, then no more', async () => {
  const { data, env } = freshHome();
  pendImport(data);
  for (const day of ['2026-11-18', '2026-11-19', '2026-11-20']) {
    assert.equal(importOffer(data, new Date(`${day}T09:00:00Z`)), 'pending');
    await memoriesTool(data, { action: 'status' }, { env, now: new Date(`${day}T09:00:00Z`) });
  }
  assert.equal(importOffer(data, new Date('2026-11-20T18:00:00Z')), 'pending', 'still the same day');
  assert.equal(importOffer(data, new Date('2026-11-21T09:00:00Z')), undefined);
});

test('the tree puts parts under the larger matter, marks the new ones, and stops at its limit', () => {
  const entries = [
    { id: 'a', title: 'Financial independence by 40', state: 'active', parents: [] },
    { id: 'b', title: 'Index funds', state: 'active', parents: ['a'] },
    { id: 'c', title: 'Side project', state: 'dormant', parents: ['a'] },
    { id: 'd', title: 'Old trip', state: 'done', parents: [] },
  ];
  assert.equal(renderTree(entries, new Set(['b'])), '- Financial independence by 40\n  + Index funds\n  - Side project (dormant)');
  assert.equal(renderTree(entries, new Set(), 2), '- Financial independence by 40\n  - Index funds\n… and 1 more');
});

test('the instructions name the import while there is one, and stay within what clients show', () => {
  for (const status of ['pending', 'running', 'done']) {
    const text = instructions('claude-code', { importStatus: status });
    assert.match(text, /memories_import/);
    assert.ok(text.length < 2000, `${status}: ${text.length} characters`);
  }
  assert.doesNotMatch(instructions('claude-code'), /memories_import/);
});

/** Talks MCP over stdio to a server started as an agent's launcher would start it. */
function session(data, home, client, calls) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ...calls.map((params, index) => ({ jsonrpc: '2.0', id: 3 + index, method: 'tools/call', params })),
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, [SERVER, '--data', data, '--client', client, '--tools', 'writer'], {
    input: `${messages}\n`, encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', PROTOCOL_CHAOS_NO_NOTIFY: '1' }, timeout: 15_000,
  });
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
}

test('the server offers the tool and says so in its instructions only while there is an import; without an organizer a note reminds the assistant to fold', () => {
  const { home, data } = freshHome();
  writeFileSync(join(data, 'installed.json'), '{"agents": {}}');
  const note = { name: 'event_note', arguments: { actor: { kind: 'agent', id: 'kiro' }, text: 'I plan to repaint the kitchen this winter.', title: 'Repaint the kitchen, winter 2026' } };
  let [init, list, noted] = session(data, home, 'kiro', [note]);
  assert.doesNotMatch(init.result.instructions, /memories_import/);
  assert.ok(!list.result.tools.some((tool) => tool.name === 'memories_import'));
  assert.equal(noted.result.content.length, 2, 'no organizer here: a second text reminds the assistant');
  assert.match(noted.result.content[1].text, /bring the Event up to date yourself/);

  pendImport(data);
  [init, list] = session(data, home, 'kiro', []);
  assert.match(init.result.instructions, /IMPORT\. Memories that other assistants keep on this machine can be imported/);
  assert.ok(list.result.tools.some((tool) => tool.name === 'memories_import'));
  const [, , status] = session(data, home, 'kiro', [{ name: 'memories_import', arguments: { action: 'status' } }]);
  assert.equal(JSON.parse(status.result.content[0].text).status, 'pending');

  // An organizer is set up (here it leaves this client's words to the client, so nothing starts).
  writeFileSync(join(data, 'organizer.json'), JSON.stringify({ agent: 'dsh', command: '/bin/true', actor: 'organizer', enabled: true, selfOrganizing: ['kiro'] }));
  const [, , queued] = session(data, home, 'kiro', [note]);
  assert.equal(queued.result.content.length, 1, 'with an organizer, no reminder');
  assert.ok(readFileSync(join(data, 'import', 'state.json'), 'utf8').includes('"pending"'));
});

test('protocol-chaos import: without an organizer it leaves the import to a conversation; --status and --undo say what there is', () => {
  const { home, data } = freshHome();
  const run = (...args) => spawnSync(process.execPath, [SERVER, 'import', ...args, '--data', data], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' }, input: '' });
  assert.match(run('--status').stdout, /No import yet/);
  const planned = run();
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /Memories other assistants keep on this machine:/);
  assert.match(planned.stdout, /left out: ~\/\.kiro\/steering\/agreement\.md \(rules for using this repository, not memories\)/);
  assert.match(planned.stdout, /2 keys, tokens or long numbers hidden before anything is sent/);
  assert.match(planned.stdout, /the import runs in a conversation/);
  assert.equal(readImport(data).status, 'pending', 'the next assistant offers it');
  assert.match(run('--undo').stdout, /nothing to undo/);
  assert.equal(run('--only', 'nobody').status, 2);
});
