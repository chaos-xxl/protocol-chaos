// D7, two assistants writing at once, as a deterministic demonstration rather than a model
// comparison. The same interleaving is replayed against each arm's real tools: A's
// conversation starts and reads the matter; B's conversation changes the budget and ends;
// then A writes its own change. Each cell says whether A's change landed, whether B's
// survived, and whether A was told something was wrong.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import P from './arms/protocol.mjs';
import T1 from './arms/entries.mjs';
import T2 from './arms/files.mjs';
import { readRepository } from './p-writer.mjs';
import { renderEntry } from './render.mjs';
import { writeFileAtomic, writeJson } from './util.mjs';

const MATTER = {
  key: 'trip', title: '2026 年 11 月杭州出差', state: 'active', parent: null,
  facts: { goal: '11 月去杭州出差三天。', constraint: '预算 3000 元；不坐红眼航班。', plan: '11 月 12 日出发。' },
  progress: null,
  accounts: [{ date: '2026-10-20', assistant: 'C', source: 'user', text: '十一月去杭州出差三天，预算 3000，不坐红眼航班，12 号出发。' }],
  organizedBy: { assistant: 'C', date: '2026-10-20' },
};
const B_CONSTRAINT = '预算 3500 元；不坐红眼航班。';
const AT = { date: '2026-10-22', time: '10:00' };

export const SCENARIOS = [
  { id: 'other-part', label: 'A changes another part (the plan)', words: '出差改成 13 号出发。' },
  { id: 'same-part-stale', label: 'A changes the same part, writing the whole value from its first read', words: '出差住公司附近。' },
  { id: 'same-part-passage', label: 'A changes the same part, writing only what it adds, on top of what the store returned', words: '出差住公司附近。' },
  { id: 'whole-matter', label: 'A rewrites the whole matter from its first read', words: '出差住公司附近。' },
];
export const COLUMNS = ['P, version from the first read', 'P, version from the receipt', 'T1', 'T2'];

const fresh = () => mkdtempSync(join(tmpdir(), 'protocol-chaos-d7-'));
const actor = (letter) => ({ kind: 'agent', id: `assistant-${letter.toLowerCase()}` });

