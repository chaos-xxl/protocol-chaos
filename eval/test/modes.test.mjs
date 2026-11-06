// The ways of writing (lib/prompts.mjs, MODES): in light and organized the assistants can only
// add words, in every arm; in organized an organizer works on the nights with sessions, is
// told what is new since the last night, and a probe asked before a night sees the store as
// it was then. A scripted model; checks the plumbing, not the arms.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { addedEntries } from '../lib/arms/entries.mjs';
import { folderChanges } from '../lib/arms/files.mjs';
import { ARMS, runCase, timeline } from '../lib/case.mjs';
import { generateLibrary } from '../lib/library.mjs';
import { loadPrompts, systemPrompt } from '../lib/prompts.mjs';
import { createScriptedProvider } from '../lib/provider.mjs';
import { analyze, renderReport } from '../lib/report.mjs';
import { expandTemplate } from '../lib/templates.mjs';

const root = mkdtempSync(join(tmpdir(), 'protocol-chaos-modes-'));
after(() => rmSync(root, { recursive: true, force: true }));

const template = {
  id: 'd1-modes', category: 'D1', author: 'test', shape: 'a value changed on a later day', keywords: ['搬家'], library: 10,
  variants: [{ a: '20000', b: '25000' }],
  sessions: [
    { day: 0, assistant: 'A', user: '下个月搬家，预算 {a} 元。' },
    { day: 3, time: '12:00', assistant: 'B', user: '搬家预算改成 {b} 元。' },
  ],
  probes: [
    { day: 3, time: '21:00', assistant: 'C', question: '搬家预算多少？', answer: { type: 'number', value: '{b}', unit: '元', stale: ['{a}'] } },
    { day: 4, assistant: 'A', question: '搬家预算现在是多少？', answer: { type: 'number', value: '{b}', unit: '元', stale: ['{a}'] } },
  ],
};
const [caseDef] = expandTemplate(template, { split: 'dev' });
const library = generateLibrary({ reserved: template.keywords });
const prompts = loadPrompts();

const armOf = (tools) => {
  const names = tools.map((t) => t.function.name);
  return names.includes('event_note') ? 'P' : names.includes('memory') ? 'T1' : 'T2';
};
const lastTool = (messages) => [...messages].reverse().find((m) => m.role === 'tool')?.content;

/** Writers try to change what is there, then add; the reader says what the store shows. */
function writer(seen) {
  return createScriptedProvider(({ messages, tools }) => {
    const arm = armOf(tools);
    const names = tools.map((t) => t.function.name);
    const user = messages[1].content;
    const assistant = /你是助手 ([ABC])/.exec(messages[0].content)?.[1];
    const steps = messages.filter((m) => m.role === 'assistant').length;
    if (user.includes('回答格式：')) return { content: 'ANSWER: UNKNOWN' };
    seen.push({ arm, names });
    if (arm === 'P') {
      if (steps === 0) return { tool_calls: [{ name: 'event_note', arguments: { actor: { kind: 'agent', id: `assistant-${assistant.toLowerCase()}` }, text: user, title: '2026 年 11 月搬家' } }] };
      return { content: '记下了。' };
    }
    if (arm === 'T1') {
      if (steps === 0) return { tool_calls: [{ name: 'memory', arguments: { action: 'replace', old_text: '记录：', new_text: '记录：改过' } }] };
      if (steps === 1) return { tool_calls: [{ name: 'memory', arguments: { action: 'add', content: `【待整理】\n关于：【2026 年 11 月搬家】\n记录：\n- 2026-10-05 助手 ${assistant}｜用户原话：「${user}」` } }] };
      return { content: '记下了。' };
    }
    if (steps === 0) return { tool_calls: [{ name: 'notes_str_replace', arguments: { path: 'index.md', old_str: '# 索引', new_str: '# 改过' } }] };
    if (steps === 1) return { tool_calls: [{ name: 'notes_append', arguments: { path: 'index.md', content: `- 搬家：${user}` } }] };
    return { content: '记下了。' };
  });
}

