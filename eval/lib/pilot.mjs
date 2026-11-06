// The blind report of a pilot run: what the pilot is for (finding bugs, unclear questions and
// answers, format problems, prompts a model cannot follow, categories too easy or too hard)
// without showing how the arms compare. Accuracy appears only with the arms pooled; by arm it
// shows only how the conversations went: how they ended, which tools they called and which of
// those calls failed, what they wrote, and what they cost. The per-arm results stay in the run
// directory, unread, until the formal templates are written (§九 of the plan).
import { CATEGORIES } from './templates.mjs';
import { reviewEntry } from './score.mjs';
import { random, shuffle } from './util.mjs';

const ARMS = ['P', 'T1', 'T2'];
const OUTCOMES = ['correct', 'stale', 'wrong', 'unknown', 'unparseable', 'failed'];
/** Tool calls that change the store, in any arm. */
const WRITES = /^(event_note|event_record_expression|event_add_parent|event_remove_parent|event_undo_revision|entity_create|entity_record|memory|notes_create|notes_str_replace|notes_append)\b/;
const CEILING = 0.9;
const FLOOR = 0.1;

/** Why a conversation ended without an answer, in a few words. */
export function failureReason(error) {
  if (!error) return null;
  if (error.startsWith('no answer within')) return 'call limit';
  if (error.startsWith('the reply was cut off')) return 'cut off';
  if (error === 'an empty reply') return 'empty reply';
  if (error.startsWith('the endpoint refused')) return 'request refused';
  if (error.startsWith('model:') || error.startsWith('store:')) return 'infrastructure';
  return 'other';
}

const count = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const sorted = (map) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
const sumOrNull = (list) => (list.some((x) => x === null || x === undefined) ? null : list.reduce((a, b) => a + b, 0));

/** How one kind of conversation (sessions or probes) went in one arm. */
function conversationMechanics(conversations) {
  const reasons = new Map();
  const tools = new Map();
  const errors = new Map();
  const patterns = new Map();
  let withoutWrite = 0;
  for (const c of conversations) {
    const reason = failureReason(c.error);
    if (reason) count(reasons, reason);
    const calls = c.calls ?? [];
    for (const call of calls) {
      count(tools, call.tool);
      if (call.error) count(errors, `${call.tool}: ${call.error}`);
    }
    const written = [...new Set(calls.filter((call) => !call.error && WRITES.test(call.tool)).map((call) => call.tool))].sort();
    if (written.length === 0) withoutWrite += 1;
    count(patterns, written.length ? written.join(' + ') : '(nothing written)');
  }
  const n = conversations.length;
  const total = (field) => sumOrNull(conversations.map((c) => c[field]));
  return {
    conversations: n,
    ended: { answered: conversations.filter((c) => c.ok).length, ...sorted(reasons) },
    toolCalls: conversations.reduce((s, c) => s + (c.toolCalls ?? 0), 0),
    toolErrors: conversations.reduce((s, c) => s + (c.toolErrors ?? 0), 0),
    requests: conversations.reduce((s, c) => s + (c.requests ?? 0), 0),
    retries: conversations.reduce((s, c) => s + (c.retries ?? 0), 0),
    withoutWrite,
    tools: sorted(tools),
    errors: sorted(errors),
    writePatterns: sorted(patterns),
    tokens: { input: total('input'), cached: total('cached'), output: total('output'), reasoning: total('reasoning') },
    systemChars: n ? Math.round(conversations.reduce((s, c) => s + (c.systemChars ?? 0), 0) / n) : null,
    latencyMs: conversations.reduce((s, c) => s + (c.latencyMs ?? 0), 0),
  };
}

const tally = (rows) => {
  const out = Object.fromEntries(OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length]));
  return { rows: rows.length, ...out, accuracy: rows.length ? out.correct / rows.length : NaN };
};
const flag = (accuracy) => (accuracy >= CEILING ? 'ceiling' : accuracy <= FLOOR ? 'floor' : null);

