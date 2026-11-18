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
  applyExtraction, applyLinks, findSources, importOffer, LINK_INSTRUCTIONS, linkInput, makeChunks, memoriesTool, partInput, pendImport, planImport, readImport, redact, renderTree, runImport, undoImport,
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

test('Claude Code memories of type feedback or reference are left out: how to work, where things are', () => {
  const { home, env } = freshHome();
  const folder = join(home, '.claude', 'projects', '-tmp-photo', 'memory');
  put(join(folder, 'style.md'), '---\nname: style\ndescription: how Sam wants reports\nmetadata:\n  node_type: memory\n  type: feedback\n---\n\nTurn research docs into reports with screenshots.\n');
  put(join(folder, 'figma.md'), '---\nname: figma\ntype: reference\n---\n\nThe moodboard is in Figma, page Colours.\n');
  const { files, skipped } = findSources(env);
  assert.ok(!files.some((file) => /style\.md|figma\.md/.test(file.via)));
  const why = Object.fromEntries(skipped.map((file) => [file.path.split('/').pop(), file.why]));
  assert.match(why['style.md'], /type feedback/);
  assert.match(why['figma.md'], /type reference/);
  assert.ok(files.some((file) => file.via === 'Claude Code memory: project-studio.md'), 'a memory without those types is still read');
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
    // The call after the parts, which puts together what they wrote apart: nothing to put here.
    if (rules === LINK_INSTRUCTIONS) return { text: '{"links": []}', usage: { input: 300, output: 20, cached: 0 }, ms: 5 };
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
  const log = readFileSync(join(data, 'import', 'log.jsonl'), 'utf8');
  assert.match(log, /"outcome":"written".*"dropped":1,"why":\{"quote":1,"title":0,"refused":0\}/, 'each part says what it wrote and why any was left out');
  assert.ok(!log.includes(TRIP) && !log.includes('Nobody ever wrote'), 'counts only, never words');

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
  assert.equal(studio.accounts[1].text, STUDIO, 'as the notes word it, not as the model retyped it');
  assert.equal(studio.event.facts.constraint, 'Budget 8,000 yuan; done by June 2027', 'and the facts it lacked');

  assert.equal(importOffer(data), 'done');
  const report = await memoriesTool(data, { action: 'status' }, { env, store });
  assert.equal(report.report.newMatters, 1);
  assert.equal(report.report.wordsAddedToExisting, 1);
  assert.match(report.report.tree, /^\+ 2027 年春天葡萄牙行（和朋友）$/m);
  assert.match(report.report.tree, /^- Home photo studio, 2027$/m);
  assert.equal(calls.filter((input) => input.includes('The notes, part')).length, 1, 'notes this short are one part, one call');
  assert.equal(calls.length, 2, 'and one more after the parts, to put together what they wrote apart');
  assert.deepEqual(report.report.tokens, { input: 1300, output: 120, cached: 0 });
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

test('words a later part adds to a matter the import started are not counted as words on matters the repository held', async () => {
  const { home, data, env } = freshHome();
  writeFileSync(join(data, 'organizer.json'), JSON.stringify({ agent: 'dsh', command: '/bin/true', actor: 'organizer', enabled: true }));
  rmSync(join(home, '.hermes'), { recursive: true, force: true });
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(200)}`).join('\n\n');
  put(join(home, '.claude', 'projects', '-tmp-trip', 'memory', 'project-trip.md'), `${TRIP}\n\n${filler}\n\n${LISBON}\n`);
  const store = new Store(data);
  pendImport(data);
  await memoriesTool(data, { action: 'start' }, { env, store, spawnWorker: false });
  const calls = [];
  const ask = async (directory, config, rules, input) => {
    calls.push(input);
    const matters = [TRIP, LISBON].filter((quote) => input.includes(quote)).map((quote) => ({ ref: 'm1', existing: null, title: '2027 年春天葡萄牙行（和朋友）', quotes: [quote] }));
    return { text: JSON.stringify({ matters }), usage: { input: 10, output: 10, cached: 0 } };
  };
  assert.equal(await runImport(data, { env, ask }), 0);
  assert.notEqual(calls.findIndex((input) => input.includes(TRIP)), calls.findIndex((input) => input.includes(LISBON)), 'the two sentences are in two parts');
  const state = readImport(data);
  assert.equal(state.run.created.length, 1);
  assert.equal(store.read((repo) => repo.getProtocol({ eventId: state.run.created[0], accounts: 'all' })).accounts.length, 2, 'the later part adds its sentence to the matter the earlier one started');
  const report = await memoriesTool(data, { action: 'status' }, { env, store });
  assert.equal(report.report.newMatters, 1);
  assert.equal(report.report.wordsAddedToExisting, 0, 'the repository held no matter before the import');
  assert.equal((await undoImport(data)).noted, 0);
});

test('a part names the files not changed for 90 days or more, whose to-dos may be done or dropped', () => {
  const chunk = { text: '(the notes)', parts: [
    { via: 'Claude Code memory: project.md', mtime: '2026-06-29T00:00:00.000Z', text: 'Project: icons.' },
    { via: 'Kiro steering: sam.md', mtime: '2026-11-01T00:00:00.000Z', text: 'Moving in winter.' },
  ] };
  const input = partInput(chunk, 0, 1, [], new Date('2026-11-18T09:00:00Z'));
  assert.match(input, /Not changed for 90 days or more, so the steps and to-dos in them may be done or dropped since: Claude Code memory: project\.md \(last changed 2026-06-29, 142 days ago\)\./);
  assert.doesNotMatch(input, /sam\.md \(last changed/, 'a file changed recently is not named');
  assert.doesNotMatch(partInput({ text: '', parts: [chunk.parts[1]] }, 0, 1, [], new Date('2026-11-18T09:00:00Z')), /Not changed for 90 days/);
});

test('a quote the model retyped is found, and kept as the notes word it', async () => {
  const { data } = freshHome();
  const store = new Store(data);
  const notes = [
    '# Sam',
    '',
    '- **目标**：3–5 年内在杭州买一套小房子',
    '- **日语**：2025 年考过 N3，目标 N1，重点练听力',
    '- 结论是 **slow travel ≠ cheap travel**。',
  ].join('\n');
  const chunk = { parts: [{ via: 'Kiro steering: sam.md', mtime: '2026-10-15T03:54:00.000Z', text: notes }] };
  const answer = { matters: [
    { ref: 'm1', title: '杭州买房（3–5 年内）', quotes: ['**目标**：3-5年内在杭州买一套小房子。'] },
    { ref: 'm2', title: '日语考到 N1', quotes: ['日语:2025年考过N3,目标N1,重点练听力'] },
    { ref: 'm3', title: 'Slow travel', quotes: ['结论是 slow travel ≠ cheap travel。'] },
    { ref: 'm4', title: 'Invented', quotes: ['3 年内就要搬去海边'] },
    { ref: 'm5', title: null, quotes: ['**目标**：3–5 年内在杭州买一套小房子'] },
  ] };
  const out = await applyExtraction(store, chunk, answer, { runId: 'imp_retyped' });
  assert.equal(out.created.length, 3);
  assert.deepEqual(out.why, { quote: 1, title: 1, refused: 0 }, 'a quote that is not in the notes, and a new matter without a title, are left out');
  const words = out.created.map((eventId) => store.read((repo) => repo.getProtocol({ eventId, accounts: 'all' })).accounts[0].text);
  assert.deepEqual(words, [
    '**目标**：3–5 年内在杭州买一套小房子',
    '**日语**：2025 年考过 N3，目标 N1，重点练听力',
    '结论是 **slow travel ≠ cheap travel**。',
  ], 'the dash, spaces, full stop and full-width marks of the notes, not those of the model');
});

test('a later part puts a matter the import started under a larger one; a matter the repository held stays where it was', async () => {
  const { data } = freshHome();
  const store = new Store(data);
  const old = await store.write((repo) => repo.eventNote({ actor: { kind: 'agent', id: 'kiro' }, text: 'I keep a photo blog.', title: 'Photo blog' }));
  const first = { parts: [{ via: 'Claude Code memory: icons.md', mtime: '2026-06-29T07:42:00.000Z', text: 'Pixel icon set: 120 icons in a retro style, free to use.' }] };
  const one = await applyExtraction(store, first, { matters: [{ ref: 'm1', title: 'Pixel icon set', quotes: ['Pixel icon set: 120 icons in a retro style, free to use.'] }] }, { runId: 'imp_link' });
  const [icons] = one.created;
  const second = { parts: [{ via: 'Kiro steering: sam.md', mtime: '2026-10-15T03:54:00.000Z', text: 'A portfolio site by next summer. The pixel icon set is one of its two pieces. The photo blog is the other.' }] };
  const two = await applyExtraction(store, second, { matters: [
    { ref: 'm1', title: 'Portfolio site by summer 2027', quotes: ['A portfolio site by next summer.'] },
    { ref: 'm2', existing: icons, parent: 'm1', quotes: ['The pixel icon set is one of its two pieces.'] },
    { ref: 'm3', existing: old.eventId, parent: 'm1', quotes: ['The photo blog is the other.'] },
  ] }, { runId: 'imp_link' });
  const [portfolio] = two.created;
  assert.deepEqual(two.linked, [icons]);
  assert.deepEqual(store.read((repo) => repo.getProtocol({ eventId: icons })).event.parents, [portfolio], 'the matter this import started earlier is put under the larger one');
  assert.deepEqual(store.read((repo) => repo.getProtocol({ eventId: old.eventId })).event.parents, [], 'one the repository held before is not moved');
  assert.deepEqual(two.noted.sort(), [old.eventId, icons].sort(), 'both get the words');
});

test('after the parts, one more call puts what they wrote apart under the larger matter; nothing the repository held is moved', async () => {
  const { home, data, env } = freshHome();
  writeFileSync(join(data, 'organizer.json'), JSON.stringify({ agent: 'dsh', command: '/bin/true', actor: 'organizer', enabled: true }));
  rmSync(join(home, '.hermes'), { recursive: true, force: true });
  const ICONS = 'Pixel icon set: 120 icons in a retro style, free to use.';
  const GOAL = 'Long-term goal: side projects that pay for a year off by 2030, the pixel icon set first.';
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(200)}`).join('\n\n');
  put(join(home, '.claude', 'projects', '-tmp-side', 'memory', 'project-side.md'), `${ICONS}\n\n${filler}\n\n${GOAL}\n`);
  const store = new Store(data);
  const blog = await store.write((repo) => repo.eventNote({ actor: { kind: 'agent', id: 'kiro' }, text: 'I keep a photo blog.', title: 'Photo blog' }));
  pendImport(data);
  await memoriesTool(data, { action: 'start' }, { env, store, spawnWorker: false });
  const calls = [];
  const ask = async (directory, config, rules, input) => {
    calls.push({ rules, input, config });
    if (rules === LINK_INSTRUCTIONS) {
      const id = (title) => new RegExp(`- (evt_[\\w-]+): ${title}`).exec(input)?.[1];
      return { text: JSON.stringify({ links: [
        { child: id('Pixel icon set'), parent: id('A year off by 2030'), because: 'side projects that pay for a year off by 2030, the pixel icon set first' },
        { child: blog.eventId, parent: id('A year off by 2030'), because: 'I keep a photo blog.' },
        { child: id('A year off by 2030'), parent: 'evt_nowhere', because: 'side projects' },
        { child: id('A year off by 2030'), parent: blog.eventId, because: 'words nobody wrote down' },
      ] }), usage: { input: 300, output: 20, cached: 0 } };
    }
    const matters = [];
    if (input.includes(ICONS)) matters.push({ ref: 'm1', title: 'Pixel icon set', quotes: [ICONS] });
    if (input.includes(GOAL)) matters.push({ ref: 'm1', title: 'A year off by 2030', quotes: [GOAL] });
    return { text: JSON.stringify({ matters }), usage: { input: 10, output: 10, cached: 0 } };
  };
  assert.equal(await runImport(data, { env, ask }), 0);
  const parts = calls.filter((call) => call.rules !== LINK_INSTRUCTIONS);
  assert.notEqual(parts.findIndex((call) => call.input.includes(ICONS)), parts.findIndex((call) => call.input.includes(GOAL)), 'the two are in two parts');
  const last = calls.at(-1);
  assert.equal(last.rules, LINK_INSTRUCTIONS, 'the call that puts them together comes after the parts');
  assert.equal(last.config.effort, 'high', 'DeepSeek Harness thinks on that call');
  assert.ok(parts.every((call) => call.config.effort === undefined), 'and not on the parts');
  assert.match(last.input, /sit under no larger matter[\s\S]*Pixel icon set[\s\S]*A year off by 2030[\s\S]*other open matters[\s\S]*Photo blog/);
  const state = readImport(data);
  const [icons, goal] = state.run.created;
  assert.deepEqual(store.read((repo) => repo.getProtocol({ eventId: icons })).event.parents, [goal]);
  assert.deepEqual(store.read((repo) => repo.getProtocol({ eventId: goal })).event.parents, [], 'a link to a matter that is not there, or for a reason the words do not give, is left out');
  assert.deepEqual(store.read((repo) => repo.getProtocol({ eventId: blog.eventId })).event.parents, [], 'a matter the repository held before is not moved');
  assert.equal(state.run.linked, 1);
  assert.match(readFileSync(join(data, 'import', 'log.jsonl'), 'utf8'), /"part":"links".*"outcome":"written".*"linked":1,"skipped":3,"unsaid":1/);
  const { revisions } = store.read((repo) => repo.getRevisions({ eventId: icons }));
  const link = revisions.find((revision) => revision.type === 'parent.added');
  const goalWords = store.read((repo) => repo.getProtocol({ eventId: goal, accounts: 'all' })).accounts.map((account) => account.id);
  assert.ok(link.sourceAccountIds.every((id) => goalWords.includes(id)), 'the link rests on the words that say so: here, the larger matter\'s');
  const undone = await undoImport(data);
  assert.equal(undone.cancelled, 2);
  assert.equal(store.read((repo) => repo.getProtocol({ eventId: blog.eventId })).event.state, 'emerging');
});

