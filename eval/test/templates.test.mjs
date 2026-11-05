import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandTemplate, scaleCases, substitute } from '../lib/templates.mjs';

const base = () => ({
  id: 'd1-test',
  category: 'D1',
  author: 'test',
  shape: 'a value changed twice',
  keywords: ['搬家'],
  variants: [{ a: '20000', b: '25000' }],
  sessions: [
    { day: 0, assistant: 'A', user: '搬家预算 {a} 元。' },
    { day: 2, time: '09:15', assistant: 'B', user: '搬家预算改成 {b} 元。' },
  ],
  probes: [{ day: 3, assistant: 'C', question: '搬家预算多少？', answer: { type: 'number', value: '{b}', unit: '元', stale: ['{a}'] } }],
});

test('a variant becomes a case with dates, gold answers and the default library', () => {
  const [c] = expandTemplate(base(), { split: 'dev' });
  assert.equal(c.id, 'd1-test~1');
  assert.equal(c.library, 150);
  assert.deepEqual(c.sessions.map((s) => [s.date, s.time, s.assistant, s.user]), [
    ['2026-10-05', '20:00', 'A', '搬家预算 20000 元。'], ['2026-10-07', '09:15', 'B', '搬家预算改成 25000 元。'],
  ]);
  assert.deepEqual(c.probes[0].answer, { type: 'number', value: '25000', unit: '元', stale: ['20000'] });
  assert.equal(expandTemplate({ ...base(), category: 'N1' }, { split: 'dev' })[0].library, 10);
});

test('placeholders: a missing value is an error, double braces are literal', () => {
  assert.equal(substitute('{{x}} {a}', { a: 1 }, 'w'), '{x} 1');
  assert.throws(() => substitute('{nope}', {}, 'here'), /no value for \{nope\}/);
});

test('templates that cannot give a fair case are refused', () => {
  const broken = [
    [(t) => { t.category = 'D9'; }, /category/],
    [(t) => { t.keywords = ['露营']; }, /keyword 露营 appears in no session/],
    [(t) => { t.probes[0].day = 1; }, /after the last session/],
    [(t) => { t.sessions[1].day = -1; }, /day must be/],
    [(t) => { t.sessions[1].time = '07:00'; }, /between 08:00 and 23:59/],
    [(t) => { t.probes[0].answer = { type: 'option', value: 'C', options: { A: 'x', B: 'y' } }; }, /one of the option letters/],
    [(t) => { t.probes[0].answer = { type: 'number', value: '1', stale: ['1'] }; }, /stale value equals the answer/],
    [(t) => { t.probes[0].answer = { type: 'provenance', who: 'D', day: 1, kind: 'user' }; }, /who must be/],
    [(t) => { t.seed = [{ key: 'x', title: '旧事', state: 'active', accounts: [{ day: -2, assistant: 'A', text: '搬家' }] }]; }, /nobody organized is emerging/],
    [(t) => { t.seed = [{ key: 'x', title: '旧事', state: 'emerging', accounts: [{ day: 0, assistant: 'A', text: '搬家' }] }]; }, /at most -1/],
  ];
  for (const [change, message] of broken) {
    const t = base();
    change(t);
    assert.throws(() => expandTemplate(t, { split: 'dev' }), message);
  }
});

test('seeds become canonical matters, parts after their parent', () => {
  const t = base();
  t.seed = [
    { key: 'year', title: '2026 年换个大房子', state: 'active', facts: { constraint: '总价 300 万以内。' },
      accounts: [{ day: -60, assistant: 'C', text: '今年想换个大房子，总价 300 万以内。' }], organizedBy: { assistant: 'C', day: -60 } },
    { key: 'move', title: '2026 年 11 月搬家', parent: 'year', state: 'emerging', accounts: [{ day: -3, assistant: 'A', source: 'agent_response', text: '推测：要搬家（依据：用户在看房）。' }] },
  ];
  const [c] = expandTemplate(t, { split: 'dev' });
  assert.deepEqual(c.seeds.map((s) => [s.key, s.parent, s.accounts[0].date]), [['seed-year', null, '2026-08-06'], ['seed-move', 'seed-year', '2026-10-02']]);
  t.seed[1].accounts[0].day = -70;
  assert.throws(() => expandTemplate(t, { split: 'dev' }), /must not be older than its parent/);
});

test('the scale contrast copies a fixed choice of cases with smaller libraries', () => {
  const cases = Array.from({ length: 30 }, (_, i) => ({ id: `d1-t${String(i).padStart(2, '0')}~1`, category: 'D1', library: 150 }));
  const scaled = scaleCases(cases, { categories: ['D1'], sizes: [10, 50], perCategory: 16 });
  assert.equal(scaled.length, 32);
  assert.ok(scaled.every((c) => c.scale && /@(10|50)$/.test(c.id)));
  assert.deepEqual(scaleCases(cases, { categories: ['D1'], perCategory: 16 }), scaled);
});
