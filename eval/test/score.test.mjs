import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractAnswer, parseNumber, parseNumberRun, probeMessage, reviewEntry, score } from '../lib/score.mjs';

const number = { type: 'number', value: '25000', unit: '元', stale: ['20000', '23000'] };
const outcome = (answer, reply) => score(answer, reply).outcome;

test('the value comes from the last ANSWER line, in its usual dresses', () => {
  assert.equal(extractAnswer('查了一下。\nANSWER: 25000'), '25000');
  assert.equal(extractAnswer('**ANSWER：** 2.5万元'), '2.5万元');
  assert.equal(extractAnswer('ANSWER: 1\n后来改了\nANSWER: `B`'), 'B');
  assert.equal(extractAnswer('- answer: 「两万五」'), '两万五');
  assert.equal(extractAnswer('ANSWER:\n\n23000'), '23000');
  assert.equal(extractAnswer('预算是 25000 元'), undefined);
});

test('numbers in Arabic digits, Chinese numerals and both', () => {
  const cases = { '25000': 25000, '两万五': 25000, '2.5万': 25000, '2万5': 25000, '2万5千': 25000, '两万五千': 25000, '三千五': 3500,
    '三千五百': 3500, '一万二': 12000, '十五': 15, '二十': 20, '一百二十': 120, '一百二': 120, '一万零五': 10005, '1.2k': 1200, '-5': -5, '3w': 30000 };
  for (const [text, value] of Object.entries(cases)) assert.equal(parseNumberRun(text), value, text);
  assert.deepEqual(parseNumber('¥25,000'), { n: 25000, more: false });
  assert.deepEqual(parseNumber('25000（原来是 20000）'), { n: 25000, more: true });
});

test('a number answer: correct, stale or wrong', () => {
  for (const reply of ['ANSWER: 25000', '**ANSWER：** 2.5万元', 'ANSWER: 两万五', 'ANSWER: ¥25,000', 'ANSWER: 25000 元']) assert.equal(outcome(number, reply), 'correct', reply);
  assert.equal(outcome(number, 'ANSWER: 20000'), 'stale');
  assert.equal(outcome(number, 'ANSWER: 23000元'), 'stale');
  assert.equal(outcome(number, 'ANSWER: 30000'), 'wrong');
  const several = score(number, 'ANSWER: 25000（原来是 20000）');
  assert.equal(several.outcome, 'correct');
  assert.equal(several.review, 'several numbers');
});

test('dates, with and without a year', () => {
  const date = { type: 'date', value: '2026-10-03', stale: ['2026-10-01'] };
  assert.equal(outcome(date, 'ANSWER: 2026-10-03'), 'correct');
  assert.equal(outcome(date, 'ANSWER: 2026年10月3日'), 'correct');
  assert.equal(outcome(date, 'ANSWER: 2026/10/3'), 'correct');
  const noYear = score(date, 'ANSWER: 10月3日');
  assert.equal(noYear.outcome, 'correct');
  assert.equal(noYear.method, 'date:no-year-assumed-2026');
  assert.equal(outcome(date, 'ANSWER: 2026-10-01'), 'stale');
  assert.equal(outcome(date, 'ANSWER: 2026-02-30'), 'unparseable');
});

test('options by letter, by its text, and two letters at once', () => {
  const option = { type: 'option', value: 'B', options: { A: '先修好再说', B: '换一台新的', C: '不管它' }, stale: ['A'] };
  for (const reply of ['ANSWER: B', 'ANSWER: （B）', 'ANSWER: B. 换一台新的', 'ANSWER: 选B', 'ANSWER: 换一台新的', 'ANSWER: b']) assert.equal(outcome(option, reply), 'correct', reply);
  assert.equal(outcome(option, 'ANSWER: A'), 'stale');
  assert.equal(outcome(option, 'ANSWER: C'), 'wrong');
  assert.equal(outcome(option, 'ANSWER: B 或 C'), 'wrong');
  assert.equal(outcome(option, 'ANSWER: 都行'), 'unparseable');
});

test('multi-select needs the exact set', () => {
  const multi = { type: 'multi', value: ['A', 'C'], options: { A: '一', B: '二', C: '三', D: '四' } };
  for (const reply of ['ANSWER: ["A", "C"]', 'ANSWER: ["C","A"]', 'ANSWER: A、C', 'ANSWER: A 和 C', "ANSWER: ['A', 'C']"]) assert.equal(outcome(multi, reply), 'correct', reply);
  assert.equal(outcome(multi, 'ANSWER: ["A"]'), 'wrong');
  assert.equal(outcome(multi, 'ANSWER: ["A", "C", "E"]'), 'wrong');
  assert.equal(outcome({ ...multi, value: [] }, 'ANSWER: []'), 'correct');
  assert.equal(outcome({ ...multi, value: [] }, 'ANSWER: 没有'), 'correct');
});

test('provenance: who, which day and whose words, all three', () => {
  const answer = { type: 'provenance', who: 'B', date: '2026-09-26', kind: 'inference' };
  for (const reply of [
    'ANSWER: {"who": "B", "date": "2026-09-26", "kind": "inference"}',
    'ANSWER: ｛"who": "助手 B", "date": "2026年9月26日", "kind": "推测"｝',
    'ANSWER: {“who”: “assistant-b”, “date”: “2026-09-26”, “kind”: “inference”}',
    "ANSWER: {'who': 'B', 'date': '9月26日', 'kind': '助手推测'}",
  ]) assert.equal(outcome(answer, reply), 'correct', reply);
  const wrongDay = score(answer, 'ANSWER: {"who": "B", "date": "2026-09-25", "kind": "inference"}');
  assert.equal(wrongDay.outcome, 'wrong');
  assert.deepEqual(wrongDay.normalized, { who: 'B', date: '2026-09-25', kind: 'inference' });
  assert.equal(outcome(answer, 'ANSWER: {"who": "B", "date": "2026-09-26", "kind": "user"}'), 'wrong');
});

test('UNKNOWN is right only when the store does not hold the answer', () => {
  for (const reply of ['ANSWER: UNKNOWN', 'ANSWER: 不知道', 'ANSWER: 记录里没有。']) {
    assert.equal(outcome(number, reply), 'unknown', reply);
    assert.equal(outcome({ type: 'unknown' }, reply), 'correct', reply);
  }
  assert.equal(outcome({ type: 'unknown' }, 'ANSWER: 25000'), 'wrong');
  assert.equal(outcome({ type: 'unknown', as: 'option', options: { A: 'x', B: 'y' } }, 'ANSWER: A'), 'wrong');
  assert.equal(outcome(number, '我记得是两万五。'), 'unparseable');
});

test('the probe message lists the options and asks for one format', () => {
  const message = probeMessage('哪个方案？', { type: 'option', value: 'A', options: { B: '二', A: '一' } });
  assert.equal(message, '哪个方案？\n\nA. 一\nB. 二\n\n回答格式：最后一行写「ANSWER: 选项字母」，只写一个字母。记录里没有，就写「ANSWER: UNKNOWN」。');
  assert.match(probeMessage('多少？', number), /（单位：元）/);
  assert.equal(probeMessage('多少？', { type: 'unknown' }), probeMessage('多少？', { type: 'number' }), 'an unknown answer does not show in the format');
});

test('a review entry does not tell the arm', () => {
  const entry = reviewEntry({ id: 'r1', question: '预算多少？', answer: number, reply: '我用 event_get_protocol 读了 evt_0151，事情库里写的是两万五。记忆条目里没有。' });
  assert.doesNotMatch(entry.reply, /evt_|event_|事情库|记忆条目/);
});