/** The organizer: in P it reads what is new and sets the budget; in T1 and T2 it notes what it was told. */
function organizerModel(told) {
  return createScriptedProvider(({ messages, tools }) => {
    const arm = armOf(tools);
    const user = messages[1].content;
    const steps = messages.filter((m) => m.role === 'assistant').length;
    if (steps === 0) told.push({ arm, user, system: messages[0].content, names: tools.map((t) => t.function.name) });
    if (arm === 'P') {
      if (steps === 0) return { tool_calls: [{ name: 'event_words_since', arguments: { since: /since 填 "([^"]+)"/.exec(user)[1] } }] };
      if (steps === 1) {
        const batch = JSON.parse(lastTool(messages));
        const event = batch.events.find((e) => e.title === '2026 年 11 月搬家');
        const words = event.words.at(-1);
        return {
          tool_calls: [{
            name: 'event_record_expression',
            arguments: {
              eventId: event.id, actor: { kind: 'agent', id: 'organizer' }, accountId: words.id, text: words.text, expectedVersion: event.version,
              set: { state: 'active', facts: { constraint: `预算：${words.text}` } },
            },
          }],
        };
      }
      return { content: '整理了搬家。' };
    }
    return { content: '整理了。' };
  });
}

test('the timeline puts each night after the day\'s conversations, and a probe before the night of its day', () => {
  const kinds = timeline(caseDef, 'organized').map((item) => `${item.kind}:${item.at.date} ${item.at.time}`);
  assert.deepEqual(kinds, [
    'session:2026-10-05 20:00', 'organize:2026-10-05 23:30',
    'session:2026-10-08 12:00', 'probe:2026-10-08 21:00', 'organize:2026-10-08 23:30',
    'probe:2026-10-09 20:00',
  ]);
  assert.deepEqual(timeline(caseDef, 'inline').map((item) => item.kind), ['session', 'session', 'probe', 'probe']);
});

test('the prompts: the light assistants are told they only record; the organizer gets its own instructions', () => {
  const at = { date: '2026-10-05', time: '20:00', assistant: 'A', view: '' };
  const inline = systemPrompt(prompts, 'T1', at);
  const light = systemPrompt(prompts, 'T1', { ...at, mode: 'light' });
  const night = systemPrompt(prompts, 'P', { ...at, time: '23:30', mode: 'organized', role: 'organizer' });
  assert.match(inline, /当场把这件事的现状改好/);
  assert.doesNotMatch(light, /当场把这件事的现状改好/);
  assert.match(light, /只记原话/);
  assert.match(light, /【待整理】/);
  assert.match(night, /你是用户的整理助手/);
  assert.match(night, /"id": "organizer"/);
  assert.match(night, /你是整理助手。/);
  // The instructions every arm shares are the same words in every arm, in each mode.
  for (const mode of ['inline', 'light']) {
    const firsts = ['P', 'T1', 'T2'].map((arm) => systemPrompt(prompts, arm, { ...at, mode }).split('\n\n## 存储')[0]);
    assert.equal(new Set(firsts).size, 1, mode);
  }
  const nights = ['P', 'T1', 'T2'].map((arm) => systemPrompt(prompts, arm, { ...at, mode: 'organized', role: 'organizer' }).split('\n\n## 存储')[0]);
  assert.equal(new Set(nights).size, 1);
});

test('what is new since the last night, in T1 and T2', () => {
  assert.deepEqual(addedEntries(['a', 'b'], ['a', 'b', 'c']), ['c']);
  assert.deepEqual(addedEntries(['a', 'b', 'a'], ['b', 'a', 'c', 'a', 'a']), ['c', 'a']);
  assert.deepEqual(folderChanges({ 'x.md': '# x\n', 'y.md': '# y\n' }, { 'x.md': '# x\n- 新的一行\n', 'y.md': '# y\n', 'z.md': '# z\n' }), [
    { name: 'x.md', kind: 'appended', text: '- 新的一行\n' },
    { name: 'z.md', kind: 'created', text: '# z\n' },
  ]);
});

test('light: in every arm the assistants can only add words', async () => {
  const seen = [];
  const provider = writer(seen);
  for (const arm of ['P', 'T1', 'T2']) {
    const record = await runCase({ caseDef, arm, model: { id: 'scripted' }, rep: 1, provider, library, directory: join(root, `light-${arm}`), prompts, mode: 'light' });
    assert.equal(record.mode, 'light');
    assert.deepEqual(record.conversations.map((c) => c.kind), ['session', 'session', 'probe', 'probe']);
    assert.ok(record.rows.every((row) => row.mode === 'light' && row.nightsBefore === 0));
  }
  const offered = Object.fromEntries(['P', 'T1', 'T2'].map((arm) => [arm, seen.find((s) => s.arm === arm).names]));
  assert.ok(!offered.P.includes('event_record_expression'));
  assert.ok(offered.P.includes('event_note'));
  assert.ok(!offered.T2.includes('notes_str_replace'));
  // T1's replace and T2's replace were refused; what the assistants added is there.
  const entries = JSON.parse(readFileSync(join(root, 'light-T1', 'store', 'entries.json'), 'utf8')).entries;
  assert.ok(!entries.some((e) => e.includes('记录：改过')));
  assert.equal(entries.filter((e) => e.startsWith('【待整理】')).length, 2);
  const index = readFileSync(join(root, 'light-T2', 'store', 'notes', 'index.md'), 'utf8');
  assert.ok(index.startsWith('# 索引'));
  assert.match(index, /- 搬家：搬家预算改成 25000 元。/);
  const conv = JSON.parse(readFileSync(join(root, 'light-T1', 'result.json'), 'utf8')).conversations[0];
  assert.deepEqual(conv.calls.map((c) => [c.tool, Boolean(c.error)]), [['memory:replace', true], ['memory:add', false]]);
});

test('organized: a night with words, told what is new; a probe before the night sees the words unorganized', async () => {
  const told = [];
  const records = [];
  for (const arm of ['P', 'T1', 'T2']) {
    records.push(await runCase({
      caseDef, arm, model: { id: 'scripted' }, rep: 1, provider: writer([]), organizerProvider: organizerModel(told), organizer: 'night',
      library, directory: join(root, `night-${arm}`), prompts, mode: 'organized',
    }));
  }
  for (const record of records) {
    assert.deepEqual(record.conversations.map((c) => `${c.kind}:${c.name}`), ['session:s1', 'organize:o1', 'session:s2', 'probe:q1', 'organize:o2', 'probe:q2']);
    assert.deepEqual(record.nights, { done: 2, skipped: 0 });
    assert.deepEqual(record.rows.map((row) => row.nightsBefore), [1, 2]);
    assert.equal(record.organizer, 'night');
  }
  // P: the organizer is offered its tools and starts after the starting store's words; the second night after the first's.
  const p = told.filter((t) => t.arm === 'P');
  assert.ok(['event_words_since', 'event_record_expression', 'event_add_parent', 'event_note'].every((name) => p[0].names.includes(name)));
  const [since1, since2] = p.map((t) => /since 填 "([^"]+)"/.exec(t.user)[1]);
  assert.ok(since1 < '2026-10-05T12:00:00.000Z', since1);
  // The first night recorded no words of its own, so the second starts after the first session's words.
  assert.ok(since2 >= '2026-10-05T12:00:00.000Z' && since2 < '2026-10-08T04:00:00.000Z', since2);
  // The organizer's change is in the store the second probe read, not in the first probe's copy.
  // (The scripted writer starts a new matter in each session; the latest one is the one the second night changed.)
  const factsOf = (dir) => JSON.parse(readFileSync(join(dir, 'repository.json'), 'utf8')).events.filter((e) => e.event.title === '2026 年 11 月搬家')
    .map((e) => e.event.facts).filter(Boolean).at(-1);
  assert.match(factsOf(join(root, 'night-P', 'probes', 'q1')).constraint, /20000/);
  assert.match(factsOf(join(root, 'night-P', 'probes', 'q2')).constraint, /25000/);
  // T1 and T2: the message holds exactly what was added since the last night.
  const t1 = told.filter((t) => t.arm === 'T1');
  assert.match(t1[0].user, /新增了 1 条/);
  assert.match(t1[1].user, /新增了 1 条：\n\n【待整理】[\s\S]*25000/);
  assert.doesNotMatch(t1[1].user, /20000/);
  const t2 = told.filter((t) => t.arm === 'T2');
  assert.match(t2[1].user, /=== index\.md（末尾追加）===\n- 搬家：搬家预算改成 25000 元。/);
  assert.doesNotMatch(t2[1].user, /20000/);
  assert.ok(t2[0].names.includes('notes_str_replace'), 'the organizer may change any text');
  // The organizer's conversations are counted, by kind.
  const analysis = analyze(records, { draws: 50 });
  const byKind = analysis.perModel.scripted.cost.P.byKind;
  assert.equal(byKind.organize.conversations, 2);
  assert.equal(byKind.session.conversations, 2);
  assert.match(renderReport(analysis), /\| P \| organize \| 2 \|/);
});

test('organized: a night with no new words is skipped', async () => {
  const quiet = { ...caseDef, id: 'quiet', sessions: caseDef.sessions.map((s) => ({ ...s, user: `${s.user}` })) };
  const silent = createScriptedProvider(({ messages }) => (messages[1].content.includes('回答格式：') ? { content: 'ANSWER: UNKNOWN' } : { content: '好的。' }));
  const told = [];
  for (const arm of Object.keys(ARMS)) {
    const record = await runCase({
      caseDef: quiet, arm, model: { id: 'scripted' }, rep: 1, provider: silent, organizerProvider: organizerModel(told), organizer: 'night',
      library, directory: join(root, `quiet-${arm}`), prompts, mode: 'organized',
    });
    assert.deepEqual(record.nights, { done: 0, skipped: 2 }, arm);
    assert.ok(!record.conversations.some((c) => c.kind === 'organize'));
  }
  assert.equal(told.length, 0);
});