/** The pilot's analysis: pooled accuracy, and the mechanics by arm. */
export function pilotAnalysis(records, { seed = 11 } = {}) {
  const models = [...new Set(records.map((r) => r.model))].sort();
  const perModel = {};
  for (const model of models) {
    const mine = records.filter((r) => r.model === model);
    const scored = mine.filter((r) => !r.infrastructure).flatMap((r) => r.rows);
    const caseRuns = Object.fromEntries(ARMS.map((arm) => {
      const list = mine.filter((r) => r.arm === arm);
      return [arm, {
        total: list.length,
        infrastructure: list.filter((r) => r.infrastructure).length,
        harness: list.filter((r) => r.error && !r.infrastructure).length,
      }];
    }));
    const byCategory = {};
    for (const category of CATEGORIES) {
      const rows = scored.filter((r) => r.category === category);
      if (!rows.length) continue;
      const t = tally(rows);
      byCategory[category] = { templates: new Set(rows.map((r) => r.template)).size, ...t, flag: flag(t.accuracy) };
    }
    const byTemplate = {};
    for (const template of [...new Set(scored.map((r) => r.template))].sort()) {
      const rows = scored.filter((r) => r.template === template);
      const t = tally(rows);
      byTemplate[template] = { category: rows[0].category, cases: new Set(rows.map((r) => r.case)).size, ...t, flag: flag(t.accuracy) };
    }
    // A probe of a template, over its variants, repetitions and the three arms together.
    const byProbe = {};
    for (const row of scored) {
      const key = `${row.template} ${row.probe}`;
      byProbe[key] ??= { template: row.template, probe: row.probe, category: row.category, question: row.question, rows: [] };
      byProbe[key].rows.push(row);
    }
    const probes = Object.fromEntries(Object.entries(byProbe).sort().map(([key, p]) => [key, { template: p.template, probe: p.probe, category: p.category, ...tally(p.rows) }]));
    // Probes no arm ever answered correctly: their questions and gold answers are checked against the
    // replies, with the arm hidden. Such replies say nothing about which arm does better.
    const never = Object.values(byProbe).filter((p) => p.rows.every((r) => r.outcome !== 'correct'));
    const neverRows = shuffle(random(seed), never.flatMap((p) => p.rows));
    const neverCorrect = neverRows.map((row, i) => ({
      ...reviewEntry({ id: `n${i + 1}`, question: row.question ?? '', answer: row.gold ?? {}, reply: row.reply }),
      template: row.template, probe: row.probe, outcome: row.outcome, value: row.value ?? null,
    }));
    const mechanics = {};
    for (const arm of ARMS) {
      const conversations = mine.filter((r) => r.arm === arm && !r.infrastructure).flatMap((r) => r.conversations);
      const rows = scored.filter((r) => r.arm === arm);
      mechanics[arm] = {
        sessions: conversationMechanics(conversations.filter((c) => c.kind === 'session')),
        organizing: conversationMechanics(conversations.filter((c) => c.kind === 'organize')),
        probes: {
          ...conversationMechanics(conversations.filter((c) => c.kind === 'probe')),
          // How the answers were written, not whether they were right.
          unparseable: rows.filter((r) => r.outcome === 'unparseable').length,
          failed: rows.filter((r) => r.outcome === 'failed').length,
          flaggedForReview: rows.filter((r) => r.review).length,
        },
      };
    }
    perModel[model] = {
      caseRuns, pooled: { ...tally(scored), byCategory, byTemplate, probes }, mechanics, neverCorrect,
    };
  }
  return { models, perModel };
}

const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '—');
const num = (x) => (x === null || x === undefined ? '—' : x.toLocaleString('en'));
const list = (object, limit = 12) => {
  const entries = Object.entries(object);
  if (!entries.length) return '—';
  const shown = entries.slice(0, limit).map(([k, v]) => `${k} ×${v}`).join('; ');
  return entries.length > limit ? `${shown}; … (${entries.length - limit} more)` : shown;
};

