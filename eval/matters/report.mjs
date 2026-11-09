// From the records of matter-benchmark runs to failure rates, paired comparisons and the decision
// rules of README.md. The rates and comparisons are eval/selection/report.mjs's own (leakage
// requests take PersistBench's cross-domain measure, needs requests its beneficial one); this
// module adds H4, the stale values, the leakage of each kind, and what the map conditions read.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeFileAtomic, writeJson } from '../lib/util.mjs';
import { analyze, loadRecords, outcome, renderChart } from '../selection/report.mjs';
import { CONDITIONS, TOP_K, topTitles } from './bench.mjs';

const key = (...parts) => parts.join('|');
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '—');
const pts = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}` : '—');
const pval = (p) => (Number.isFinite(p) ? (p < 0.0001 ? '<0.0001' : p.toFixed(4)) : '—');
const share = (list, test) => (list.length ? list.filter(test).length / list.length : NaN);

/** The extra measures: stale values, leakage by kind, what the map conditions opened, what retrieval kept. */
export function extras(records, requests, similarity) {
  const byId = new Map(requests.map((r) => [r.id, r]));
  const models = [...new Set(records.map((r) => r.model))].sort();
  const out = { stale: {}, byKind: {}, opened: {}, retrievalCovers: null, h4: {} };
  for (const model of models) {
    for (const condition of CONDITIONS) {
      const mine = records.filter((r) => r.model === model && r.condition === condition);
      const needs = mine.filter((r) => r.kind === 'needs');
      const judged = needs.flatMap((r) => r.epochs).filter((e) => e.ok && e.judgment?.ok && e.judgment.stale !== null && e.judgment.stale !== undefined);
      out.stale[key(model, condition)] = { judged: judged.length, stale: judged.filter((e) => e.judgment.stale).length, rate: share(judged, (e) => e.judgment.stale) };
      for (const kind of ['adjacent', 'unrelated']) {
        const counted = mine.filter((r) => r.kind === kind).map(outcome).filter((o) => !o.excluded);
        out.byKind[key(model, condition, kind)] = { counted: counted.length, failures: counted.filter((o) => o.fail).length, rate: share(counted, (o) => o.fail) };
      }
      if (condition === 'files' || condition === 'protocol') {
        const needsEpochs = needs.flatMap((r) => r.epochs.filter((e) => e.reads).map((e) => ({ e, request: byId.get(r.sample) })));
        const adjacentEpochs = mine.filter((r) => r.kind === 'adjacent').flatMap((r) => r.epochs.filter((e) => e.reads).map((e) => ({ e, request: byId.get(r.sample) })));
        const unrelatedEpochs = mine.filter((r) => r.kind === 'unrelated').flatMap((r) => r.epochs.filter((e) => e.reads));
        out.opened[key(model, condition)] = {
          needsAll: share(needsEpochs, ({ e, request }) => request && request.matters.every((t) => e.reads.topics.includes(t))),
          needsAny: share(needsEpochs, ({ e, request }) => request && request.matters.some((t) => e.reads.topics.includes(t))),
          needsOpened: needsEpochs.length ? needsEpochs.reduce((s, { e }) => s + e.reads.topics.length, 0) / needsEpochs.length : NaN,
          adjacentOpened: share(adjacentEpochs, ({ e, request }) => request && e.reads.topics.includes(request.matter)),
          adjacentNone: share(adjacentEpochs, ({ e }) => e.reads.topics.length === 0),
          unrelatedNone: share(unrelatedEpochs, (e) => e.reads.topics.length === 0),
          searches: [...needsEpochs.map(({ e }) => e), ...adjacentEpochs.map(({ e }) => e), ...unrelatedEpochs].reduce((s, e, _, all) => s + e.reads.searches / all.length, 0),
        };
      }
    }
  }
  const needs = requests.filter((r) => r.kind === 'needs' && similarity?.[r.id]);
  if (needs.length) {
    out.retrievalCovers = {
      all: share(needs, (r) => r.matters.every((t) => topTitles(similarity[r.id], TOP_K).includes(t))),
      any: share(needs, (r) => r.matters.some((t) => topTitles(similarity[r.id], TOP_K).includes(t))),
      n: needs.length,
    };
  }
  return out;
}

/** The report of a set of matter-benchmark runs as Markdown. */
export function renderReport(analysis, more, manifests, requests) {
  const lines = ['# Matter benchmark: requests answered from a store of about 150 matters', ''];
  for (const m of manifests) lines.push(`- Run ${m.name}: model ${m.model.id}, judge ${m.judge.id}, started ${m.startedAt}, code ${m.git?.commit?.slice(0, 7) ?? '?'}${m.git?.dirty ? ' (uncommitted changes)' : ''}, ${m.requests} requests.`);
  const count = (kind) => requests.filter((r) => r.kind === kind).length;
  lines.push('', `Requests: ${count('needs')} needs, ${count('adjacent')} adjacent, ${count('unrelated')} unrelated, from ${new Set(requests.map((r) => r.case)).size} cases.`, '');
  lines.push('Leakage: the share of adjacent and unrelated requests whose worst of three answers the judge scores 3 or more (of 5). Missed matters: the share of needs requests whose answer the judge rates below 3 (of 3). Stale: the share of judged needs answers that relied on a stale value. An answer the model did not produce counts as a failure. Intervals: 95% bootstrap over requests.', '');
  for (const model of analysis.models) {
    lines.push(`## ${model}`, '', '| Condition | Leakage | 95% interval | adjacent | unrelated | Missed matters | 95% interval | Stale | No answer (leak / needs) | Tokens in / out per answer |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const condition of CONDITIONS) {
      const c = analysis.cells[key(model, condition, 'cross_domain')];
      const b = analysis.cells[key(model, condition, 'beneficial_memory_usage')];
      if (!c && !b) continue;
      const adj = more.byKind[key(model, condition, 'adjacent')];
      const unr = more.byKind[key(model, condition, 'unrelated')];
      const st = more.stale[key(model, condition)];
      const gens = (c?.generations ?? 0) + (b?.generations ?? 0);
      const per = gens ? `${Math.round(((c?.input ?? 0) + (b?.input ?? 0)) / gens).toLocaleString('en')} / ${Math.round(((c?.output ?? 0) + (b?.output ?? 0)) / gens).toLocaleString('en')}` : '—';
      lines.push(`| ${condition} | ${pct(c?.rate)} (${c?.failures ?? 0}/${c?.counted ?? 0}) | ${c?.ci ? `${pct(c.ci.low)}–${pct(c.ci.high)}` : '—'} | ${pct(adj?.rate)} (${adj?.failures ?? 0}/${adj?.counted ?? 0}) | ${pct(unr?.rate)} (${unr?.failures ?? 0}/${unr?.counted ?? 0}) | ${pct(b?.rate)} (${b?.failures ?? 0}/${b?.counted ?? 0}) | ${b?.ci ? `${pct(b.ci.low)}–${pct(b.ci.high)}` : '—'} | ${pct(st?.rate)} (${st?.stale ?? 0}/${st?.judged ?? 0}) | ${c?.generationFailures ?? 0} / ${b?.generationFailures ?? 0} | ${per} |`);
    }
    lines.push('', 'Paired comparisons on the requests both conditions counted (difference = first minus second; negative is fewer failures):', '', '| Measure | Comparison | Requests | First | Second | First only fails | Second only fails | Difference (points) | 95% interval | McNemar p (two-sided) |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const [type, label] of [['cross_domain', 'Leakage'], ['beneficial_memory_usage', 'Missed matters']]) {
      for (const [a, b] of [['protocol', 'flat'], ['files', 'flat'], ['partition', 'flat'], ['retrieval', 'flat'], ['protocol', 'partition'], ['protocol', 'retrieval'], ['protocol', 'files']]) {
        const c = analysis.comparisons[key(model, type, a, b)];
        if (c) lines.push(`| ${label} | ${a} vs ${b} | ${c.n} | ${pct(c.rateA)} | ${pct(c.rateB)} | ${c.aOnly} | ${c.bOnly} | ${pts(c.diff)} | ${pts(c.ci.low)} to ${pts(c.ci.high)} | ${pval(c.pTwoSided)} |`);
      }
    }
    const opened = ['files', 'protocol'].map((condition) => [condition, more.opened[key(model, condition)]]).filter(([, o]) => o);
    if (opened.length) {
      lines.push('', 'What the map conditions opened (a matter counts once per answer):', '', '| Condition | Needs: opened every needed matter | Needs: opened at least one | Needs: matters opened, mean | Adjacent: opened the look-alike matter | Adjacent: opened none | Unrelated: opened none | Searches per answer |', '|---|---|---|---|---|---|---|---|');
      for (const [condition, o] of opened) lines.push(`| ${condition} | ${pct(o.needsAll)} | ${pct(o.needsAny)} | ${Number.isFinite(o.needsOpened) ? o.needsOpened.toFixed(2) : '—'} | ${pct(o.adjacentOpened)} | ${pct(o.adjacentNone)} | ${pct(o.unrelatedNone)} | ${Number.isFinite(o.searches) ? o.searches.toFixed(2) : '—'} |`);
    }
    const h = analysis.hypotheses[model];
    const h4 = analysis.comparisons[key(model, 'beneficial_memory_usage', 'protocol', 'files')];
    lines.push('', 'Decision rules written down before the runs:', '');
    lines.push(`- H1, protocol leaks less than flat: ${h.H1 ? `${h.H1.holds ? 'holds' : 'does not hold'} (difference ${pts(h.H1.diff)} points, one-sided p ${pval(h.H1.p)}, Holm ${pval(h.H1.pHolm)})` : 'not run'}.`);
    lines.push(`- H2, protocol misses no more than flat plus 10 points: ${h.H2 ? `${h.H2.holds ? 'holds' : 'does not hold'} (difference ${pts(h.H2.diff)} points, one-sided 95% upper bound ${pts(h.H2.upper95)})` : 'not run'}.`);
    lines.push(`- H3, protocol misses less than retrieval: ${h.H3 ? `${h.H3.holds ? 'holds' : 'does not hold'} (difference ${pts(h.H3.diff)} points, one-sided p ${pval(h.H3.p)})` : 'not run'}.`);
    lines.push(`- H4, protocol misses less than files: ${h4 ? `${h4.pLower < 0.05 ? 'holds' : 'does not hold'} (difference ${pts(h4.diff)} points, one-sided p ${pval(h4.pLower)})` : 'not run'}.`, '');
  }
  if (more.retrievalCovers) lines.push(`Retrieval's top ${TOP_K} held every matter a needs request needs for ${pct(more.retrievalCovers.all)} of the ${more.retrievalCovers.n} needs requests, and at least one of them for ${pct(more.retrievalCovers.any)}.`, '');
  return `${lines.join('\n')}\n`;
}

