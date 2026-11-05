import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beatsAll, categoryTable, holm, mcnemarExact, nonInferiority, paired, repAgreement } from '../lib/stats.mjs';
import { random } from '../lib/util.mjs';

/** Rows for `templates` templates of `perTemplate` items, each arm correct with its probability. */
function rows({ templates = 40, perTemplate = 4, reps = 2, accuracy = { P: 0.8, T1: 0.6, T2: 0.6 }, seed = 3, category = 'D1', copies = 1 }) {
  const r = random(seed);
  const out = [];
  for (let t = 0; t < templates; t += 1) {
    const base = r() * 0.3 - 0.15; // templates differ in difficulty
    for (let i = 0; i < perTemplate; i += 1) {
      for (let rep = 1; rep <= reps; rep += 1) {
        const draws = Object.fromEntries(Object.keys(accuracy).map((arm) => [arm, r() < accuracy[arm] + base]));
        for (let copy = 0; copy < copies; copy += 1) {
          for (const [arm, ok] of Object.entries(draws)) {
            out.push({ model: 'm', rep, template: `t${t}`, case: `t${t}~${i}#${copy}`, probe: 'q1', category, arm, outcome: ok ? 'correct' : 'wrong' });
          }
        }
      }
    }
  }
  return out;
}

test('McNemar exact p-values', () => {
  assert.ok(Math.abs(mcnemarExact(10, 2) - 0.03857) < 1e-4);
  assert.equal(mcnemarExact(5, 5), 1);
  assert.equal(mcnemarExact(0, 0), 1);
  assert.equal(mcnemarExact(6, 0), 0.03125);
});

test('Holm keeps the order and the shape', () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03]).map((p) => Number(p.toFixed(6))), [0.03, 0.06, 0.06]);
  const named = holm({ a: 0.01, b: 0.04, c: 0.03 });
  assert.deepEqual(Object.keys(named), ['a', 'b', 'c']);
  assert.equal(Number(named.b.toFixed(6)), 0.06);
  assert.equal(holm([0.9, 0.8])[0], 1);
});

test('a clear difference: small p and an interval above zero', () => {
  const data = rows({ accuracy: { P: 0.85, T1: 0.55, T2: 0.6 } });
  const c = paired(data, { model: 'm', armA: 'P', armB: 'T1', draws: 4000 });
  assert.equal(c.templates, 40);
  assert.equal(c.n, 160);
  assert.ok(c.diff > 0.15, `diff ${c.diff}`);
  assert.ok(c.ci95[0] > 0, `interval ${c.ci95}`);
  assert.ok(c.pOneSided < 0.01, `p ${c.pOneSided}`);
  assert.equal(c.mcnemar.length, 2);
  const both = beatsAll(data, { model: 'm', draws: 4000 });
  assert.equal(both.significant, true);
  assert.equal(both.p, Math.max(...both.comparisons.map((x) => x.pOneSided)));
});

test('no difference: p near one half and an interval around zero', () => {
  const data = rows({ accuracy: { P: 0.6, T1: 0.6, T2: 0.6 }, seed: 11 });
  const c = paired(data, { model: 'm', armA: 'P', armB: 'T1', draws: 4000 });
  assert.ok(c.ci95[0] < 0 && c.ci95[1] > 0, `interval ${c.ci95}`);
  assert.ok(c.pOneSided > 0.05, `p ${c.pOneSided}`);
});

test('beating one text arm is not enough', () => {
  const data = rows({ accuracy: { P: 0.85, T1: 0.55, T2: 0.85 }, seed: 5 });
  const both = beatsAll(data, { model: 'm', draws: 4000 });
  assert.equal(both.significant, false);
});

