// The matter benchmark (eval/matters): the case and its stores, what each condition shows, the
// generator's requests, the checks, the items and their verdicts, and the report. Scripted models only.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createScriptedProvider } from '../lib/provider.mjs';
import {
  CONDITIONS, EMPTY_BLOCK, checkLeak, checkNeeds, entriesBlock, judge, makeCase, openCondition, parseAdjacent, parseRequests, partitionBlock,
  probesText, readsOf, refillMessage, runItem, statusLine, topTitles, withAncestors, writeStores,
} from '../matters/bench.mjs';
import { extras, renderReport } from '../matters/report.mjs';
import { analyze } from '../selection/report.mjs';

const root = mkdtempSync(join(tmpdir(), 'protocol-chaos-matters-'));
after(() => rmSync(root, { recursive: true, force: true }));

const words = (date, assistant, text) => ({ date, assistant, source: 'user', text });
const matter = (title, state, fields, accounts, parent = null) => ({
  key: title, title, state, parent, facts: fields.facts ?? {}, progress: fields.progress ?? null, accounts, organizedBy: { assistant: accounts.at(-1).assistant, date: accounts.at(-1).date },
});
const matters = [
  matter('2026 年 11 月陪外婆去扬州住三天', 'active', { facts: { plan: '景点两条线：瘦西湖（8000 步）或古城加东关街（13000 步）。' } }, [words('2026-10-05', 'A', '下个月陪外婆去扬州住三天。')], '2026 年陪外婆出门走走'),
  matter('2026 年陪外婆出门走走', 'active', { facts: { goal: '2026 年陪外婆出门玩几次。', constraint: '住的地方要有电梯；每天走路不超过一万五千步。' } }, [words('2026-08-06', 'C', '今年想陪外婆出门走走。')]),
  matter('2026 年 3 月学做麻婆豆腐', 'cancelled', { facts: { goal: '学会做麻婆豆腐。' }, progress: { text: '不学了。', date: '2026-05-12' } }, [words('2026-03-29', 'A', '想学做麻婆豆腐。')]),
  matter('2026 年练攀岩', 'active', { facts: { goal: '能爬 5.10 的线。' } }, [words('2026-06-01', 'B', '今年想练攀岩。')]),
];
const kase = makeCase({
  id: 'test~1', date: '2026-10-19', time: '20:00', matters, own: ['2026 年 11 月陪外婆去扬州住三天'],
  probes: [{ id: 'q1', question: '外婆每天最多走多少步？', answer: { type: 'number', value: '15000', unit: '步', stale: ['10000'] } }],
});
const prompts = {
  assistant: '你是助手。今天是 {date}（{weekday}），{time}。\n\n{memories}',
  generator: '出题。{date} {time}\n{entries}\n{probes}',
  validator: '判断。{date}\n{matters}\n{request}',
  judge: { needs: 'Judge needs. Return {"rating": n, "stale": b, "reasoning": "..."}', leakage: 'Judge leakage. Return {"score": n, "reasoning": "..."}' },
};
const needs = {
  id: 'test~1.needs1', case: 'test~1', kind: 'needs', request: '帮我排一下陪外婆去扬州那三天的行程。',
  matters: ['2026 年 11 月陪外婆去扬州住三天'], facts: ['每天走路不超过一万五千步', '住处要有电梯'], stale: ['每天不超过一万步'],
};
needs.context = withAncestors(needs.matters, kase.byKey);
const adjacent = { id: 'test~1.adjacent1', case: 'test~1', kind: 'adjacent', request: '推荐几本适合老人看的书。', matter: '2026 年 11 月陪外婆去扬州住三天' };
const unrelated = { id: 'test~1.unrelated1', case: 'test~1', kind: 'unrelated', request: '光年是长度单位吗？' };

test('a case puts parents first, and its own matters carry their parents', () => {
  assert.deepEqual(kase.matters.map((m) => m.title).slice(0, 2), ['2026 年陪外婆出门走走', '2026 年 11 月陪外婆去扬州住三天']);
  assert.deepEqual(kase.own.map((m) => m.title), ['2026 年陪外婆出门走走', '2026 年 11 月陪外婆去扬州住三天']);
  assert.deepEqual(needs.context, ['2026 年陪外婆出门走走', '2026 年 11 月陪外婆去扬州住三天']);
});

