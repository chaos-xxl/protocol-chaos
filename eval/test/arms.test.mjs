import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import P from '../lib/arms/protocol.mjs';
import { memoryTool } from '../lib/arms/entries.mjs';
import T2, { notesTools } from '../lib/arms/files.mjs';
import { readRepository } from '../lib/p-writer.mjs';

const directories = [];
after(() => directories.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'protocol-chaos-arms-'));
  directories.push(d);
  return d;
};
const matter = (key, title, text, date = '2026-09-20') => ({
  key, title, state: 'active', parent: null, facts: { goal: `${title}。` }, progress: null,
  accounts: [{ date, assistant: 'A', source: 'user', text }], organizedBy: { assistant: 'A', date },
});

test('T1: add, replace a unique passage, remove a whole entry', () => {
  const entries = ['【搬家】\n条件：预算 2 万元。', '【旅行】\n条件：预算 2 万元。'];
  let saves = 0;
  const run = memoryTool(entries, () => { saves += 1; });
  assert.match(run({ action: 'replace', old_text: '预算 2 万元', new_text: '预算 2.5 万元' }).text, /出现了 2 次（在 2 条里）/);
  const replaced = run({ action: 'replace', old_text: '【搬家】\n条件：预算 2 万元', new_text: '【搬家】\n条件：预算 2.5 万元' });
  assert.equal(replaced.isError, false);
  assert.equal(entries[0], '【搬家】\n条件：预算 2.5 万元。');
  assert.equal(run({ action: 'replace', old_text: '不存在的话', new_text: 'x' }).isError, true);
  assert.equal(run({ action: 'add', content: '  【新事】  ' }).text, '已新增一条。现在共 3 条。');
  assert.equal(entries[2], '【新事】');
  assert.match(run({ action: 'remove', old_text: '条件：预算' }).text, /出现在 2 条里/);
  assert.equal(run({ action: 'remove', old_text: '【旅行】' }).isError, false);
  assert.deepEqual(entries, ['【搬家】\n条件：预算 2.5 万元。', '【新事】']);
  assert.equal(run({ action: 'replace', old_text: '【新事】', new_text: ' ' }).isError, true, 'an entry cannot become empty');
  assert.equal(run({ action: 'rewrite' }).isError, true);
  assert.equal(saves, 3);
});

test('T2: view, search, create, a unique replacement, append', () => {
  const dir = fresh();
  T2.prepare(dir, [matter('a', '2026 年 11 月搬家', '下个月搬家，预算 2 万。'), matter('b', '2026 年 12 月去青岛', '十二月去青岛，预算 2 万。')]);
  const tools = notesTools(join(dir, 'notes'));
  assert.match(tools.notes_view({ path: 'index.md' }).text, /2026 年 11 月搬家\.md/);
  assert.equal(tools.notes_view({ path: '../secret.md' }).isError, true);
  assert.equal(tools.notes_view({ path: '没有.md' }).isError, true);
  const found = tools.notes_search({ query: '预算 青岛' }).text;
  assert.match(found, /^2026 年 12 月去青岛\.md/);
  assert.doesNotMatch(found, /搬家\.md/);
  assert.match(tools.notes_search({ query: '东京' }).text, /没有文件同时包含/);
  assert.match(tools.notes_str_replace({ path: '2026 年 11 月搬家.md', old_str: '2026 年 11 月搬家', new_str: 'x' }).text, /出现了 2 次/);
  assert.equal(tools.notes_str_replace({ path: '2026 年 11 月搬家.md', old_str: '下个月搬家，预算 2 万。', new_str: '下个月搬家，预算 2.5 万。' }).isError, false);
  assert.match(tools.notes_view({ path: '2026 年 11 月搬家.md' }).text, /预算 2\.5 万/);
  assert.equal(tools.notes_create({ path: '2026 年 11 月搬家.md', content: 'x' }).isError, true);
  assert.equal(tools.notes_create({ path: 'a/b.md', content: 'x' }).isError, true);
  assert.equal(tools.notes_create({ path: '新事.md', content: '# 新事' }).isError, false);
  tools.notes_append({ path: '新事.md', content: '- 一行' });
  assert.equal(readFileSync(join(dir, 'notes', '新事.md'), 'utf8'), '# 新事\n- 一行\n');
});

test('P: over HTTP each assistant writes as itself, with versions, at the simulated time', async () => {
  const dir = fresh();
  const meta = P.prepare(dir, [matter('a', '2026 年 11 月搬家', '下个月搬家，预算 2 万。')]);
  const b = await P.open(dir, { date: '2026-10-08', time: '09:30', assistant: 'B', meta });
  try {
    assert.equal(b.tools.length, 14);
    assert.ok(!b.has('repository_export'), 'no owner tools');
    assert.match(b.view, /^## 事情目录/);
    assert.match(b.view, /evt_0001｜2026 年 11 月搬家｜active｜上级：无｜更新：2026-09-20/);
    const asA = await b.call('event_note', { actor: { kind: 'agent', id: 'assistant-a' }, eventId: 'evt_0001', text: '预算改成 2.5 万。' });
    assert.equal(asA.isError, true);
    assert.match(asA.text, /ACTOR_MISMATCH/);
    const note = await b.call('event_note', { actor: { kind: 'agent', id: 'assistant-b' }, eventId: 'evt_0001', text: '预算改成 2.5 万。' });
    const receipt = JSON.parse(note.text);
    const noVersion = await b.call('event_record_expression', {
      eventId: 'evt_0001', actor: { kind: 'agent', id: 'assistant-b' }, accountId: receipt.accountId, text: '预算改成 2.5 万。', set: { facts: { constraint: '预算 2.5 万元。' } },
    });
    assert.match(noVersion.text, /VERSION_REQUIRED/);
    const done = await b.call('event_record_expression', {
      eventId: 'evt_0001', actor: { kind: 'agent', id: 'assistant-b' }, accountId: receipt.accountId, text: '预算改成 2.5 万。',
      expectedVersion: receipt.version, set: { facts: { constraint: '预算 2.5 万元。' } },
    });
    assert.equal(done.isError, false);
  } finally {
    await b.close();
  }
  const [stored] = readRepository(dir);
  assert.deepEqual(stored.accounts.at(-1), { date: '2026-10-08', assistant: 'B', source: 'user', text: '预算改成 2.5 万。' });
  assert.deepEqual(stored.organizedBy, { assistant: 'B', date: '2026-10-08' });
  const raw = JSON.parse(readFileSync(join(dir, 'repository.json'), 'utf8'));
  assert.equal(raw.events[0].accounts.at(-1).createdAt, '2026-10-08T01:30:00.000Z', '09:30 in Beijing');
});
