// From a run's results to its report: the pre-registered primary test for each model, the
// no-worse test, every category, the scale contrast, how reliable the runs were, and what
// they cost in tokens. Numbers only; reading them is for the write-up.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRIMARY, CATEGORIES } from './templates.mjs';
import { beatsAll, categoryTable, holm, nonInferiority, paired, repAgreement } from './stats.mjs';
import { random, shuffle } from './util.mjs';
import { reviewEntry } from './score.mjs';

const ARMS = ['P', 'T1', 'T2'];
const X = ['X1', 'X2', 'X3'];

/** Every result.json under a run's work directory. */
export function collect(runDir) {
  const records = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === 'result.json') records.push(JSON.parse(readFileSync(path, 'utf8')));
      else if (statSync(path).isDirectory() && !['store', 'probes', 'conversations'].includes(name)) walk(path);
    }
  };
  const work = join(runDir, 'work');
  if (existsSync(work)) walk(work);
  return records;
}

const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '—');
const pts = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}` : '—');
const pval = (p) => (Number.isFinite(p) ? (p < 0.0001 ? '<0.0001' : p.toFixed(4)) : '—');
const sumOrNull = (list) => (list.some((x) => x === null || x === undefined) ? null : list.reduce((a, b) => a + b, 0));

/** What a list of conversations cost; a count some request did not report is null. */
function costOf(convs) {
  return {
    conversations: convs.length,
    failedConversations: convs.filter((c) => !c.ok).length,
    requests: convs.reduce((n, c) => n + c.requests, 0),
    input: sumOrNull(convs.map((c) => c.input)),
    cached: sumOrNull(convs.map((c) => c.cached)),
    output: sumOrNull(convs.map((c) => c.output)),
    reasoning: sumOrNull(convs.map((c) => c.reasoning)),
    retries: convs.reduce((n, c) => n + (c.retries ?? 0), 0),
    toolErrors: convs.reduce((n, c) => n + c.toolErrors, 0),
  };
}
/** The kinds of conversation: the scripted messages, the questions, and the organizer's nights. */
export const KINDS = ['session', 'probe', 'organize'];

function cost(records, model) {
  const out = {};
  for (const arm of ARMS) {
    const convs = records.filter((r) => r.model === model && r.arm === arm).flatMap((r) => r.conversations);
    out[arm] = { ...costOf(convs), byKind: Object.fromEntries(KINDS.map((kind) => [kind, costOf(convs.filter((c) => c.kind === kind))])) };
  }
  return out;
}

/** The analysis of a run as one object. */
export function analyze(records, { draws = 10_000, seed = 1 } = {}) {
  const rows = records.flatMap((r) => r.rows);
  const models = [...new Set(rows.map((r) => r.model))].sort();
  const main = (row) => !row.scale;
  const perModel = {};
  for (const model of models) {
    const primary = beatsAll(rows, { model, categories: PRIMARY, filter: main, draws, seed });
    const n1 = {};
    for (const other of ['T1', 'T2']) n1[other] = paired(rows, { model, armA: other, armB: 'P', categories: ['N1'], filter: main, draws, seed });
    const stronger = (n1.T1.meanA ?? 0) >= (n1.T2.meanA ?? 0) ? 'T1' : 'T2';
    const noWorse = nonInferiority(rows, { model, armA: 'P', armB: stronger, categories: ['N1'], filter: main, draws, seed });
    const byCategory = {};
    for (const category of CATEGORIES) {
      byCategory[category] = Object.fromEntries(['T1', 'T2'].map((other) => [other, paired(rows, { model, armA: 'P', armB: other, categories: [category], filter: main, draws, seed })]));
    }
    const scale = {};
    for (const category of ['D1', 'D3']) {
      const chosen = new Set(rows.filter((r) => r.model === model && r.scale && r.category === category).map((r) => r.case.replace(/@\d+$/, '')));
      scale[category] = {};
      for (const size of [10, 50, 150]) {
        scale[category][size] = {};
        for (const arm of ARMS) {
          const list = rows.filter((r) => r.model === model && r.arm === arm && r.category === category && !r.infrastructure
            && (size === 150 ? !r.scale && chosen.has(r.case) : r.scale && r.library === size));
          scale[category][size][arm] = { rows: list.length, accuracy: list.length ? list.filter((r) => r.outcome === 'correct').length / list.length : NaN };
        }
      }
    }
    perModel[model] = {
      primary,
      noWorse: { stronger, ...noWorse },
      byCategory,
      table: categoryTable(rows, { model, arms: ARMS, categories: CATEGORIES, filter: main }),
      scale,
      agreement: Object.fromEntries(ARMS.map((arm) => [arm, repAgreement(rows, { model, arm, filter: main })])),
      cost: cost(records, model),
      correct: Object.fromEntries(ARMS.map((arm) => [arm, rows.filter((r) => r.model === model && r.arm === arm && r.outcome === 'correct').length])),
      excluded: Object.fromEntries(ARMS.map((arm) => [arm, records.filter((r) => r.model === model && r.arm === arm && r.infrastructure).length])),
    };
  }
  const adjusted = holm(Object.fromEntries(models.map((m) => [m, perModel[m].primary.p])));
  for (const model of models) perModel[model].primary.pHolm = adjusted[model];
  return { models, perModel, rows: rows.length };
}

/** The report as Markdown. */
export function renderReport(analysis, manifest = {}) {
  const lines = ['# Protocol Chaos against plain-text memory: results', ''];
  if (manifest.startedAt) lines.push(`Run started ${manifest.startedAt}; code ${manifest.git?.commit ?? '?'}${manifest.git?.dirty ? ' (uncommitted changes)' : ''}; split ${manifest.split}; ${analysis.rows} probe results.`, '');
  for (const model of analysis.models) {
    const m = analysis.perModel[model];
    lines.push(`## ${model}`, '');
    const left = ARMS.filter((arm) => m.excluded[arm]).map((arm) => `${arm} ${m.excluded[arm]}`);
    lines.push(`Case runs left out because the infrastructure kept failing: ${left.length ? left.join(', ') : 'none'}.`, '');
    lines.push('### Primary: P against each text arm on D1–D6', '');
    lines.push('| Comparison | Items | Templates | P | Text | Difference (points) | 95% interval | One-sided p | McNemar by repetition |', '|---|---|---|---|---|---|---|---|---|');
    for (const c of m.primary.comparisons) {
      lines.push(`| P vs ${c.armB} | ${c.n} | ${c.templates} | ${pct(c.meanA)} | ${pct(c.meanB)} | ${pts(c.diff)} | ${pts(c.ci95[0])} to ${pts(c.ci95[1])} | ${pval(c.pOneSided)} | ${c.mcnemar.map((x) => `rep ${x.rep}: ${x.b}/${x.c}, p ${pval(x.p)}`).join('; ')} |`);
    }
    lines.push('', `P beats both: ${m.primary.significant ? 'yes' : 'no'} (intersection–union p ${pval(m.primary.p)}, Holm across models ${pval(m.primary.pHolm)}).`, '');
    const nw = m.noWorse;
    lines.push('### No worse: N1', '', `P ${pct(nw.meanA)} against the stronger text arm on N1 (${nw.stronger}) ${pct(nw.meanB)}: difference ${pts(nw.diff)} points, one-sided 95% lower bound ${pts(nw.lower95)}, margin −${(100 * nw.margin).toFixed(0)}: ${nw.nonInferior ? 'no worse' : 'not shown to be no worse'}.`, '');
    lines.push('### Every category', '', '| Category | Arm | Results | Correct | Stale | Wrong | Unknown | Unparseable | Failed | Accuracy |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const category of CATEGORIES) {
      for (const arm of ARMS) {
        const t = m.table[category][arm];
        if (!t.rows) continue;
        lines.push(`| ${category} | ${arm} | ${t.rows} | ${t.correct} | ${t.stale} | ${t.wrong} | ${t.unknown} | ${t.unparseable} | ${t.failed} | ${pct(t.accuracy)} |`);
      }
    }
    lines.push('', '| Category | Comparison | Items | Difference (points) | 95% interval | Two-sided p |', '|---|---|---|---|---|---|');
    for (const category of CATEGORIES) {
      for (const other of ['T1', 'T2']) {
        const c = m.byCategory[category][other];
        if (!c.n) continue;
        lines.push(`| ${category} | P vs ${other} | ${c.n} | ${pts(c.diff)} | ${pts(c.ci95[0])} to ${pts(c.ci95[1])} | ${pval(c.pTwoSided)} |`);
      }
    }
    lines.push('', '### Scale: the same D1 and D3 cases with 10, 50 and 150 background matters', '', '| Category | Matters | P | T1 | T2 |', '|---|---|---|---|---|');
    for (const category of ['D1', 'D3']) {
      for (const size of [10, 50, 150]) {
        const s = m.scale[category][size];
        if (!s.P.rows && !s.T1.rows) continue;
        lines.push(`| ${category} | ${size} | ${pct(s.P.accuracy)} | ${pct(s.T1.accuracy)} | ${pct(s.T2.accuracy)} |`);
      }
    }
    lines.push('', '### Reliability and cost', '', '| Arm | Conversations | Failed | Requests | Retries | Tool errors | Input tokens | Cached | Output | Reasoning | Tokens per correct answer | Repetitions disagreeing |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const arm of ARMS) {
      const c = m.cost[arm];
      const tokens = c.input === null || c.output === null ? null : c.input + c.output;
      const per = tokens === null || !m.correct[arm] ? '—' : Math.round(tokens / m.correct[arm]).toLocaleString('en');
      const a = m.agreement[arm];
      lines.push(`| ${arm} | ${c.conversations} | ${c.failedConversations} | ${c.requests} | ${c.retries} | ${c.toolErrors} | ${c.input?.toLocaleString('en') ?? '—'} | ${c.cached?.toLocaleString('en') ?? '—'} | ${c.output?.toLocaleString('en') ?? '—'} | ${c.reasoning?.toLocaleString('en') ?? '—'} | ${per} | ${Number.isFinite(a.share) ? `${a.disagree}/${a.items}` : '—'} |`);
    }
    if (ARMS.some((arm) => m.cost[arm].byKind?.organize.conversations)) {
      lines.push('', 'By kind of conversation (sessions: the writer; probes: the reader; organizing: the organizer):', '', '| Arm | Kind | Conversations | Failed | Requests | Tool errors | Input tokens | Cached | Output |', '|---|---|---|---|---|---|---|---|---|');
      for (const arm of ARMS) {
        for (const kind of KINDS) {
          const c = m.cost[arm].byKind[kind];
          if (!c.conversations) continue;
          lines.push(`| ${arm} | ${kind} | ${c.conversations} | ${c.failedConversations} | ${c.requests} | ${c.toolErrors} | ${c.input?.toLocaleString('en') ?? '—'} | ${c.cached?.toLocaleString('en') ?? '—'} | ${c.output?.toLocaleString('en') ?? '—'} |`);
        }
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The review packet: every answer the rules could not read, or flagged, with ids, tool names
 * and the arm removed and the order shuffled. The key that maps entries back is separate.
 */
export function reviewPacket(records, { seed = 7 } = {}) {
  const rows = records.flatMap((r) => r.rows).filter((row) => row.outcome === 'unparseable' || row.review);
  const shuffled = shuffle(random(seed), rows);
  const entries = shuffled.map((row, i) => ({ ...reviewEntry({ id: `r${i + 1}`, question: row.question ?? '', answer: row.gold ?? {}, reply: row.reply }), outcome: row.outcome }));
  const key = shuffled.map((row, i) => ({ id: `r${i + 1}`, model: row.model, rep: row.rep, case: row.case, probe: row.probe, arm: row.arm }));
  return { entries, key };
}
