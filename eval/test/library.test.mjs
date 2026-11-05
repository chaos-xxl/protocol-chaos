import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../../server/store.mjs';
import P from '../lib/arms/protocol.mjs';
import T1 from '../lib/arms/entries.mjs';
import T2 from '../lib/arms/files.mjs';
import { checkEquivalence } from '../lib/equivalence.mjs';
import { describeLibrary, generateLibrary } from '../lib/library.mjs';
import { readRepository, writeRepository } from '../lib/p-writer.mjs';
import { fileNameFor, parseEntries, parseFiles, renderEntries, renderFiles } from '../lib/render.mjs';
import { beijingDate } from '../lib/util.mjs';

const directories = [];
after(() => directories.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'protocol-chaos-eval-'));
  directories.push(d);
  return d;
};
const library = generateLibrary();

const edge = [
  { key: 'e1', title: '换行「和」｜冒号：测试', state: 'active', parent: null, facts: { goal: '目标：带冒号。', plan: '第一行\n第二行' },
    progress: { text: '进展\\带反斜杠', date: '2026-09-01' }, organizedBy: { assistant: 'B', date: '2026-09-01' },
    accounts: [{ date: '2026-08-30', assistant: 'A', source: 'user', text: '原话里有「引号」和｜竖线\n还有换行' },
      { date: '2026-09-01', assistant: 'C', source: 'agent_response', text: '推测：会改（依据：用户说过）。' }] },
  { key: 'e2', title: '换行「和」｜冒号：测试的一部分', state: 'emerging', parent: 'e1', facts: {}, progress: null, organizedBy: null,
    accounts: [{ date: '2026-09-02', assistant: 'B', source: 'user', text: '这是一部分。' }] },
];

test('the library is the same for the same seed and different for another', () => {
  assert.deepEqual(generateLibrary(), library);
  assert.notDeepEqual(generateLibrary({ seed: 7 }), library);
});

test('smaller libraries are prefixes, and parents come before their parts', () => {
  assert.deepEqual(generateLibrary({ size: 10 }), library.slice(0, 10));
  assert.deepEqual(generateLibrary({ size: 50 }), library.slice(0, 50));
  const index = new Map(library.map((m, i) => [m.key, i]));
  for (const [i, m] of library.entries()) {
    if (!m.parent) continue;
    assert.ok(index.get(m.parent) < i, `${m.key} comes after its parent`);
    assert.ok(library[index.get(m.parent)].accounts[0].date <= m.accounts[0].date, `${m.key} is not older than its parent`);
  }
  assert.equal(new Set(library.map((m) => m.title)).size, 150);
});

test('the library looks like a person\'s matters: states, parents, words and inferences in proportion', () => {
  const d = describeLibrary(library);
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort());
  assert.deepEqual(sorted(d.states), sorted({ active: 52, done: 30, dormant: 23, waiting: 15, emerging: 15, cancelled: 15 }));
  assert.ok(d.withParent >= 25 && d.withParent <= 45, `with a parent: ${d.withParent}`);
  assert.ok(d.inferences / d.accounts > 0.05 && d.inferences / d.accounts < 0.2, `inferences ${d.inferences}/${d.accounts}`);
  assert.ok(d.firstDate >= '2025-11-01' && d.lastDate <= '2026-09-30');
  for (const m of library) {
    if (m.organizedBy) assert.ok(m.organizedBy.date >= m.accounts.at(-1).date, m.key);
    else assert.ok(m.state === 'emerging' && !Object.keys(m.facts).length && !m.progress, m.key);
  }
});

test('reserved words never appear', () => {
  const reserved = ['成都', '吉他', '体检', '护照'];
  const text = JSON.stringify(generateLibrary({ reserved }));
  for (const word of reserved) assert.ok(!text.includes(word), word);
});

test('entries and files render and parse back exactly', () => {
  for (const matters of [library, edge]) {
    const byTitle = new Map(matters.map((m) => [m.key, m.title]));
    const expected = matters.map((m) => ({ ...m, key: m.title, parent: m.parent ? byTitle.get(m.parent) : null }));
    assert.deepEqual(parseEntries(renderEntries(matters)), expected);
    const { files, index } = renderFiles(matters);
    assert.deepEqual(parseFiles({ files, index }).sort((a, b) => (a.title < b.title ? -1 : 1)), expected.sort((a, b) => (a.title < b.title ? -1 : 1)));
  }
});

test('file names are safe and unique', () => {
  const taken = new Set();
  assert.equal(fileNameFor('2026 年 3 月 a/b:c?', taken), '2026年3月a-b-c-.md');
  assert.equal(fileNameFor('2026 年 3 月 a/b:c?', taken), '2026年3月a-b-c--2.md');
  assert.equal(fileNameFor('index', taken), 'index-2.md');
  assert.equal(fileNameFor('.hidden', taken), 'hidden.md');
});

test('the protocol store holds the matters at their dates, and the server reads it as it is', async () => {
  const dir = fresh();
  writeRepository([...library, ...edge], dir);
  const back = readRepository(dir);
  assert.equal(back.length, 152);
  const store = new Store(dir);
  const pack = store.read((repo) => repo.contextPack({}));
  assert.equal(pack.events.length, 152);
  const byTitle = new Map(library.map((m) => [m.title, m]));
  for (const entry of pack.events) {
    const matter = byTitle.get(entry.title);
    if (!matter) continue;
    assert.equal(entry.state, matter.state);
    const event = store.read((repo) => repo.getProtocol({ eventId: entry.id, accounts: 'all' }));
    assert.equal(beijingDate(event.accounts[0].createdAt), matter.accounts[0].date);
    assert.deepEqual(event.accounts.map((a) => a.actor.id), matter.accounts.map((a) => `assistant-${a.assistant.toLowerCase()}`));
  }
});

test('the three arms start from the same information, and a difference is caught', () => {
  const root = fresh();
  const matters = [...library, ...edge];
  const dirs = { P: join(root, 'P'), T1: join(root, 'T1'), T2: join(root, 'T2') };
  P.prepare(dirs.P, matters);
  T1.prepare(dirs.T1, matters);
  T2.prepare(dirs.T2, matters);
  assert.deepEqual(checkEquivalence(matters, dirs), { ok: true, differences: { P: [], T1: [], T2: [] } });
  const file = join(dirs.T1, 'entries.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.entries[3] = data.entries[3].replace(/状态：([^\n]+)/, (_, label) => `状态：${label === '已取消' ? '进行中' : '已取消'}`);
  writeFileSync(file, JSON.stringify(data));
  const result = checkEquivalence(matters, dirs);
  assert.equal(result.ok, false);
  assert.equal(result.differences.T1.length, 1);
  assert.match(result.differences.T1[0], /state differs/);
});
