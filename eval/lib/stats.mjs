// The analysis. Rows are probe results {model, rep, template, case, probe, category, arm,
// outcome}; an item is (case, probe) within one model, and it scores the share of its
// repetitions that were correct. Every outcome other than correct scores 0, failures
// included: nothing the model did is dropped. Only a case run the infrastructure kept
// failing (rows marked `infrastructure`, see session.mjs) is left out, and counted in the
// report. Templates are the unit of resampling, because cases made from one template are
// not independent.
import { random } from './util.mjs';

const correct = (row) => (row.outcome === 'correct' ? 1 : 0);
const itemKey = (row) => `${row.case}|${row.probe}`;

/** Map item -> {template, category, score, reps} for one model and arm. */
export function itemScores(rows, { model, arm, categories, filter }) {
  const items = new Map();
  for (const row of rows) {
    if (row.model !== model || row.arm !== arm || row.infrastructure) continue;
    if (categories && !categories.includes(row.category)) continue;
    if (filter && !filter(row)) continue;
    const key = itemKey(row);
    const item = items.get(key) ?? { template: row.template, category: row.category, total: 0, reps: 0, byRep: new Map() };
    item.total += correct(row);
    item.reps += 1;
    item.byRep.set(row.rep, correct(row));
    items.set(key, item);
  }
  for (const item of items.values()) item.score = item.total / item.reps;
  return items;
}

/** Items present in both arms, grouped by template: [{template, a: [...], b: [...]}]. */
function pairedByTemplate(a, b) {
  const groups = new Map();
  for (const [key, item] of a) {
    const other = b.get(key);
    if (!other) continue;
    const group = groups.get(item.template) ?? { template: item.template, a: [], b: [] };
    group.a.push(item.score);
    group.b.push(other.score);
    groups.set(item.template, group);
  }
  return [...groups.values()];
}

const sum = (list) => list.reduce((n, x) => n + x, 0);
const percentile = (sorted, p) => {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index];
};

/** Exact two-sided binomial test of b against c (McNemar). */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  let term = 0.5 ** n; // C(n, 0) / 2^n
  for (let i = 0; i <= k; i += 1) {
    tail += term;
    term = (term * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * tail);
}

/** Template-level sign-flip test of the mean difference; exact when there are at most 16 templates. */
function signFlip(groups, n, observed, draws, r) {
  const d = groups.map((g) => sum(g.a) - sum(g.b));
  let atLeast = 0;
  let absAtLeast = 0;
  let total = 0;
  const eps = 1e-12;
  const tally = (stat) => {
    total += 1;
    if (stat >= observed - eps) atLeast += 1;
    if (Math.abs(stat) >= Math.abs(observed) - eps) absAtLeast += 1;
  };
  if (d.length <= 16) {
    for (let mask = 0; mask < 2 ** d.length; mask += 1) {
      let s = 0;
      for (let i = 0; i < d.length; i += 1) s += (mask & (1 << i)) ? -d[i] : d[i];
      tally(s / n);
    }
    return { pOneSided: atLeast / total, pTwoSided: absAtLeast / total, exact: true };
  }
  for (let draw = 0; draw < draws; draw += 1) {
    let s = 0;
    for (let i = 0; i < d.length; i += 1) s += r() < 0.5 ? -d[i] : d[i];
    tally(s / n);
  }
  return { pOneSided: (atLeast + 1) / (draws + 1), pTwoSided: (absAtLeast + 1) / (draws + 1), exact: false };
}

/** Bootstrap of the mean difference, resampling templates; returns sorted draws. */
function bootstrap(groups, draws, r) {
  const out = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let a = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[Math.floor(r() * groups.length)];
      a += sum(g.a);
      b += sum(g.b);
      n += g.a.length;
    }
    out.push(n ? (a - b) / n : 0);
  }
  return out.sort((x, y) => x - y);
}

/** McNemar per repetition, on items scored in that repetition. */
function mcnemarByRep(a, b) {
  const reps = new Set();
  for (const item of a.values()) for (const rep of item.byRep.keys()) reps.add(rep);
  return [...reps].sort().map((rep) => {
    let bCount = 0;
    let cCount = 0;
    for (const [key, item] of a) {
      const other = b.get(key);
      if (!other || !item.byRep.has(rep) || !other.byRep.has(rep)) continue;
      const x = item.byRep.get(rep);
      const y = other.byRep.get(rep);
      if (x === 1 && y === 0) bCount += 1;
      if (x === 0 && y === 1) cCount += 1;
    }
    return { rep, b: bCount, c: cCount, p: mcnemarExact(bCount, cCount) };
  });
}

