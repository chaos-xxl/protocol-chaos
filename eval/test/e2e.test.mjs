// A whole case in all three arms with a scripted model that knows the answers: P answers
// right, T1 gives the old value, T2 says it does not know. Checks the plumbing from the
// starting store to the report, not the arms.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runCase } from '../lib/case.mjs';
import { generateLibrary } from '../lib/library.mjs';
import { loadPrompts } from '../lib/prompts.mjs';
import { createScriptedProvider } from '../lib/provider.mjs';
import { pilotAnalysis, renderPilot } from '../lib/pilot.mjs';
import { analyze, renderReport } from '../lib/report.mjs';
import { expandTemplate } from '../lib/templates.mjs';
import { readRepository } from '../lib/p-writer.mjs';

const root = mkdtempSync(join(tmpdir(), 'protocol-chaos-e2e-'));
after(() => rmSync(root, { recursive: true, force: true }));

const template = {
  id: 'd1-e2e', category: 'D1', author: 'test', shape: 'a value changed twice', keywords: ['搬家'], library: 10,
  variants: [{ a: '20000', b: '25000' }],
  sessions: [
    { day: 0, assistant: 'A', user: '下个月搬家，预算 {a} 元。' },
    { day: 3, assistant: 'B', user: '搬家预算改成 {b} 元。' },
  ],
  probes: [
    { day: 5, assistant: 'C', question: '搬家预算多少？', answer: { type: 'number', value: '{b}', unit: '元', stale: ['{a}'] } },
    { day: 5, time: '21:00', assistant: 'A', question: '搬家预算现在是多少？', answer: { type: 'number', value: '{b}', unit: '元', stale: ['{a}'] } },
  ],
};

const armOf = (tools) => {
  const names = tools.map((t) => t.function.name);
  return names.includes('event_note') ? 'P' : names.includes('memory') ? 'T1' : 'T2';
};

/** Writes each message with the arm's own tools; answers probes by arm. In T2 the first probe also writes a file. */
const provider = createScriptedProvider(({ messages, tools }) => {
  const arm = armOf(tools);
  const user = messages[1].content;
  const assistant = /你是助手 ([ABC])/.exec(messages[0].content)[1];
  const steps = messages.filter((m) => m.role === 'assistant').length;
  if (user.includes('回答格式：')) {
    if (arm === 'T2' && steps === 0 && user.startsWith('搬家预算多少')) return { tool_calls: [{ name: 'notes_create', arguments: { path: '探针写的.md', content: '# 探针' } }] };
    if (arm === 'P') return { content: '查了。\nANSWER: 25000' };
    if (arm === 'T1') return { content: 'ANSWER: 20000 元' };
    return { content: 'ANSWER: UNKNOWN' };
  }
  if (steps > 0) return { content: '记下了。' };
  if (arm === 'P') return { tool_calls: [{ name: 'event_note', arguments: { actor: { kind: 'agent', id: `assistant-${assistant.toLowerCase()}` }, text: user, title: '2026 年 11 月搬家' } }] };
  if (arm === 'T1') return { tool_calls: [{ name: 'memory', arguments: { action: 'add', content: `【搬家】\n记录：\n- 助手 ${assistant}｜用户原话：「${user}」` } }] };
  return { tool_calls: [{ name: 'notes_append', arguments: { path: 'index.md', content: `- 搬家：${user}` } }] };
});

test('a case runs in every arm, each probe on its own copy, and the report counts it', async () => {
  const [caseDef] = expandTemplate(template, { split: 'dev' });
  const library = generateLibrary({ reserved: template.keywords });
  const prompts = loadPrompts();
  const model = { id: 'scripted' };
  const records = [];
  for (const arm of ['P', 'T1', 'T2']) {
    records.push(await runCase({ caseDef, arm, model, rep: 1, provider, library, directory: join(root, arm), prompts }));
  }
  const outcomes = Object.fromEntries(records.map((r) => [r.arm, r.rows.map((row) => row.outcome)]));
  assert.deepEqual(outcomes, { P: ['correct', 'correct'], T1: ['stale', 'stale'], T2: ['unknown', 'unknown'] });
  for (const record of records) {
    assert.equal(record.conversations.length, 4);
    assert.ok(record.conversations.every((c) => c.ok), JSON.stringify(record.conversations.map((c) => c.error)));
    assert.equal(readdirSync(join(root, record.arm, 'conversations')).length, 4);
  }
  // The P server recorded each message at its simulated date, by its assistant.
  const moving = readRepository(join(root, 'P', 'store')).filter((m) => m.title === '2026 年 11 月搬家');
  assert.deepEqual(moving.flatMap((m) => m.accounts.map((a) => [a.date, a.assistant])), [['2026-10-05', 'A'], ['2026-10-08', 'B']]);
  // The file the first probe wrote is in its copy only.
  assert.ok(existsSync(join(root, 'T2', 'probes', 'q1', 'notes', '探针写的.md')));
  assert.ok(!existsSync(join(root, 'T2', 'probes', 'q2', 'notes', '探针写的.md')));
  assert.ok(!existsSync(join(root, 'T2', 'store', 'notes', '探针写的.md')));

  const analysis = analyze(records, { draws: 200 });
  const table = analysis.perModel.scripted.table.D1;
  assert.deepEqual([table.P.correct, table.T1.stale, table.T2.unknown], [2, 2, 2]);
  assert.equal(analysis.perModel.scripted.primary.comparisons[0].diff, 1);
  assert.match(renderReport(analysis), /\| D1 \| P \| 2 \| 2 \| 0 \| 0 \| 0 \| 0 \| 0 \| 100\.0% \|/);

  // The blind report pools the arms: two of six answers right, and nothing by arm but how the conversations went.
  const pilot = pilotAnalysis(records);
  const m = pilot.perModel.scripted;
  assert.deepEqual([m.pooled.rows, m.pooled.correct, m.pooled.stale, m.pooled.unknown], [6, 2, 2, 2]);
  assert.equal(m.mechanics.P.sessions.tools['event_note:new'], 2);
  assert.equal(m.mechanics.T1.sessions.tools['memory:add'], 2);
  assert.equal(m.mechanics.T2.sessions.tools['notes_append:index'], 2);
  assert.equal(m.mechanics.T2.probes.tools.notes_create, 1);
  for (const arm of ['P', 'T1', 'T2']) {
    const text = JSON.stringify(m.mechanics[arm]);
    assert.ok(!/"(correct|stale|wrong|unknown|accuracy)"/.test(text), `no outcome by arm in ${arm}`);
  }
  const md = renderPilot(pilot);
  assert.match(md, /\| D1 \| 1 \| 6 \| 2 \| 2 \| 0 \| 2 \| 0 \| 0 \| 33\.3% \|/);
  assert.ok(!/P vs|\| P \| \d+ \| \d+ \| \d+ \| \d+ \| \d+ \| \d+ \| [\d.]+% \|/.test(md));
});