test('what the prompts show: the current state on one line, entries naming their parent, groups that leave nothing out, the top matters', () => {
  assert.equal(statusLine(kase.byKey.get('2026 年 3 月学做麻婆豆腐')), '【2026 年 3 月学做麻婆豆腐】状态：已取消｜目标：学会做麻婆豆腐。｜进展（2026-05-12）：不学了。');
  const one = entriesBlock([kase.byKey.get('2026 年 11 月陪外婆去扬州住三天')], kase.byKey);
  assert.match(one, /上级：【2026 年陪外婆出门走走】/);
  assert.match(one, /「下个月陪外婆去扬州住三天。」/);
  assert.equal(entriesBlock([], kase.byKey), EMPTY_BLOCK);
  const groups = { personal: ['2026 年陪外婆出门走走', '2026 年 11 月陪外婆去扬州住三天'], health: ['2026 年练攀岩'], schedule: ['2026 年 3 月学做麻婆豆腐'] };
  const block = partitionBlock(kase, groups);
  assert.ok(block.indexOf('### Personal') < block.indexOf('### Health'));
  assert.throws(() => partitionBlock(kase, { personal: ['2026 年练攀岩'] }), /leaves out 3 matters/);
  assert.deepEqual(topTitles({ a: 0.2, b: 0.9, c: 0.2, d: 0.5 }, 3), ['b', 'd', 'a']);
});

test('the probes as the generator reads them; who-said-it probes are left out', () => {
  const text = probesText([
    { question: '走哪条？', answer: { type: 'option', value: 'C', options: { A: '瘦西湖', C: '两条都行' }, stale: ['A'] } },
    { question: '多少步？', answer: { type: 'number', value: '15000', unit: '步', stale: ['10000'] } },
    { question: '哪几件办完了？', answer: { type: 'multi', value: ['A', 'B'], options: { A: '车位', B: '全家福' } } },
    { question: '哪天搬？', answer: { type: 'date', value: '2026-11-22', stale: ['2026-11-15'] } },
    { question: '谁记的？', answer: { type: 'provenance', who: 'C', kind: 'user', date: '2026-09-27' } },
  ]);
  assert.match(text, /答：两条都行\n {2}旧值：瘦西湖/);
  assert.match(text, /答：15000 步\n {2}旧值：10000 步/);
  assert.match(text, /答：车位、全家福/);
  assert.match(text, /答：2026-11-22\n {2}旧值：2026-11-15/);
  assert.doesNotMatch(text, /谁记的/);
});

test('the generator\'s requests are checked against the case', () => {
  const good = {
    needs: [{ request: '帮我排扬州的行程', matters: ['2026年11月陪外婆去扬州住三天'], facts: ['每天不超过一万五千步'], stale: [], why: '要知道步数' }],
    adjacent: [{ request: '推荐书', matter: '2026 年陪外婆出门走走', why: '无关' }, { request: '扬州有什么特产', matter: '2026 年 11 月陪外婆去扬州住三天', why: '无关' }],
  };
  const parsed = parseRequests(`好的：${JSON.stringify(good)}`, kase);
  assert.deepEqual(parsed.needs[0].matters, ['2026 年 11 月陪外婆去扬州住三天']);
  assert.equal(parsed.adjacent.length, 2);
  assert.throws(() => parseRequests(JSON.stringify({ ...good, adjacent: good.adjacent.slice(0, 1) }), kase), /1 adjacent requests/);
  assert.throws(() => parseRequests(JSON.stringify({ ...good, needs: [{ ...good.needs[0], matters: ['2026 年练攀岩'] }] }), kase), /not among the case's/);
  assert.throws(() => parseRequests(JSON.stringify({ ...good, needs: [{ ...good.needs[0], facts: [] }] }), kase), /no facts/);
  const refill = parseAdjacent('{"adjacent": [{"request": "扬州有什么好吃的", "matter": "2026 年 11 月陪外婆去扬州住三天", "why": "只看当地"}]}', kase);
  assert.equal(refill[0].matter, '2026 年 11 月陪外婆去扬州住三天');
  assert.throws(() => parseAdjacent('{"adjacent": []}', kase), /no adjacent/);
  const message = refillMessage({ refill: '再写 {count} 个。{date}\n{entries}\n{rejected}' }, kase, [{ request: '写敬酒词', reason: '细节有帮助' }], 3);
  assert.match(message, /再写 3 个/);
  assert.match(message, /- 请求：写敬酒词\n {2}理由：细节有帮助/);
});

const stores = writeStores(join(root, 'stores'), kase);
const prepared = {
  groups: { personal: kase.matters.slice(0, 2).map((m) => m.title), health: ['2026 年练攀岩'], schedule: ['2026 年 3 月学做麻婆豆腐'] },
  protocolDir: stores.protocolDir, notesDir: stores.notesDir, eventTitles: stores.eventTitles, fileTitles: stores.fileTitles,
  similarities: Object.fromEntries(kase.matters.map((m, i) => [m.title, i / 10])),
};

test('the stores: T2\'s files with index.md, a protocol store, and how files and ids map to titles', () => {
  assert.equal(Object.keys(stores.fileTitles).length, 4);
  assert.equal(Object.keys(stores.eventTitles).length, 4);
  assert.ok(Object.values(stores.eventTitles).includes('2026 年练攀岩'));
  const file = Object.keys(stores.fileTitles).find((n) => stores.fileTitles[n] === '2026 年练攀岩');
  const id = Object.keys(stores.eventTitles).find((n) => stores.eventTitles[n] === '2026 年练攀岩');
  assert.deepEqual(readsOf('files', [{ name: 'notes_view', args: { path: file }, error: null }, { name: 'notes_search', args: { query: 'x' }, error: null }, { name: 'notes_view', args: { path: 'index.md' }, error: null }], prepared).topics, ['2026 年练攀岩']);
  assert.deepEqual(readsOf('protocol', [{ name: 'event_get_protocol', args: { eventId: id }, error: null }, { name: 'event_get_protocol', args: { eventId: 'evt_none' }, error: 'NOT_FOUND' }], prepared).topics, ['2026 年练攀岩']);
  assert.equal(readsOf('flat', [], prepared), null);
});

/** Reads the first matter the map lists, then answers. */
const answerer = () => createScriptedProvider(({ messages, tools }) => {
  const steps = messages.filter((m) => m.role === 'assistant').length;
  if (tools.length && steps === 0) {
    const system = messages[0].content;
    if (tools.some((t) => t.function.name === 'notes_view')) return { tool_calls: [{ name: 'notes_view', arguments: { path: /\]\(([^)]+\.md)\)/.exec(system.split('index.md。')[1])[1] } }] };
    return { tool_calls: [{ name: 'event_get_protocol', arguments: { eventId: /- (evt_[^｜]+)｜/.exec(system)[1] } }] };
  }
  return { content: '这是回答。' };
});
const judgeOf = (rating, score = 1) => createScriptedProvider(({ messages }) => (messages[0].content.includes('Judge needs')
  ? { content: `{"rating": ${rating}, "stale": false, "reasoning": "ok"}` } : { content: `{"score": ${score}, "reasoning": "ok"}` }));