/** armA against armB on the items both have: means, difference, 95% interval, p-values. */
export function paired(rows, { model, armA, armB, categories, filter, draws = 10_000, seed = 1 }) {
  const a = itemScores(rows, { model, arm: armA, categories, filter });
  const b = itemScores(rows, { model, arm: armB, categories, filter });
  const groups = pairedByTemplate(a, b);
  const n = sum(groups.map((g) => g.a.length));
  if (n === 0) return { armA, armB, n: 0, templates: 0, meanA: NaN, meanB: NaN, diff: NaN, ci95: [NaN, NaN], pOneSided: NaN, pTwoSided: NaN, mcnemar: [] };
  const meanA = sum(groups.flatMap((g) => g.a)) / n;
  const meanB = sum(groups.flatMap((g) => g.b)) / n;
  const diff = meanA - meanB;
  const boot = bootstrap(groups, draws, random(seed));
  const test = signFlip(groups, n, diff, draws, random(seed + 1));
  return {
    armA, armB, n, templates: groups.length, meanA, meanB, diff,
    ci95: [percentile(boot, 0.025), percentile(boot, 0.975)],
    lower95: percentile(boot, 0.05),
    ...test,
    mcnemar: mcnemarByRep(a, b),
  };
}

/** The primary test: `arm` beats every arm in `others` (intersection–union: each one-sided p below alpha). */
export function beatsAll(rows, { model, arm = 'P', others = ['T1', 'T2'], categories, filter, alpha = 0.05, draws, seed }) {
  const comparisons = others.map((other) => paired(rows, { model, armA: arm, armB: other, categories, filter, draws, seed }));
  const p = Math.max(...comparisons.map((c) => c.pOneSided));
  return { arm, others, comparisons, p, significant: comparisons.every((c) => c.n > 0 && c.pOneSided < alpha) };
}

/** Non-inferiority of armA to armB: the one-sided 95% lower bound of A − B above −margin. */
export function nonInferiority(rows, { model, armA, armB, categories, filter, margin = 0.1, draws, seed }) {
  const result = paired(rows, { model, armA, armB, categories, filter, draws, seed });
  return { ...result, margin, nonInferior: result.n > 0 && result.lower95 > -margin };
}

/** Holm–Bonferroni adjusted p-values, in the shape given (array or {name: p}). */
export function holm(pvalues) {
  const entries = Array.isArray(pvalues) ? pvalues.map((p, i) => [i, p]) : Object.entries(pvalues);
  const order = [...entries].sort((x, y) => x[1] - y[1]);
  const adjusted = new Map();
  let running = 0;
  order.forEach(([key, p], rank) => {
    running = Math.max(running, Math.min(1, (order.length - rank) * p));
    adjusted.set(key, running);
  });
  if (Array.isArray(pvalues)) return pvalues.map((_, i) => adjusted.get(i));
  return Object.fromEntries(entries.map(([key]) => [key, adjusted.get(key)]));
}

/** Outcome counts and accuracy per category and arm (rows counted per repetition); `excluded` counts the infrastructure's rows. */
export function categoryTable(rows, { model, arms, categories, filter }) {
  const table = {};
  for (const category of categories) {
    table[category] = {};
    for (const arm of arms) {
      const all = rows.filter((r) => r.model === model && r.arm === arm && r.category === category && (!filter || filter(r)));
      const list = all.filter((r) => !r.infrastructure);
      const counts = Object.fromEntries(['correct', 'stale', 'wrong', 'unknown', 'unparseable', 'failed'].map((o) => [o, list.filter((r) => r.outcome === o).length]));
      const confused = list.filter((r) => r.detail === 'confused').length;
      table[category][arm] = { rows: list.length, ...counts, confused, excluded: all.length - list.length, accuracy: list.length ? counts.correct / list.length : NaN };
    }
  }
  return table;
}

/** Share of items whose repetitions disagree. */
export function repAgreement(rows, { model, arm, filter }) {
  const items = itemScores(rows, { model, arm, filter });
  const multi = [...items.values()].filter((item) => item.reps > 1);
  const split = multi.filter((item) => item.score > 0 && item.score < 1).length;
  return { items: multi.length, disagree: split, share: multi.length ? split / multi.length : NaN };
}