test('the call after the parts sees the heading a matter sits under, and a heading can be the reason for a link', async () => {
  const { data } = freshHome();
  const store = new Store(data);
  const notes = ['# Sam', '', '## Money plan', '', '- Goal: retire early, by 45.', '- An electric car next year, about 200,000 yuan.', '', '## Hobbies', '', '- Learning the cello.'].join('\n');
  const files = [{ via: 'Kiro steering: sam.md', text: notes }];
  const chunk = { parts: [{ via: 'Kiro steering: sam.md', mtime: '2026-11-01T00:00:00.000Z', text: notes }] };
  const out = await applyExtraction(store, chunk, { matters: [
    { ref: 'm1', title: 'Retire early by 45', quotes: ['Goal: retire early, by 45.'] },
    { ref: 'm2', title: 'Electric car, 2027', quotes: ['An electric car next year, about 200,000 yuan.'] },
    { ref: 'm3', title: 'Cello', quotes: ['Learning the cello.'] },
  ] }, { runId: 'imp_heading' });
  const [aim, car, cello] = out.created;
  const input = linkInput(store, out.created, new Date('2026-11-18T09:00:00Z'), files);
  assert.match(input, /Electric car, 2027 \(emerging\); Kiro steering: sam\.md, under the heading "Money plan"/);
  assert.match(input, /Cello \(emerging\); Kiro steering: sam\.md, under the heading "Hobbies"/);
  const result = await applyLinks(store, { links: [
    { child: car, parent: aim, because: 'Retire early by 45 / Money plan' },
    { child: cello, parent: aim, because: 'a hobby that pays' },
    { child: cello, parent: aim, because: 'Retire early by 45 / Cello' },
  ] }, { runId: 'imp_heading', created: out.created, files });
  assert.deepEqual(result.linked, [car], 'the heading both sit under is in the notes; the title of the parent is no fault');
  assert.equal(result.unsaid, 2, 'a reason that is nowhere in the notes is not, nor the two titles alone');
  const link = store.read((repo) => repo.getRevisions({ eventId: car })).revisions.find((revision) => revision.type === 'parent.added');
  const carWords = store.read((repo) => repo.getProtocol({ eventId: car, accounts: 'all' })).accounts.map((account) => account.id);
  assert.deepEqual(link.sourceAccountIds, carWords.slice(0, 1), 'a reason found only in the file rests on the child\'s own words');
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

test('the notes of OpenCode, OpenClaw, GitHub Copilot and Pi are read too; OpenClaw only its newest daily notes, Copilot without the block init wrote', () => {
  const home = mkdtempSync(join(tmpdir(), 'protocol-chaos-memories-'));
  homes.push(home);
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  put(join(home, '.config', 'opencode', 'AGENTS.md'), 'Sam is learning Rust this winter.\n');
  put(join(home, '.openclaw', 'openclaw.json'), '{\n  // where the agent lives\n  "agents": { "defaults": { "workspace": "~/claw" } },\n}\n');
  put(join(home, 'claw', 'MEMORY.md'), 'Sam is saving for a camera.\n');
  put(join(home, 'claw', 'USER.md'), '- Prefer short answers.\n');
  for (let day = 1; day <= 32; day += 1) put(join(home, 'claw', 'memory', `2026-10-${String(day).padStart(2, '0')}.md`), `Note of day ${day}.\n`);
  put(join(home, '.copilot', 'copilot-instructions.md'), 'Sam plans to move in December.\n\n<!-- protocol-chaos:begin (added by init) -->\nUse the protocol_chaos server.\n<!-- protocol-chaos:end -->\n');
  const vscodeUser = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Code', 'User') : join(home, '.config', 'Code', 'User');
  put(join(vscodeUser, 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories', 'preferences.md'), 'Sam is training for a half marathon in March.\n');
  put(join(home, '.pi', 'agent', 'CLAUDE.md'), 'Sam is rebuilding the home server.\n');

  const { files, skipped } = findSources(env);
  const vias = files.map((file) => file.via);
  for (const via of ['OpenCode: AGENTS.md', 'OpenClaw memory: MEMORY.md', 'OpenClaw: USER.md', 'GitHub Copilot: copilot-instructions.md', 'VS Code Copilot memory: preferences.md', 'Pi: CLAUDE.md']) {
    assert.ok(vias.includes(via), `${via} is read`);
  }
  const daily = vias.filter((via) => via.startsWith('OpenClaw daily note:'));
  assert.equal(daily.length, 30);
  assert.ok(daily.includes('OpenClaw daily note: 2026-10-32.md') && !daily.includes('OpenClaw daily note: 2026-10-01.md'), 'the newest');
  assert.match(skipped.find((file) => file.via === 'OpenClaw daily notes').why, /^2 older daily notes; the newest 30 are read$/);
  assert.equal(files.find((file) => file.agent === 'copilot' && file.via.startsWith('GitHub')).text, 'Sam plans to move in December.');
});