/** The pilot report as Markdown. */
export function renderPilot(analysis, manifest = {}) {
  const lines = ['# Pilot run (blind)', ''];
  lines.push('Accuracy is shown only with the three arms pooled. By arm, the report shows how the conversations went, never how often an arm was right. It is for finding problems in the method before the formal templates are written: harness bugs, questions or gold answers that are wrong or ambiguous, answer-format problems, prompts a model cannot follow, and categories that are too easy or too hard for every arm.', '');
  if (manifest.startedAt) lines.push(`Run started ${manifest.startedAt}; code ${manifest.git?.commit ?? '?'}${manifest.git?.dirty ? ' (uncommitted changes)' : ''}; split ${manifest.split}; ${manifest.cases} cases × ${manifest.arms?.length ?? 3} arms × ${manifest.reps} repetitions.`, '');
  for (const model of analysis.models) {
    const m = analysis.perModel[model];
    lines.push(`## ${model}`, '');
    lines.push('### Case runs', '', '| Arm | Case runs | Left out: infrastructure | Harness errors |', '|---|---|---|---|');
    for (const arm of ARMS) {
      const c = m.caseRuns[arm];
      if (c.total) lines.push(`| ${arm} | ${c.total} | ${c.infrastructure} | ${c.harness} |`);
    }
    const p = m.pooled;
    lines.push('', `### Accuracy, the three arms pooled: ${pct(p.accuracy)} of ${p.rows} answers`, '');
    lines.push('| Category | Templates | Answers | Correct | Stale | Wrong | Unknown | Unparseable | Failed | Accuracy | Flag |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [category, t] of Object.entries(p.byCategory)) {
      lines.push(`| ${category} | ${t.templates} | ${t.rows} | ${t.correct} | ${t.stale} | ${t.wrong} | ${t.unknown} | ${t.unparseable} | ${t.failed} | ${pct(t.accuracy)} | ${t.flag ?? ''} |`);
    }
    lines.push('', '| Template | Category | Cases | Answers | Correct | Stale | Wrong | Unknown | Unparseable | Failed | Accuracy | Flag |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [template, t] of Object.entries(p.byTemplate)) {
      lines.push(`| ${template} | ${t.category} | ${t.cases} | ${t.rows} | ${t.correct} | ${t.stale} | ${t.wrong} | ${t.unknown} | ${t.unparseable} | ${t.failed} | ${pct(t.accuracy)} | ${t.flag ?? ''} |`);
    }
    lines.push('', '| Probe | Answers | Correct | Stale | Wrong | Unknown | Unparseable | Failed |', '|---|---|---|---|---|---|---|---|');
    for (const [key, t] of Object.entries(p.probes)) {
      lines.push(`| ${key} | ${t.rows} | ${t.correct} | ${t.stale} | ${t.wrong} | ${t.unknown} | ${t.unparseable} | ${t.failed} |`);
    }
    lines.push('', `Probes no arm answered correctly in any repetition: ${m.neverCorrect.length ? `${new Set(m.neverCorrect.map((e) => `${e.template} ${e.probe}`)).size}, with ${m.neverCorrect.length} replies in pilot.json (arms hidden)` : 'none'}.`, '');
    const titles = { sessions: 'Sessions (the scripted messages): how the arms recorded', organizing: 'Organizing (the nights): how the organizer folded the words in', probes: 'Probes (the questions): how the arms answered' };
    for (const kind of ['sessions', 'organizing', 'probes']) {
      if (!ARMS.some((arm) => m.mechanics[arm][kind].conversations)) continue;
      lines.push(`### ${titles[kind]}`, '');
      const header = kind === 'probes'
        ? '| Arm | Conversations | Answered | Ended otherwise | Unparseable | Tool calls | Tool errors | Without a write | Requests | Retries |'
        : '| Arm | Conversations | Answered | Ended otherwise | Tool calls | Tool errors | Without a write | Requests | Retries |';
      lines.push(header, `|${header.split('|').slice(2).map(() => '---').join('|')}|`);
      for (const arm of ARMS) {
        const x = m.mechanics[arm][kind];
        if (!x.conversations) continue;
        const { answered, ...otherwise } = x.ended;
        const cells = [arm, x.conversations, answered, list(otherwise)];
        if (kind === 'probes') cells.push(x.unparseable);
        cells.push(x.toolCalls, x.toolErrors, x.withoutWrite, x.requests, x.retries);
        lines.push(`| ${cells.join(' | ')} |`);
      }
      lines.push('');
      for (const arm of ARMS) {
        const x = m.mechanics[arm][kind];
        if (!x.conversations) continue;
        lines.push(`**${arm}.** Tools: ${list(x.tools)}.`, '', `Tool errors: ${list(x.errors)}.`, '', `What each conversation wrote: ${list(x.writePatterns, 8)}.`, '');
      }
    }
    lines.push('### Tokens', '', '| Arm | Kind | Input | Cached | Output | Reasoning | System prompt (chars, mean) | Model time (s) |', '|---|---|---|---|---|---|---|---|');
    for (const arm of ARMS) {
      for (const kind of ['sessions', 'organizing', 'probes']) {
        const x = m.mechanics[arm][kind];
        if (!x.conversations) continue;
        lines.push(`| ${arm} | ${kind} | ${num(x.tokens.input)} | ${num(x.tokens.cached)} | ${num(x.tokens.output)} | ${num(x.tokens.reasoning)} | ${num(x.systemChars)} | ${Math.round(x.latencyMs / 1000).toLocaleString('en')} |`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