/** Writes report.md, summary.json and chart.svg into the first run directory. */
export function writeReport(runDirs, { cache }) {
  const records = loadRecords(runDirs);
  const requests = existsSync(join(cache, 'requests.json')) ? readJson(join(cache, 'requests.json')).kept : [];
  const similarity = existsSync(join(cache, 'similarity.json')) ? readJson(join(cache, 'similarity.json')) : {};
  const analysis = analyze(records);
  const more = extras(records, requests, similarity);
  for (const model of analysis.models) {
    const h4 = analysis.comparisons[key(model, 'beneficial_memory_usage', 'protocol', 'files')];
    more.h4[model] = h4 ? { holds: h4.pLower < 0.05, p: h4.pLower, diff: h4.diff } : null;
  }
  const manifests = runDirs.filter((d) => existsSync(join(d, 'manifest.json'))).map((d) => JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')));
  const target = runDirs[0];
  writeJson(join(target, 'summary.json'), { runs: manifests.map((m) => m.name), ...analysis, ...more });
  writeFileAtomic(join(target, 'report.md'), renderReport(analysis, more, manifests, requests));
  writeFileAtomic(join(target, 'chart.svg'), renderChart(analysis, []));
  process.stderr.write(`Report: ${join(target, 'report.md')} (${records.length} records)\n`);
}
