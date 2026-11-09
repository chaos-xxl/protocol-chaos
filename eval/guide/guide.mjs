// PersistBench with a usage guide (README.md): the prompts with the guide, and the analysis that
// pairs each condition with and without it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcnemarExact } from '../lib/stats.mjs';
import { random, sha256 } from '../lib/util.mjs';
import { TYPES, loadPrompts } from '../selection/persistbench.mjs';
import { oneSidedSign, outcome } from '../selection/report.mjs';

const HERE = fileURLToPath(new URL('./', import.meta.url));
export const CONDITIONS = ['flat', 'files', 'protocol'];

/** PersistBench's prompts with the guide right before the memory block. */
export function guidedPrompts() {
  const prompts = loadPrompts();
  const guide = readFileSync(join(HERE, 'guide.md'), 'utf8').trim();
  if (prompts.generator.split('{memories}').length !== 2) throw new Error('the generator prompt must hold {memories} once');
  prompts.generator = prompts.generator.replace('{memories}', () => `${guide}\n\n{memories}`);
  prompts.hashes = { ...prompts.hashes, generator: sha256(prompts.generator), guide: sha256(guide) };
  return prompts;
}


const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '—');
const pts = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}` : '—');
const pval = (p) => (Number.isFinite(p) ? (p < 0.0001 ? '<0.0001' : p.toFixed(4)) : '—');

function bootstrap(n, statistic, draws = 10_000) {
  const r = random(1);
  const values = [];
  const pick = new Array(n);
  for (let d = 0; d < draws; d += 1) {
    for (let i = 0; i < n; i += 1) pick[i] = Math.floor(r() * n);
    values.push(statistic(pick));
  }
  values.sort((a, b) => a - b);
  return { low: values[Math.floor(0.025 * draws)], high: values[Math.ceil(0.975 * draws) - 1], p95: values[Math.ceil(0.95 * draws) - 1] };
}

/** The analysis: each condition with and without the guide, paired comparisons, G1 and G2. */
export function analyzeGuide(withGuide, without) {
  const cells = new Map();
  const add = (records, setting) => {
    for (const r of records) {
      if (!CONDITIONS.includes(r.condition)) continue;
      const k = `${r.model}|${setting}|${r.condition}|${r.type}`;
      if (!cells.has(k)) cells.set(k, new Map());
      cells.get(k).set(r.sample, { record: r, outcome: outcome(r) });
    }
  };
  add(withGuide, 'guide');
  add(without, 'none');
  const models = [...new Set(withGuide.map((r) => r.model))].sort();
  const rate = (model, setting, condition, type) => {
    const items = cells.get(`${model}|${setting}|${condition}|${type}`);
    if (!items) return null;
    const counted = [...items.values()].filter((x) => !x.outcome.excluded);
    const fails = counted.map((x) => (x.outcome.fail ? 1 : 0));
    const n = fails.length;
    const epochs = [...items.values()].flatMap((x) => x.record.epochs ?? []).filter((e) => !e.infrastructure);
    const reads = epochs.map((e) => e.reads).filter(Boolean);
    return {
      n, failures: fails.reduce((s, v) => s + v, 0), rate: n ? fails.reduce((s, v) => s + v, 0) / n : NaN,
      ci: n ? bootstrap(n, (pick) => pick.reduce((s, i) => s + fails[i], 0) / n) : null,
      excluded: items.size - n,
      input: epochs.length ? epochs.reduce((s, e) => s + (e.usage?.input ?? 0), 0) / epochs.length : NaN,
      reads: reads.length ? { none: reads.filter((x) => x.topics.length === 0 && !x.all).length / reads.length, topics: reads.reduce((s, x) => s + x.topics.length, 0) / reads.length } : null,
    };
  };
  const compare = (model, type, [sa, ca], [sb, cb]) => {
    const A = cells.get(`${model}|${sa}|${ca}|${type}`);
    const B = cells.get(`${model}|${sb}|${cb}|${type}`);
    if (!A || !B) return null;
    const pairs = [...A.keys()].filter((s) => B.has(s) && !A.get(s).outcome.excluded && !B.get(s).outcome.excluded)
      .map((s) => [A.get(s).outcome.fail ? 1 : 0, B.get(s).outcome.fail ? 1 : 0]);
    const n = pairs.length;
    if (!n) return null;
    const aOnly = pairs.filter(([x, y]) => x && !y).length;
    const bOnly = pairs.filter(([x, y]) => !x && y).length;
    return {
      n, rateA: pairs.reduce((s, [x]) => s + x, 0) / n, rateB: pairs.reduce((s, [, y]) => s + y, 0) / n, aOnly, bOnly,
      diff: pairs.reduce((s, [x, y]) => s + x - y, 0) / n, ci: bootstrap(n, (pick) => pick.reduce((s, i) => s + pairs[i][0] - pairs[i][1], 0) / n),
      pTwoSided: mcnemarExact(aOnly, bOnly), pLower: oneSidedSign(bOnly, aOnly + bOnly),
    };
  };
  const PAIRS = [
    [['guide', 'protocol'], ['none', 'protocol']], [['guide', 'files'], ['none', 'files']], [['guide', 'flat'], ['none', 'flat']],
    [['guide', 'protocol'], ['guide', 'flat']], [['guide', 'files'], ['guide', 'flat']], [['guide', 'protocol'], ['guide', 'files']],
  ];
  const out = { models, rates: {}, comparisons: {}, rules: {} };
  for (const model of models) {
    for (const setting of ['guide', 'none']) for (const condition of CONDITIONS) for (const type of TYPES) out.rates[`${model}|${setting}|${condition}|${type}`] = rate(model, setting, condition, type);
    for (const type of TYPES) for (const [a, b] of PAIRS) out.comparisons[`${model}|${type}|${a.join(':')}|${b.join(':')}`] = compare(model, type, a, b);
    const g1 = out.comparisons[`${model}|beneficial_memory_usage|guide:protocol|none:protocol`];
    const leak = out.comparisons[`${model}|cross_domain|guide:protocol|guide:flat`];
    const miss = out.comparisons[`${model}|beneficial_memory_usage|guide:protocol|guide:flat`];
    out.rules[model] = {
      G1: g1 ? { holds: g1.pLower < 0.05, p: g1.pLower, diff: g1.diff } : null,
      G2: leak && miss ? { holds: leak.pLower < 0.05 && miss.ci.p95 < 0.10, leak: { p: leak.pLower, diff: leak.diff }, miss: { diff: miss.diff, upper95: miss.ci.p95 } } : null,
    };
  }
  return out;
}

export function renderGuideReport(a, manifests) {
  const lines = ['# PersistBench with a usage guide', ''];
  for (const m of manifests) lines.push(`- Run ${m.name}: model ${m.model.id}, judge ${m.judge.id}, started ${m.startedAt}, code ${m.git?.commit?.slice(0, 7) ?? '?'}${m.git?.dirty ? ' (uncommitted changes)' : ''}${m.guide ? ', with the guide' : ''}.`);
  lines.push('', 'Rates as in eval/selection/. "Without" is the run of eval/selection/ on the same samples.', '');
  for (const model of a.models) {
    lines.push(`## ${model}`, '', '| Condition | Leakage, with the guide | Leakage, without | Missed, with the guide | Missed, without | Read nothing (leak / beneficial), with | Read nothing, without | Tokens in per answer, with / without |', '|---|---|---|---|---|---|---|---|');
    for (const condition of CONDITIONS) {
      const r = (setting, type) => a.rates[`${model}|${setting}|${condition}|${type}`];
      const show = (x) => (x ? `${pct(x.rate)} (${x.failures}/${x.n})` : '—');
      const none = (setting) => [r(setting, 'cross_domain'), r(setting, 'beneficial_memory_usage')].map((x) => (x?.reads ? pct(x.reads.none) : '—')).join(' / ');
      const tokens = ['guide', 'none'].map((s) => {
        const c = r(s, 'cross_domain');
        const b = r(s, 'beneficial_memory_usage');
        return c && b ? Math.round((c.input * 2 + b.input) / 3).toLocaleString('en') : '—';
      }).join(' / ');
      lines.push(`| ${condition} | ${show(r('guide', 'cross_domain'))} | ${show(r('none', 'cross_domain'))} | ${show(r('guide', 'beneficial_memory_usage'))} | ${show(r('none', 'beneficial_memory_usage'))} | ${none('guide')} | ${none('none')} | ${tokens} |`);
    }
    lines.push('', 'Paired comparisons (difference = first minus second; negative is fewer failures):', '', '| Measure | Comparison | Samples | First | Second | First only fails | Second only fails | Difference (points) | 95% interval | McNemar p (two-sided) |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const [k, c] of Object.entries(a.comparisons)) {
      if (!k.startsWith(`${model}|`) || !c) continue;
      const [, type, first, second] = k.split('|');
      const label = (s) => s.replace('guide:', '').replace('none:', '') + (s.startsWith('guide:') ? ' + guide' : '');
      lines.push(`| ${type === 'cross_domain' ? 'Leakage' : 'Missed'} | ${label(first)} vs ${label(second)} | ${c.n} | ${pct(c.rateA)} | ${pct(c.rateB)} | ${c.aOnly} | ${c.bOnly} | ${pts(c.diff)} | ${pts(c.ci.low)} to ${pts(c.ci.high)} | ${pval(c.pTwoSided)} |`);
    }
    const g = a.rules[model];
    lines.push('', 'Decision rules written down before the runs:', '');
    lines.push(`- G1, the guide removes the misses of the map (protocol + guide misses less than protocol): ${g.G1 ? `${g.G1.holds ? 'holds' : 'does not hold'} (difference ${pts(g.G1.diff)} points, one-sided p ${pval(g.G1.p)})` : 'not run'}.`);
    lines.push(`- G2, with the guide the map leaks less than the list and misses no more than it plus 10 points: ${g.G2 ? `${g.G2.holds ? 'holds' : 'does not hold'} (leakage ${pts(g.G2.leak.diff)} points, one-sided p ${pval(g.G2.leak.p)}; missed ${pts(g.G2.miss.diff)} points, one-sided 95% upper bound ${pts(g.G2.miss.upper95)})` : 'not run'}.`, '');
  }
  return `${lines.join('\n')}\n`;
}