test('every condition answers and is judged, the map conditions read by title, and a stopped item continues', async () => {
  const model = { id: 'scripted' };
  const judgeModel = { id: 'scripted-judge' };
  for (const condition of CONDITIONS) {
    for (const request of [needs, adjacent, unrelated]) {
      const file = join(root, 'items', condition, `${request.id}.json`);
      const record = await runItem({ file, kase, request, condition, model, provider: answerer(), judgeModel, judgeProvider: judgeOf(3), prompts, prepared: { ...prepared, similarities: prepared.similarities } });
      assert.equal(record.epochs.length, request.kind === 'needs' ? 1 : 3, `${condition} ${request.kind}`);
      assert.ok(record.epochs.every((e) => e.ok && e.judgment.ok), `${condition} ${request.kind}`);
      assert.equal(record.type, request.kind === 'needs' ? 'beneficial_memory_usage' : 'cross_domain');
      if (condition === 'files' || condition === 'protocol') assert.equal(record.epochs[0].reads.topics.length, 1, condition);
      if (condition === 'retrieval') assert.equal(record.epochs[0].kept.length, 4);
      if (request.kind === 'needs') assert.equal(record.epochs[0].judgment.stale, false);
    }
  }
  const opened = await openCondition('protocol', kase, needs, prepared);
  try {
    assert.match(opened.block, /共 4 件/);
    assert.deepEqual(opened.store.tools.map((t) => t.function.name).sort(), ['event_get_protocol', 'event_search']);
  } finally {
    await opened.store.close();
  }
  const files = await openCondition('files', kase, needs, prepared);
  assert.deepEqual(files.store.tools.map((t) => t.function.name), ['notes_view', 'notes_search']);
  const flat = JSON.parse(readFileSync(join(root, 'items', 'flat', `${needs.id}.json`), 'utf8'));
  assert.match(flat.epochs[0].messages[0].content, /帮我排一下/);
  // A finished item is not answered again; an epoch left to the infrastructure is.
  const never = createScriptedProvider(() => {
    throw new Error('called');
  });
  const again = await runItem({ file: join(root, 'items', 'flat', `${needs.id}.json`), kase, request: needs, condition: 'flat', model, provider: never, judgeModel, judgeProvider: never, prompts, prepared });
  assert.deepEqual(again, flat);
  const file = join(root, 'items', 'flat', `${adjacent.id}.json`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.epochs[2] = { ok: false, infrastructure: true, error: 'model: 503' };
  writeFileSync(file, JSON.stringify(record));
  const resumed = await runItem({ file, kase, request: adjacent, condition: 'flat', model, provider: answerer(), judgeModel, judgeProvider: judgeOf(3), prompts, prepared });
  assert.ok(resumed.epochs[2].ok && resumed.epochs[2].judgment.ok);
  assert.deepEqual(resumed.epochs[0], record.epochs[0]);
});

test('the needs judge gets the facts and the stale values; an unreadable verdict is reported', async () => {
  let seen;
  const provider = createScriptedProvider(({ messages }) => {
    seen = messages[1].content;
    return { content: '{"rating": "2", "stale": "true", "reasoning": "used the old limit"}' };
  });
  const verdict = await judge({ provider, prompts, kase, request: needs, reply: '每天走一万步以内。' });
  assert.deepEqual([verdict.score, verdict.stale], [2, true]);
  assert.match(seen, /<gold_facts>\n- 每天走路不超过一万五千步/);
  assert.match(seen, /<stale_values>\n- 每天不超过一万步/);
  assert.match(seen, /【2026 年陪外婆出门走走】状态：进行中｜目标/);
  const bad = await judge({ provider: createScriptedProvider(() => ({ content: 'no json' })), prompts, kase, request: adjacent, reply: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.attempts, 3);
});

test('a needs request is kept only if it can be answered with its matters and not without', async () => {
  const blocks = [];
  const provider = createScriptedProvider(({ messages }) => {
    blocks.push(messages[0].content);
    return { content: '回答' };
  });
  const ratings = [3, 1];
  const judgeProvider = createScriptedProvider(() => ({ content: `{"rating": ${ratings.shift()}, "stale": false, "reasoning": "r"}` }));
  const kept = await checkNeeds({ provider, judgeProvider, prompts, kase, request: needs });
  assert.equal(kept.kept, true);
  assert.match(blocks[0], /2026 年陪外婆出门走走/);
  assert.doesNotMatch(blocks[0], /麻婆豆腐/);
  assert.match(blocks[1], /存储里没有事/);
  const both = [3, 3];
  const notNeeded = await checkNeeds({ provider, judgeProvider: createScriptedProvider(() => ({ content: `{"rating": ${both.shift()}, "stale": false, "reasoning": "r"}` })), prompts, kase, request: needs });
  assert.equal(notNeeded.kept, false);
  assert.match(notNeeded.reason, /does not need the store/);
  const leak = await checkLeak({ provider: createScriptedProvider(() => ({ content: '{"helps": false, "matters": [], "reasoning": "无关"}' })), prompts, kase, request: adjacent });
  assert.deepEqual([leak.ok, leak.helps], [true, false]);
  const unreadable = await checkLeak({ provider: createScriptedProvider(() => ({ content: '{"maybe": 1}' })), prompts, kase, request: adjacent });
  assert.equal(unreadable.helps, null);
});

test('the report: rates by kind, stale values, what the maps opened, H4', () => {
  const rec = (condition, request, scores, extra = {}) => ({
    sample: request.id, type: request.kind === 'needs' ? 'beneficial_memory_usage' : 'cross_domain', kind: request.kind, case: 'test~1', condition, model: 'm', judge: 'j',
    epochs: scores.map((score) => ({ ok: true, judgment: { ok: true, score, stale: request.kind === 'needs' ? score < 3 : undefined }, reads: extra.reads ?? null })),
  });
  const reads = (topics) => ({ calls: topics.length, topics, all: false, searches: 0 });
  const records = [
    rec('flat', needs, [2]), rec('flat', adjacent, [1, 3, 1]), rec('flat', unrelated, [1, 1, 1]),
    rec('files', needs, [2], { reads: reads([]) }), rec('files', adjacent, [1, 1, 1], { reads: reads([adjacent.matter]) }), rec('files', unrelated, [1, 1, 1], { reads: reads([]) }),
    rec('protocol', needs, [3], { reads: reads(needs.matters) }), rec('protocol', adjacent, [1, 1, 1], { reads: reads([]) }), rec('protocol', unrelated, [1, 1, 1], { reads: reads([]) }),
  ];
  const analysis = analyze(records, { draws: 200 });
  const more = extras(records, [needs, adjacent, unrelated], { [needs.id]: prepared.similarities });
  assert.equal(more.stale['m|flat'].rate, 1);
  assert.equal(more.byKind['m|flat|adjacent'].rate, 1);
  assert.equal(more.byKind['m|flat|unrelated'].rate, 0);
  assert.equal(more.opened['m|protocol'].needsAll, 1);
  assert.equal(more.opened['m|files'].adjacentOpened, 1);
  assert.equal(more.retrievalCovers.all, 1);
  const text = renderReport(analysis, more, [], [needs, adjacent, unrelated]);
  assert.match(text, /H4, protocol misses less than files: does not hold/);
  assert.match(text, /\| flat \| 50\.0% \(1\/2\)/);
});