test('copies inside a template add no information: the interval barely narrows', () => {
  const once = paired(rows({ templates: 30, accuracy: { P: 0.7, T1: 0.6 }, seed: 9 }), { model: 'm', armA: 'P', armB: 'T1', draws: 4000 });
  const tenfold = paired(rows({ templates: 30, accuracy: { P: 0.7, T1: 0.6 }, seed: 9, copies: 10 }), { model: 'm', armA: 'P', armB: 'T1', draws: 4000 });
  const width = (c) => c.ci95[1] - c.ci95[0];
  assert.ok(Math.abs(tenfold.diff - once.diff) < 1e-9);
  assert.ok(width(tenfold) > 0.8 * width(once), `widths ${width(once)} and ${width(tenfold)}`);
});

test('with few templates the sign-flip test is exact, and close to the sampled one', () => {
  const data = rows({ templates: 12, perTemplate: 6, accuracy: { P: 0.8, T1: 0.55 }, seed: 21 });
  const exact = paired(data, { model: 'm', armA: 'P', armB: 'T1', draws: 2000 });
  assert.equal(exact.exact, true);
  const more = rows({ templates: 17, perTemplate: 6, accuracy: { P: 0.8, T1: 0.55 }, seed: 21 });
  assert.equal(paired(more, { model: 'm', armA: 'P', armB: 'T1', draws: 2000 }).exact, false);
});

test('the same seed gives the same numbers', () => {
  const data = rows({});
  assert.deepEqual(paired(data, { model: 'm', armA: 'P', armB: 'T1', draws: 2000, seed: 4 }), paired(data, { model: 'm', armA: 'P', armB: 'T1', draws: 2000, seed: 4 }));
});

test('failures and unreadable answers score zero', () => {
  const data = [
    { model: 'm', rep: 1, template: 't', case: 'c1', probe: 'q1', category: 'N1', arm: 'P', outcome: 'failed' },
    { model: 'm', rep: 1, template: 't', case: 'c1', probe: 'q1', category: 'N1', arm: 'T1', outcome: 'correct' },
    { model: 'm', rep: 1, template: 't', case: 'c2', probe: 'q1', category: 'N1', arm: 'P', outcome: 'unparseable' },
    { model: 'm', rep: 1, template: 't', case: 'c2', probe: 'q1', category: 'N1', arm: 'T1', outcome: 'correct' },
  ];
  const c = paired(data, { model: 'm', armA: 'P', armB: 'T1', draws: 100 });
  assert.equal(c.meanA, 0);
  assert.equal(c.meanB, 1);
  const table = categoryTable(data, { model: 'm', arms: ['P', 'T1'], categories: ['N1'] });
  assert.equal(table.N1.P.failed, 1);
  assert.equal(table.N1.P.unparseable, 1);
});

test('no worse: equal arms pass a 10-point margin, a 20-point gap does not', () => {
  const equal = rows({ templates: 40, perTemplate: 3, accuracy: { P: 0.9, T1: 0.9 }, seed: 13, category: 'N1' });
  assert.equal(nonInferiority(equal, { model: 'm', armA: 'P', armB: 'T1', categories: ['N1'], draws: 4000 }).nonInferior, true);
  const worse = rows({ templates: 40, perTemplate: 3, accuracy: { P: 0.7, T1: 0.9 }, seed: 13, category: 'N1' });
  assert.equal(nonInferiority(worse, { model: 'm', armA: 'P', armB: 'T1', categories: ['N1'], draws: 4000 }).nonInferior, false);
});

test('repetitions that disagree are counted', () => {
  const data = [
    { model: 'm', rep: 1, template: 't', case: 'c', probe: 'q1', category: 'D1', arm: 'P', outcome: 'correct' },
    { model: 'm', rep: 2, template: 't', case: 'c', probe: 'q1', category: 'D1', arm: 'P', outcome: 'stale' },
    { model: 'm', rep: 1, template: 't', case: 'd', probe: 'q1', category: 'D1', arm: 'P', outcome: 'correct' },
    { model: 'm', rep: 2, template: 't', case: 'd', probe: 'q1', category: 'D1', arm: 'P', outcome: 'correct' },
  ];
  assert.deepEqual(repAgreement(data, { model: 'm', arm: 'P' }), { items: 2, disagree: 1, share: 0.5 });
});