/** P: A reads, B changes the budget, A writes. `versionFrom` is 'read' or 'receipt'. */
async function protocolCell(scenario, versionFrom) {
  const dir = fresh();
  try {
    const meta = P.prepare(dir, [MATTER]);
    const a = await P.open(dir, { ...AT, assistant: 'A', meta });
    let told = false;
    let applied = false;
    try {
      const first = JSON.parse((await a.call('event_get_protocol', { eventId: 'evt_0001' })).text);
      const b = await P.open(dir, { ...AT, time: '10:05', assistant: 'B', meta });
      try {
        const note = JSON.parse((await b.call('event_note', { actor: actor('B'), eventId: 'evt_0001', text: '出差预算提到 3500。' })).text);
        await b.call('event_record_expression', {
          eventId: 'evt_0001', actor: actor('B'), accountId: note.accountId, text: '出差预算提到 3500。', expectedVersion: note.version,
          set: { facts: { constraint: B_CONSTRAINT } },
        });
      } finally {
        await b.close();
      }
      const note = JSON.parse((await a.call('event_note', { actor: actor('A'), eventId: 'evt_0001', text: scenario.words })).text);
      const stale = first.event.facts;
      const facts = {
        'other-part': { plan: '11 月 13 日出发。' },
        'same-part-stale': { constraint: stale.constraint.replace(/。$/, '；住公司附近。') },
        'same-part-passage': { constraint: note.facts.constraint.replace(/。$/, '；住公司附近。') },
        'whole-matter': { goal: stale.goal, constraint: stale.constraint.replace(/。$/, '；住公司附近。'), plan: stale.plan },
      }[scenario.id];
      const write = await a.call('event_record_expression', {
        eventId: 'evt_0001', actor: actor('A'), accountId: note.accountId, text: scenario.words,
        expectedVersion: versionFrom === 'read' ? first.event.version : note.version, set: { state: 'active', facts },
      });
      told = write.isError;
      applied = !write.isError;
    } finally {
      await a.close();
    }
    const [after] = readRepository(dir);
    return { applied, kept: after.facts.constraint.includes('3500'), told };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** T1 and T2: A's conversation starts (its snapshot), B changes the budget, A edits from its snapshot. */
async function textCell(scenario, arm) {
  const dir = fresh();
  try {
    arm.prepare(dir, [MATTER]);
    const a = await arm.open(dir, AT);
    const snapshot = renderEntry(MATTER, new Map());
    const b = await arm.open(dir, { ...AT, time: '10:05' });
    const file = '2026年11月杭州出差.md';
    if (arm === T1) await b.call('memory', { action: 'replace', old_text: '预算 3000 元；不坐红眼航班。', new_text: B_CONSTRAINT });
    else await b.call('notes_str_replace', { path: file, old_str: '预算 3000 元；不坐红眼航班。', new_str: B_CONSTRAINT });
    await b.close();
    const calls = {
      'other-part': [['11 月 12 日出发。', '11 月 13 日出发。']],
      'same-part-stale': [['预算 3000 元；不坐红眼航班。', '预算 3000 元；不坐红眼航班；住公司附近。']],
      'same-part-passage': [['不坐红眼航班。', '不坐红眼航班；住公司附近。']],
    }[scenario.id];
    let results = [];
    if (calls) {
      for (const [before, after] of calls) {
        results.push(arm === T1
          ? await a.call('memory', { action: 'replace', old_text: before, new_text: after })
          : await a.call('notes_str_replace', { path: file, old_str: before, new_str: after }));
      }
    } else if (arm === T1) {
      // Rewriting a whole entry: remove it, then add A's version of it, built from the snapshot.
      results = [await a.call('memory', { action: 'remove', old_text: '【2026 年 11 月杭州出差】' }),
        await a.call('memory', { action: 'add', content: snapshot.replace('不坐红眼航班。', '不坐红眼航班；住公司附近。') })];
    } else {
      // T2 has no tool that overwrites a file: creating it again fails, and replacing the whole old text finds nothing.
      results = [await a.call('notes_create', { path: file, content: 'x' }), await a.call('notes_str_replace', { path: file, old_str: '预算 3000 元；不坐红眼航班。\n', new_str: 'x' })];
    }
    await a.close();
    const text = arm.dump(dir);
    return { applied: results.every((r) => !r.isError) && text.includes(scenario.id === 'other-part' ? '13 日出发' : '住公司附近'), kept: text.includes('3500'), told: results.some((r) => r.isError) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function demonstrate() {
  const rows = [];
  for (const scenario of SCENARIOS) {
    rows.push({
      scenario: scenario.id,
      label: scenario.label,
      cells: [await protocolCell(scenario, 'read'), await protocolCell(scenario, 'receipt'), await textCell(scenario, T1), await textCell(scenario, T2)],
    });
  }
  return rows;
}

const cellText = ({ applied, kept, told }) => `A's change ${applied ? 'landed' : 'refused'}${told && !applied ? ' (A told)' : ''}; B's change ${kept ? 'kept' : '**lost**'}`;

export function renderDemonstration(rows) {
  const lines = [
    '# D7: two assistants writing at once',
    '',
    `A's conversation starts and reads the matter. B's conversation then raises the budget from 3000 to 3500 and ends. A then writes its own change. Run against each arm's tools by eval/lib/d7.mjs; no model is involved.`,
    '',
    `| What A does | ${COLUMNS.join(' | ')} |`,
    `|---|${COLUMNS.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.label} | ${row.cells.map(cellText).join(' | ')} |`),
    '',
  ];
  return lines.join('\n');
}

export async function main(values = {}) {
  const rows = await demonstrate();
  const text = renderDemonstration(rows);
  if (values.out) {
    writeFileAtomic(values.out, text);
    writeJson(values.out.replace(/\.md$/, '.json'), rows);
  }
  process.stdout.write(text);
}
