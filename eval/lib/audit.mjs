// The store audit: what each arm's store holds once the sessions are over, checked by rules,
// with no model. The probes ask whether a strong model can still work the answer out; the
// audit asks whether the store itself is a faithful record, for any reader: another
// assistant, a weaker model, a program, the person. The definitions below were committed
// before the audit was first computed on any run.
//
// On the store as the last session left it, for every case run:
//   1. Words kept: every clause the person said in the sessions (split at 。！？；, and the
//      line breaks, then at ，、; questions and clauses under three characters left out) is
//      in the store word for word (after NFKC, without spaces and quotation marks).
//   2. History kept: every account of the starting store, the case's seeds and the
//      background library, is still in the store word for word.
//   3. Attributed: a kept clause is in a record that names the assistant and the date of the
//      conversation it was said in, and marks it as the person's own words. In P a record is
//      an account, whose assistant and date the server stamps; in T1 and T2 a record is a line
//      the model wrote, such as "- 2026-10-05 助手 A｜用户原话：「…」".
//   4. Claimed, not said: records written in the sessions (records the starting store did not
//      hold) that are marked as the person's own words but are not part of any message the
//      person sent: rewritten, merged or made up.
//   5. Matters added: how many matters the store holds beyond the starting ones.
//   6. Latest number in the current state: for a probe with a number answer, the number is in
//      the current state (everything but the records) of a matter the sessions added or changed.
// 2 and 3 are, in P, guaranteed by the server; 1, 4, 5 and 6 depend on the model in every arm.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import P from './arms/protocol.mjs';
import { NUMBER_RUN, parseNumberRun } from './score.mjs';
import T1 from './arms/entries.mjs';
import T2 from './arms/files.mjs';
import { Repository } from '../../server/repository.mjs';
import { beijingDate } from './util.mjs';

const ARMS = ['P', 'T1', 'T2'];
const IMPLEMENTATIONS = { P, T1, T2 };
const LETTER_OF = { 'assistant-a': 'A', 'assistant-b': 'B', 'assistant-c': 'C' };
const MIN_CLAUSE = 3;

