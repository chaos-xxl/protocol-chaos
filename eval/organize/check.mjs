// One fold per case, with a real model: does the organizer's single call (server/organize.mjs)
// write what the new words establish, and leave the rest alone? Each case is a fresh repository
// with one matter as it stands, the new words recorded on it, and one call through foldOne.
//
//   node --env-file=eval/.env.local eval/organize/check.mjs [--model deepseek-flash] [--models eval/models.local.json]
//
// Prints each case's patch, a check, and the tokens. See README.md.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { foldOne } from '../../server/organize.mjs';
import { Store } from '../../server/store.mjs';
import { createProvider } from '../lib/provider.mjs';

const { values } = parseArgs({ options: { model: { type: 'string', default: 'deepseek-flash' }, models: { type: 'string', default: 'eval/models.local.json' } } });
const list = JSON.parse(readFileSync(resolve(values.models), 'utf8'));
const model = (list.models ?? list).find((item) => item.id === values.model);
if (!model) throw new Error(`No model ${values.model} in ${values.models}`);
// One fold should give one answer: temperature 0, as the Hermes plugin asks for its structure update.
const provider = createProvider({ ...model, body: { ...(model.body ?? {}), temperature: 0 } });

const user = { kind: 'agent', id: 'codex' };
const said = '2026-11-16';
// Each case: the matter before (title, fields, earlier words), the new words, and what to check.
const CASES = [
  { name: 'a plan and a budget, from nothing', title: '2026 年冬天搬家', words: '搬家定在 12 月 20 号，预算两万以内',
    check: (e) => /12 月 20|12-20|12月20/.test(e.facts?.plan ?? '') && /两万|20,?000|2 万/.test(e.facts?.constraint ?? '') },
  { name: 'a change of plan replaces the old value', title: '2026 年冬天搬家', facts: { plan: '2026 年 12 月 20 日搬。' }, earlier: ['搬家定在 12 月 20 号'], words: '搬家改到明年 1 月 3 号了',
    check: (e) => /1 月 3|01-03|1月3/.test(e.facts?.plan ?? '') && !/12 月 20|12月20/.test(e.facts?.plan ?? '') },
  { name: 'a booking moves into the plan', title: '2026 年冬天搬家', facts: { plan: '2027 年 1 月 3 日搬。', constraint: '预算两万以内。' }, words: '搬家公司订好了，便宜那家，报价 6800',
    check: (e) => /6800/.test(`${e.facts?.plan ?? ''} ${e.progress?.text ?? ''}`) },
  { name: 'a wish is a constraint', title: '2027 年春天葡萄牙行（和 Mei）', words: '葡萄牙那趟想住在里斯本老城附近',
    check: (e) => /老城/.test(e.facts?.constraint ?? '') && !/老城/.test(e.facts?.plan ?? '') },
  { name: 'once decided, the wish moves to the plan', title: '2027 年春天葡萄牙行（和 Mei）', facts: { constraint: '想住在里斯本老城附近。' }, words: '酒店定了，就是老城那家 Alfama 的民宿',
    check: (e) => /Alfama/.test(e.facts?.plan ?? '') && !/老城/.test(e.facts?.constraint ?? '') },
  { name: 'done, with how it went', title: '2026 年考到驾照', state: 'active', words: '驾照考下来了，科目三一次过',
    check: (e) => e.state === 'done' },
  { name: 'given up', title: '2026 年学大提琴', state: 'active', words: '大提琴不学了，实在没时间',
    check: (e) => ['cancelled', 'dormant'].includes(e.state) },
  { name: 'an episode stays out of a long-lived matter', title: '家里的网络', facts: { goal: '家里网络稳定，能远程连回家。' }, parts: ['2026 年 11 月路由器故障'], words: '今天路由器又坏了，先用手机热点顶着',
    check: (e) => !/热点/.test(`${JSON.stringify(e.facts ?? {})} ${e.progress?.text ?? ''}`) },
  { name: 'a relative date becomes a date', title: '2026 年冬天搬家', words: '下周六先去新房量尺寸',
    check: (e) => /2026|11 月|11月|11-/.test(`${e.facts?.plan ?? ''} ${e.progress?.text ?? ''}`) },
  { name: 'an assistant\'s inference stays marked', title: '2027 年换电车', note: true, words: '推测：用户在认真考虑电车（依据：问了两次试驾流程）',
    check: (e) => !e.facts || /推测/.test(JSON.stringify(e.facts)) },
  { name: 'a question establishes nothing', title: '2027 年春天葡萄牙行（和 Mei）', facts: { plan: '2027 年 4 月去。' }, words: '四月的里斯本冷不冷？',
    check: (e, outcome) => outcome === 'unchanged' },
];

let input = 0;
let output = 0;
let passed = 0;
for (const item of CASES) {
  const data = mkdtempSync(join(tmpdir(), 'protocol-chaos-fold-check-'));
  try {
    const store = new Store(data);
    let eventId;
    let parent;
    if (item.parts) {
      parent = await store.write((repo) => repo.eventNote({ actor: user, text: item.earlier?.[0] ?? item.title, title: item.title }));
      await store.write((repo) => repo.eventNote({ actor: user, text: `${item.parts[0]}，已经修好了`, title: item.parts[0], parentEventId: parent.eventId }));
      eventId = parent.eventId;
    } else {
      const first = await store.write((repo) => repo.eventNote({ actor: user, text: item.earlier?.[0] ?? `我想做这件事：${item.title}`, title: item.title }));
      eventId = first.eventId;
    }
    const before = store.read((repo) => repo.getProtocol({ eventId })).event;
    const set = {};
    if (item.facts) set.facts = item.facts;
    if (item.state && item.state !== before.state) set.state = item.state;
    if (Object.keys(set).length) {
      const firstAccount = store.read((repo) => repo.getProtocol({ eventId })).accounts[0];
      await store.write((repo) => repo.recordExpression({ eventId, actor: user, text: firstAccount.text, accountId: firstAccount.id, expectedVersion: before.version, set }));
    }
    const receipt = await store.write((repo) => repo.eventNote({ eventId, actor: user, text: item.words, accountSource: item.note ? 'agent_response' : 'user' }));
    let usage;
    const ask = async (_directory, _config, instructions, text) => {
      const answer = await provider.complete([{ role: 'system', content: instructions }, { role: 'user', content: text.replace(/said on \d{4}-\d{2}-\d{2}/, `said on ${said}`) }], [], { conversationId: `fold-check-${item.name}` });
      usage = answer.usage;
      return { text: answer.message?.content ?? '', ms: answer.latencyMs, usage };
    };
    const report = await foldOne(data, { agent: 'eval', actor: 'organizer' }, eventId, receipt.accountId, ask);
    const after = store.read((repo) => repo.getProtocol({ eventId })).event;
    const ok = Boolean(item.check(after, report.outcome));
    passed += ok ? 1 : 0;
    input += usage?.input ?? 0;
    output += usage?.output ?? 0;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${item.name}: ${report.outcome}${report.changed ? ` (${report.changed.join(', ')})` : ''}${report.error ? ` ${report.error}` : ''}`);
    console.log(`      words: ${item.words}`);
    console.log(`      after: ${JSON.stringify({ state: after.state, facts: after.facts, progress: after.progress?.text, refs: after.refs })}`);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}
console.log(`\n${passed}/${CASES.length} checks pass; ${input} tokens in, ${output} out (${model.id}).`);
