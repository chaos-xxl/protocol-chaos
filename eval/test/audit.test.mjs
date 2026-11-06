// The store audit on stores whose content is known: a scripted model writes one case in every
// arm, and each measure must come out as the stores were written.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { auditCaseRun, clausesOf, normalize, numbersIn, wordsOfRecord } from '../lib/audit.mjs';
import { runCase } from '../lib/case.mjs';
import { generateLibrary } from '../lib/library.mjs';
import { loadPrompts } from '../lib/prompts.mjs';
import { createScriptedProvider } from '../lib/provider.mjs';
import { expandTemplate } from '../lib/templates.mjs';

const root = mkdtempSync(join(tmpdir(), 'protocol-chaos-audit-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('clauses: questions and fragments left out; numbers with 万 and commas', () => {
  assert.deepEqual(clausesOf('对了，新家想换个沙发，预算 5000 左右。要是下雨，是不是得改期？'), ['新家想换个沙发', '预算5000左右']);
  assert.equal(normalize('「预算 2 万」'), '预算2万');
  assert.deepEqual(numbersIn('预算 2.4万，报价 6,800 元，每晚 800'), [24000, 6800, 800]);
  assert.deepEqual(numbersIn('每天走路不超过一万五千步'), [15000]);
  assert.equal(wordsOfRecord('- 2026-10-05 助手 A｜用户原话：「下个月搬家。」（问句未记）'), '下个月搬家。');
  assert.equal(wordsOfRecord('- 2026-10-05，助手 A：用户原话"下个月搬家。"'), '下个月搬家。');
  assert.equal(wordsOfRecord('- 2026-10-05 助手 A 记下（用户原话）：下个月搬家。'), '下个月搬家。');
});

test('record lines in the forms the models wrote: with or without the colon, and an assistant\'s note that mentions the person\'s words', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const [caseDef] = expandTemplate(template, { split: 'dev' });
  const library = generateLibrary({ reserved: template.keywords });
  const dir = join(root, 'T1-forms');
  const T1 = (await import('../lib/arms/entries.mjs')).default;
  T1.prepare(dir, [...library.slice(0, caseDef.library), ...caseDef.seeds]);
  const entries = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'entries.json'), 'utf8')).entries;
  entries.push('【2026 年 11 月搬家】\n条件：预算 25000 元。\n记录：\n- 2026-10-05 助手 A：用户原话「下个月搬家，预算 20000 元。」\n- 2026-10-08 助手 B｜助手记下（推测）：按用户原话里的说法，预算可能还会变。');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'entries.json'), JSON.stringify({ entries }));
  const out = auditCaseRun({ caseDef, arm: 'T1', storeDir: dir, library });
  assert.deepEqual([out.userRecords, out.unsaid], [1, 0]);
  assert.equal(out.attributed, 2, 'both clauses of the first message are attributed to A on 2026-10-05');
});

const template = {
  id: 'd1-audit', category: 'D1', author: 'test', shape: 'a value changed once', keywords: ['搬家'], library: 10,
  variants: [{ a: '20000', b: '25000' }],
  sessions: [
    { day: 0, assistant: 'A', user: '下个月搬家，预算 {a} 元。' },
    { day: 3, assistant: 'B', user: '搬家预算改成 {b} 元。' },
  ],
  probes: [{ day: 5, assistant: 'C', question: '搬家预算多少？', answer: { type: 'number', value: '{b}', unit: '元', stale: ['{a}'] } }],
};
const armOf = (tools) => {
  const names = tools.map((t) => t.function.name);
  return names.includes('event_note') ? 'P' : names.includes('memory') ? 'T1' : 'T2';
};
// P records the words and the budget; T1 keeps the words but dates nothing and rewrites the second
// message; T2 writes everything into index.md, so nothing is attributed and no matter is added.
const provider = createScriptedProvider(({ messages, tools }) => {
  const arm = armOf(tools);
  const user = messages[1].content;
  const assistant = /你是助手 ([ABC])/.exec(messages[0].content)[1];
  const steps = messages.filter((m) => m.role === 'assistant').length;
  if (user.includes('回答格式：') || steps > 0) return { content: '好。\nANSWER: 25000' };
  const budget = /(\d+) 元/.exec(user)[1];
  if (arm === 'P') {
    if (user.startsWith('下个月')) return { tool_calls: [{ name: 'event_note', arguments: { actor: { kind: 'agent', id: `assistant-${assistant.toLowerCase()}` }, text: user, title: '2026 年 11 月搬家' } }] };
    return { tool_calls: [{ name: 'event_note', arguments: { actor: { kind: 'agent', id: `assistant-${assistant.toLowerCase()}` }, text: user, eventId: 'evt_0011' } }] };
  }
  if (arm === 'T1') {
    if (user.startsWith('下个月')) return { tool_calls: [{ name: 'memory', arguments: { action: 'add', content: `【搬家】\n条件：预算 ${budget} 元。\n记录：\n- 助手 ${assistant}｜用户原话：「${user}」` } }] };
    return { tool_calls: [{ name: 'memory', arguments: { action: 'replace', old_text: '条件：预算 20000 元。', new_text: `条件：预算 ${budget} 元。\n记录补记：用户说预算改了` } }] };
  }
  return { tool_calls: [{ name: 'notes_append', arguments: { path: 'index.md', content: `- 搬家：${user}` } }] };
});

test('each measure comes out as the stores were written', async () => {
  const [caseDef] = expandTemplate(template, { split: 'dev' });
  const library = generateLibrary({ reserved: template.keywords });
  const out = {};
  for (const arm of ['P', 'T1', 'T2']) {
    const directory = join(root, arm);
    await runCase({ caseDef, arm, model: { id: 'scripted' }, rep: 1, provider, library, directory, prompts: loadPrompts() });
    out[arm] = auditCaseRun({ caseDef, arm, storeDir: join(directory, 'store'), library });
  }
  // Clauses: 下个月搬家, 预算20000元, 搬家预算改成25000元.
  assert.deepEqual([out.P.clauses, out.P.kept, out.P.attributed], [3, 3, 3]);
  assert.deepEqual([out.T1.kept, out.T1.attributed], [2, 0], 'the second message is not in T1, and no record has a date');
  assert.deepEqual([out.T2.kept, out.T2.attributed], [3, 0]);
  for (const arm of ['P', 'T1', 'T2']) {
    assert.equal(out[arm].libraryKept, out[arm].libraryAccounts, `${arm} kept the background history`);
  }
  assert.deepEqual([out.P.userRecords, out.P.unsaid], [2, 0]);
  assert.deepEqual([out.T1.userRecords, out.T1.unsaid], [1, 0], 'the rewritten line is not marked as the person\'s words');
  assert.deepEqual([out.P.added, out.T1.added, out.T2.added], [1, 1, 0]);
  // P recorded words only, so its current state has no number; T1's has the new budget.
  assert.deepEqual([out.P.latestInState, out.T1.latestInState, out.T2.latestInState], [0, 1, 0]);
});
