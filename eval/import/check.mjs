// One import of invented memory files, with a real model: does the importer's call per part
// (server/memories.mjs) find the matters the notes show, grouped as the user would, and leave
// out who the user is and how an assistant should work? The notes are invented; every check is
// written with them. The writing itself (only matters resting on sentences of the notes, parents
// first, the facts) is the importer's code, run here as it runs in the background.
//
//   node --env-file=eval/.env.local eval/import/check.mjs [--model deepseek-flash] [--models eval/models.local.json]
//
// Prints what was written, each check, and the tokens. See README.md.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyExtraction, IMPORT_INSTRUCTIONS, partInput, planImport } from '../../server/memories.mjs';
import { jsonObject } from '../../server/organize.mjs';
import { Store } from '../../server/store.mjs';
import { createProvider } from '../lib/provider.mjs';

const { values } = parseArgs({ options: { model: { type: 'string', default: 'deepseek-flash' }, models: { type: 'string', default: 'eval/models.local.json' } } });
const list = JSON.parse(readFileSync(resolve(values.models), 'utf8'));
const model = (list.models ?? list).find((item) => item.id === values.model);
if (!model) throw new Error(`No model ${values.model} in ${values.models}`);
const provider = createProvider({ ...model, body: { ...(model.body ?? {}), temperature: 0 } });

// Invented notes, as three assistants keep them.
const NOTES = {
  '.claude/projects/-home-sam/memory/user-profile.md': `---
name: user-profile
description: who Sam is and what Sam is working towards
---

Sam was born in 1994, lives in Hangzhou and works as a product designer.
Sam prefers short answers with the conclusion first.

Long-term goal: financial independence by 40. Sam puts 3,000 yuan a month into an index fund, and is building a sailing app on weekends as a second income; the app is paused until the spring.
`,
  '.hermes/memories/MEMORY.md': [
    'Sam is planning a week in Lisbon with Mei in spring 2027, budget 15,000 yuan, and would like to stay near the old town.',
    'Sam started learning the cello in March 2026 and has paused it since October: no time.',
    'Always answer in Chinese unless Sam writes in English.',
  ].join('\n§\n'),
  '.kiro/steering/notes.md': `# 关于 Sam

打算 2026 年冬天搬家，预算两万以内，新家离公司近一点。
新房装修已经做完了，预算 30 万，最后花了 35 万。
写方案时先给结论，再给理由。
`,
};

// The long-term goal's title, in either language. 财务独立 was added after the first run (README.md, Changes).
const AIM = /financial independence|财务自由|财务独立/i;
const CHECKS = [
  ['the Lisbon trip, with its budget', (events) => events.some((e) => /Lisbon|里斯本|葡萄牙/i.test(e.title) && /15,?000|一万五|1\.5 ?万/.test(JSON.stringify(e.facts ?? {})))],
  ['financial independence, as a matter', (events) => events.some((e) => AIM.test(e.title))],
  ['a part of it under it (the fund or the app)', (events) => {
    const aim = events.find((e) => AIM.test(e.title));
    return Boolean(aim) && events.some((e) => e.parents.includes(aim.id));
  }],
  ['the cello, set aside', (events) => events.some((e) => /cello|大提琴/i.test(e.title) && ['dormant', 'waiting'].includes(e.state))],
  ['the move, with its budget', (events) => events.some((e) => /搬家|move/i.test(e.title) && /两万|20,?000/.test(JSON.stringify(e.facts ?? {})))],
  ['the renovation, done', (events) => events.some((e) => /装修|renovat/i.test(e.title) && e.state === 'done')],
  ['nothing about who Sam is or how to answer', (events) => !events.some((e) => /1994|Hangzhou|杭州|designer|设计师|short answers|简短|Chinese|中文|结论/i.test(e.title))],
];

const home = mkdtempSync(join(tmpdir(), 'protocol-chaos-import-check-'));
try {
  for (const [file, text] of Object.entries(NOTES)) {
    mkdirSync(dirname(join(home, file)), { recursive: true });
    writeFileSync(join(home, file), text);
  }
  const data = join(home, '.protocol-chaos');
  mkdirSync(data);
  const env = { HOME: home };
  const plan = planImport(env, data);
  const store = new Store(data);
  let input = 0;
  let output = 0;
  let dropped = 0;
  for (const [index, chunk] of plan.chunks.entries()) {
    const entries = store.read((repo) => repo.contextPack({}).events);
    const text = partInput(chunk, index, plan.chunks.length, entries, new Date('2026-11-18T09:00:00Z'));
    const answer = await provider.complete([{ role: 'system', content: IMPORT_INSTRUCTIONS }, { role: 'user', content: text }], [], { conversationId: `import-check-${index}` });
    input += answer.usage?.input ?? 0;
    output += answer.usage?.output ?? 0;
    const parsed = jsonObject(answer.message?.content ?? '');
    if (!parsed) console.log(`part ${index + 1}: the answer held no JSON object:\n${answer.message?.content}`);
    const result = await applyExtraction(store, chunk, parsed, { runId: 'check' });
    dropped += result.dropped;
  }
  const events = store.read((repo) => repo.contextPack({}).events).map((entry) => store.read((repo) => repo.getProtocol({ eventId: entry.id, accounts: 'all' })))
    .map(({ event, accounts }) => ({ ...event, accounts }));
  for (const event of events) {
    const parent = events.find((other) => event.parents.includes(other.id));
    console.log(`- ${event.title} [${event.state}]${parent ? ` (part of ${parent.title})` : ''}`);
    console.log(`    facts: ${JSON.stringify(event.facts ?? {})}${event.progress ? `  progress: ${event.progress.text}` : ''}`);
    console.log(`    from: ${event.accounts.map((account) => `${account.via}: ${account.text.replace(/\n/g, ' / ')}`).join(' | ')}`);
  }
  let passed = 0;
  for (const [name, check] of CHECKS) {
    const ok = Boolean(check(events));
    passed += ok ? 1 : 0;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(`\n${passed}/${CHECKS.length} checks pass; ${plan.chunks.length} part(s), ${events.length} matters, ${dropped} left out for want of a sentence of the notes; ${input} tokens in, ${output} out (${model.id}); the plan estimated ${plan.estimate.tokens}.`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