/** The form text is compared in: NFKC, no whitespace, no quotation marks. */
export const normalize = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/gu, '').replace(/[「」『』“”"'‘’]/gu, '');

/** The clauses of a message that should be kept: questions and short fragments left out. */
export function clausesOf(message) {
  const sentences = String(message).match(/[^。！？!?；;\n]+[。！？!?；;\n]?/gu) ?? [];
  const out = [];
  for (const sentence of sentences) {
    if (/[？?]$/u.test(sentence.trim())) continue;
    for (const clause of sentence.replace(/[。！；;!\n]$/u, '').split(/[，,、]/u)) {
      const n = normalize(clause);
      if ([...n].length >= MIN_CLAUSE) out.push(n);
    }
  }
  return out;
}

/** Every number in a text, written with Arabic digits, Chinese numerals or both, read as the probes' answers are. */
export function numbersIn(text) {
  const out = [];
  const runs = new RegExp(NUMBER_RUN.source, 'gu');
  for (const m of String(text).normalize('NFKC').replace(/(\d),(?=\d{3})/g, '$1').matchAll(runs)) {
    const n = parseNumberRun(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const monthDay = (date) => {
  const [, m, d] = date.split('-').map(Number);
  return new RegExp(`(^|\\D)${m}月${d}[日号]`, 'u');
};
/** Whether a written record line names this assistant and date and marks the person's words. */
function lineAttributes(line, { assistant, date }) {
  const dated = line.includes(date) || monthDay(date).test(line);
  const who = new RegExp(`助手\\s*${assistant}(?![A-Za-z])`, 'u').test(line);
  return dated && who && line.includes('用户原话');
}

/**
 * The words of a record marked as the person's: what follows the label, inside its quotation
 * marks if it has them. The models write the label in several forms (用户原话：「…」,
 * 用户原话"…", 记下（用户原话）：…); any of them is read.
 */
export function wordsOfRecord(line) {
  const rest = line.slice(line.indexOf('用户原话') + '用户原话'.length).replace(/^[\s）)\]】:：]+/u, '');
  const close = { '「': '」', '“': '”', '"': '"', '『': '』', "'": "'" }[rest[0]];
  if (!close) return rest;
  const end = rest.indexOf(close, 1);
  return end > 0 ? rest.slice(1, end) : rest.slice(1);
}

/** A store, read the same way for every arm: matters with a current state and records. */
function readStore(arm, directory) {
  if (arm === 'P') {
    const snapshot = JSON.parse(readFileSync(join(directory, 'repository.json'), 'utf8'));
    const repo = new Repository();
    repo.importRepository({ snapshot });
    return [...repo.events.values()].map(({ doc, accounts }) => {
      const state = [doc.title, doc.facts?.goal, doc.facts?.constraint, doc.facts?.plan, doc.progress?.text].filter(Boolean).join('\n');
      const records = accounts.map((a) => ({
        text: a.text, assistant: LETTER_OF[a.actor?.id] ?? a.actor?.id, date: beijingDate(a.createdAt), user: a.source === 'user',
      }));
      return { state, records, text: [state, ...records.map((r) => r.text)].join('\n') };
    });
  }
  const blocks = arm === 'T1'
    ? JSON.parse(readFileSync(join(directory, 'entries.json'), 'utf8')).entries
    : readdirSync(join(directory, 'notes')).filter((n) => n.endsWith('.md') && n !== 'index.md').map((n) => readFileSync(join(directory, 'notes', n), 'utf8'));
  return blocks.map((block) => {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => (arm === 'T1' ? /^\s*记录[:：]/u.test(line) : /^##\s*记录/u.test(line)));
    const state = (at < 0 ? lines : lines.slice(0, at)).join('\n');
    const recordLines = at < 0 ? [] : lines.slice(at + 1).filter((line) => line.trim() && !/^\s*最后整理/u.test(line));
    const records = recordLines.map((line) => {
      const date = /(\d{4}-\d{2}-\d{2})/u.exec(line)?.[1] ?? null;
      // The record's own label is the first of the two; "用户原话" later in an assistant's note is not one.
      const user = /用户原话|助手记下/u.exec(line)?.[0] === '用户原话';
      return { line, text: user ? wordsOfRecord(line) : line, date, user };
    });
    return { state, records, text: block };
  });
}
/** Everything the arm's store holds as text, index.md included. */
function storeText(arm, directory, matters) {
  const index = arm === 'T2' && existsSync(join(directory, 'notes', 'index.md')) ? readFileSync(join(directory, 'notes', 'index.md'), 'utf8') : '';
  return normalize(`${matters.map((m) => m.text).join('\n')}\n${index}`);
}

/** The matters of the store a case run starts from, written afresh. */
function startingStore(arm, caseDef, library) {
  const directory = mkdtempSync(join(tmpdir(), 'protocol-chaos-audit-start-'));
  try {
    IMPLEMENTATIONS[arm].prepare(directory, [...library.slice(0, caseDef.library), ...caseDef.seeds]);
    return readStore(arm, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The audit of one case run. */
export function auditCaseRun({ caseDef, arm, storeDir, library }) {
  const matters = readStore(arm, storeDir);
  const start = startingStore(arm, caseDef, library);
  const startTexts = new Set(start.map((m) => normalize(m.text)));
  const startRecords = new Set(start.flatMap((m) => m.records.map((r) => normalize(r.line ?? `${r.date}|${r.assistant}|${r.text}`))));
  const all = storeText(arm, storeDir, matters);
  const messages = caseDef.sessions.map((s) => ({ ...s, normalized: normalize(s.user) }));
  // 1 and 3: the person's clauses, kept and attributed.
  let clauses = 0;
  let kept = 0;
  let attributed = 0;
  for (const session of messages) {
    for (const clause of clausesOf(session.user)) {
      clauses += 1;
      if (!all.includes(clause)) continue;
      kept += 1;
      const ok = matters.some((m) => m.records.some((r) => normalize(r.text).includes(clause)
        && (arm === 'P' ? r.user && r.assistant === session.assistant && r.date === session.date : lineAttributes(r.line, session))));
      if (ok) attributed += 1;
    }
  }
  // 2: the starting accounts.
  const seedTexts = caseDef.seeds.flatMap((s) => s.accounts.map((a) => normalize(a.text)));
  const libraryTexts = library.slice(0, caseDef.library).flatMap((m) => m.accounts.map((a) => normalize(a.text)));
  // 4: records of the sessions marked as the person's words.
  const fresh = matters.flatMap((m) => m.records.filter((r) => r.user && !startRecords.has(normalize(r.line ?? `${r.date}|${r.assistant}|${r.text}`))));
  const unsaid = fresh.filter((r) => {
    const words = normalize(r.text);
    return !words || !messages.some((s) => s.normalized.includes(words));
  });
  // 6: the latest number of each number probe, in the current state of a matter the sessions added or changed.
  const touched = matters.filter((m) => !startTexts.has(normalize(m.text)));
  const numberProbes = caseDef.probes.filter((p) => p.answer.type === 'number');
  const latest = numberProbes.filter((p) => touched.some((m) => numbersIn(m.state).some((n) => Math.abs(n - Number(p.answer.value)) < 1e-9)));
  return {
    clauses, kept, attributed,
    seedAccounts: seedTexts.length, seedKept: seedTexts.filter((t) => all.includes(t)).length,
    libraryAccounts: libraryTexts.length, libraryKept: libraryTexts.filter((t) => all.includes(t)).length,
    userRecords: fresh.length, unsaid: unsaid.length, unsaidExamples: unsaid.slice(0, 3).map((r) => r.text.slice(0, 80)),
    added: matters.length - start.length,
    numberProbes: numberProbes.length, latestInState: latest.length,
  };
}

/** The audit of a run: every case run's store, by model and arm. */
export function auditRun(runDir) {
  const cases = new Map(JSON.parse(readFileSync(join(runDir, 'cases.json'), 'utf8')).map((c) => [c.id, c]));
  const library = JSON.parse(readFileSync(join(runDir, 'library.json'), 'utf8'));
  const rows = [];
  const work = join(runDir, 'work');
  for (const model of readdirSync(work)) {
    for (const rep of readdirSync(join(work, model))) {
      for (const caseId of readdirSync(join(work, model, rep))) {
        for (const arm of ARMS) {
          const dir = join(work, model, rep, caseId, arm);
          const result = join(dir, 'result.json');
          if (!existsSync(result) || !existsSync(join(dir, 'store'))) continue;
          if (JSON.parse(readFileSync(result, 'utf8')).infrastructure) continue;
          const caseDef = cases.get(caseId);
          rows.push({ model, rep, case: caseId, template: caseDef.template, category: caseDef.category, arm, ...auditCaseRun({ caseDef, arm, storeDir: join(dir, 'store'), library }) });
        }
      }
    }
  }
  return rows;
}

const sum = (list, field) => list.reduce((n, r) => n + r[field], 0);
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');

/** The audit as Markdown: one table per model, and the matters added per template. */
export function renderAudit(rows, manifest = {}) {
  const lines = ['# Store audit', ''];
  lines.push('What each arm\'s store holds once the sessions are over, checked by rules (eval/lib/audit.mjs). Attribution and history are guaranteed by the server in P; the other measures depend on the model in every arm.', '');
  if (manifest.startedAt) lines.push(`Run started ${manifest.startedAt}; code ${manifest.git?.commit ?? '?'}; split ${manifest.split}.`, '');
  for (const model of [...new Set(rows.map((r) => r.model))].sort()) {
    const mine = rows.filter((r) => r.model === model);
    lines.push(`## ${model}`, '');
    lines.push('| Arm | Case runs | Words kept | Attributed (of kept) | Seed history kept | Background history kept | Claimed, not said | Latest number in the current state | Matters added, mean |', '|---|---|---|---|---|---|---|---|---|');
    for (const arm of ARMS) {
      const r = mine.filter((x) => x.arm === arm);
      if (!r.length) continue;
      lines.push(`| ${arm} | ${r.length} | ${pct(sum(r, 'kept'), sum(r, 'clauses'))} (${sum(r, 'kept')}/${sum(r, 'clauses')}) | ${pct(sum(r, 'attributed'), sum(r, 'kept'))} | ${pct(sum(r, 'seedKept'), sum(r, 'seedAccounts'))} | ${pct(sum(r, 'libraryKept'), sum(r, 'libraryAccounts'))} | ${sum(r, 'unsaid')} of ${sum(r, 'userRecords')} (${pct(sum(r, 'unsaid'), sum(r, 'userRecords'))}) | ${pct(sum(r, 'latestInState'), sum(r, 'numberProbes'))} (${sum(r, 'latestInState')}/${sum(r, 'numberProbes')}) | ${(sum(r, 'added') / r.length).toFixed(2)} |`);
    }
    lines.push('', '| Template | P added | T1 added | T2 added |', '|---|---|---|---|');
    for (const template of [...new Set(mine.map((r) => r.template))].sort()) {
      const cell = (arm) => {
        const r = mine.filter((x) => x.template === template && x.arm === arm);
        return r.length ? (sum(r, 'added') / r.length).toFixed(1) : '—';
      };
      lines.push(`| ${template} | ${cell('P')} | ${cell('T1')} | ${cell('T2')} |`);
    }
    const examples = ARMS.flatMap((arm) => mine.filter((x) => x.arm === arm && x.unsaidExamples.length).slice(0, 2).map((x) => `- ${arm} ${x.case} rep ${x.rep.replace('rep', '')}: ${x.unsaidExamples.map((e) => `「${e}」`).join('；')}`));
    if (examples.length) lines.push('', 'Examples of records claimed as the person\'s words but not said:', '', ...examples);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
