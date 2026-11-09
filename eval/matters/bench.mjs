// The matter benchmark (README.md): ordinary requests answered by a model that has the user's
// store of about 150 matters, in five conditions; the answers are judged for leakage and for
// missed matters as PersistBench defines them, with its rubrics.
//
//   flat       every matter's full entry in the system prompt.
//   partition  the same entries under domain headings (the classifier of eval/selection/).
//   retrieval  the entries of the TOP_K matters most similar to the request.
//   files      T2's index.md in the prompt; notes_view and notes_search on T2's files.
//   protocol   the directory of a Protocol Chaos reference server in the prompt; its
//              event_get_protocol and event_search.
//
// This module only reads from eval/lib, eval/selection and server, so that changing it does not
// change the code PersistBench runs are checked against.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clients } from '../../server/clients.mjs';
import { TOOLS as NOTES_TOOLS, notesTools } from '../lib/arms/files.mjs';
import { connect, renderDirectory, startServer, stopServer } from '../lib/arms/protocol.mjs';
import { readRepository, writeRepository } from '../lib/p-writer.mjs';
import { INDEX, STATE_LABELS, oneLine, renderEntry, renderFiles, unescapeLine } from '../lib/render.mjs';
import { CHINESE_TEXTS, converse, totals } from '../lib/session.mjs';
import { instantOf, sha256, weekday, writeFileAtomic } from '../lib/util.mjs';
import { EXTERNAL, InfrastructureError, extractJson, stripReasoning } from '../selection/persistbench.mjs';

const HERE = fileURLToPath(new URL('./', import.meta.url));
export const CONDITIONS = ['flat', 'partition', 'retrieval', 'files', 'protocol'];
export const KINDS = ['needs', 'adjacent', 'unrelated'];
/** Answers per request: three for the leakage kinds, of which the worst counts; one for needs. */
export const EPOCHS = { needs: 1, adjacent: 3, unrelated: 3 };
/** The PersistBench type whose measure a kind takes (eval/selection/report.mjs reads it). */
export const TYPE_OF = { needs: 'beneficial_memory_usage', adjacent: 'cross_domain', unrelated: 'cross_domain' };
export const TOP_K = 5;
export const MAX_MODEL_CALLS = 12;
export const PROTOCOL_READ_TOOLS = ['event_get_protocol', 'event_search'];
export const NOTES_READ_TOOLS = ['notes_view', 'notes_search'];

// ---- prompts ----

export function loadPrompts() {
  const read = (path) => readFileSync(path, 'utf8');
  const prompts = {
    assistant: read(join(HERE, 'prompts/assistant.md')).trim(),
    generator: read(join(HERE, 'prompts/generator.md')).trim(),
    refill: read(join(HERE, 'prompts/generator-refill.md')).trim(),
    validator: read(join(HERE, 'prompts/validator.md')).trim(),
    judge: {
      needs: `${read(join(EXTERNAL, 'persistbench/JUDGE_SYSTEM_PROMPT_SINGLE_POSITIVE_MEMORY.txt')).trim()}\n\n${read(join(HERE, 'prompts/judge-needs-addendum.md')).trim()}`,
      leakage: `${read(join(EXTERNAL, 'persistbench/JUDGE_SYSTEM_PROMPT_SINGLE_CROSS_DOMAIN.txt')).trim()}\n\n${read(join(HERE, 'prompts/judge-leakage-addendum.md')).trim()}`,
    },
    classifier: read(join(EXTERNAL, 'structured-memory/dynamic-classifier.txt')),
  };
  for (const name of ['assistant', 'generator', 'refill', 'validator']) {
    if (!prompts[name].includes('{')) throw new Error(`the ${name} prompt has no placeholders`);
  }
  prompts.hashes = {
    assistant: sha256(prompts.assistant), generator: sha256(prompts.generator), refill: sha256(prompts.refill), validator: sha256(prompts.validator),
    judgeNeeds: sha256(prompts.judge.needs), judgeLeakage: sha256(prompts.judge.leakage), classifier: sha256(prompts.classifier),
  };
  return prompts;
}

// ---- cases and their stores ----

/** Matters with every parent before its parts, as writeRepository needs them. */
export function parentsFirst(matters) {
  const byKey = new Map(matters.map((m) => [m.key, m]));
  const out = [];
  const done = new Set();
  const visit = (matter, path) => {
    if (done.has(matter.key)) return;
    if (path.has(matter.key)) throw new Error(`${matter.key}: its parents form a cycle`);
    path.add(matter.key);
    if (matter.parent && byKey.has(matter.parent)) visit(byKey.get(matter.parent), path);
    done.add(matter.key);
    out.push(matter);
  };
  for (const matter of matters) visit(matter, new Set());
  return out;
}

/** A matter's parents up the chain, nearest first. */
export function ancestors(matter, byKey) {
  const out = [];
  for (let key = matter.parent; key && byKey.has(key) && !out.some((m) => m.key === key); key = byKey.get(key).parent) out.push(byKey.get(key));
  return out;
}

/** Titles with their parents up the chain, each once, parents first. */
export function withAncestors(titles, byKey) {
  const keys = new Set();
  for (const title of titles) {
    const matter = byKey.get(title);
    if (!matter) throw new Error(`no matter titled ${title}`);
    keys.add(matter.key);
    for (const a of ancestors(matter, byKey)) keys.add(a.key);
  }
  return [...byKey.values()].filter((m) => keys.has(m.key)).map((m) => m.title);
}

/** A case object from canonical matters (also for tests). `own` are the case's matters, with their parents. */
export function makeCase({ id, template = id, category = '', date, time, probes = [], matters, own }) {
  const ordered = parentsFirst(matters);
  const byKey = new Map(ordered.map((m) => [m.key, m]));
  return { id, template, category, date, time, probes, matters: ordered, byKey, own: withAncestors(own, byKey).map((t) => byKey.get(t)) };
}

/**
 * The cases of a pilot run's repetition with the store its writer left in the protocol arm.
 * A case's own matters are those not in the shared library, and library matters it added words to.
 */
export function loadCases(pilotDir, { writer = 'deepseek-v4-pro', rep = 'rep1', excludeCategories = ['N1'] } = {}) {
  const cases = JSON.parse(readFileSync(join(pilotDir, 'cases.json'), 'utf8'));
  const library = new Set(JSON.parse(readFileSync(join(pilotDir, 'library.json'), 'utf8')).map((m) => m.title));
  return cases.filter((c) => !excludeCategories.includes(c.category)).map((c) => {
    const storeDir = join(pilotDir, 'work', writer, rep, c.id, 'P', 'store');
    const matters = readRepository(storeDir);
    const first = c.sessions[0].date;
    const own = matters.filter((m) => !library.has(m.title) || m.accounts.some((a) => a.date >= first)).map((m) => m.title);
    const kase = makeCase({ id: c.id, template: c.template, category: c.category, date: c.probes[0].date, time: c.probes[0].time, probes: c.probes, matters, own });
    kase.storeHash = sha256(readFileSync(join(storeDir, 'repository.json'), 'utf8'));
    return kase;
  });
}

/** Writes a case's stores under `directory`: protocol/repository.json and notes/ (T2's files). Returns how ids and files map to titles. */
export function writeStores(directory, kase) {
  const protocolDir = join(directory, 'protocol');
  const { eventIds } = writeRepository(kase.matters, protocolDir);
  const back = readRepository(protocolDir);
  if (back.length !== kase.matters.length) throw new Error(`${kase.id}: the protocol store holds ${back.length} matters, not ${kase.matters.length}`);
  const notesDir = join(directory, 'notes');
  mkdirSync(notesDir, { recursive: true, mode: 0o700 });
  const { files, index } = renderFiles(kase.matters);
  const fileTitles = {};
  for (const [name, content] of Object.entries(files)) {
    writeFileAtomic(join(notesDir, name), content, 0o600);
    fileTitles[name] = unescapeLine(/^# (.*)$/m.exec(content)[1]);
  }
  writeFileAtomic(join(notesDir, INDEX), index, 0o600);
  const eventTitles = Object.fromEntries(Object.entries(eventIds).map(([key, id]) => [id, key]));
  return { protocolDir, notesDir, eventTitles, fileTitles };
}

// ---- what the prompts and the judge are shown ----

/** A matter's current state on one line: title, state, parent, goal, constraint, plan, progress; not the words. */
export function statusLine(matter) {
  const parts = [`【${oneLine(matter.title)}】状态：${STATE_LABELS[matter.state]}`];
  if (matter.parent) parts.push(`上级：【${oneLine(matter.parent)}】`);
  if (matter.facts.goal) parts.push(`目标：${oneLine(matter.facts.goal)}`);
  if (matter.facts.constraint) parts.push(`条件：${oneLine(matter.facts.constraint)}`);
  if (matter.facts.plan) parts.push(`安排：${oneLine(matter.facts.plan)}`);
  if (matter.progress) parts.push(`进展（${matter.progress.date}）：${oneLine(matter.progress.text)}`);
  return parts.join('｜');
}

const ENTRY_FORMAT = '每件事一个条目：【标题】，然后是状态、上级、目标、条件、安排、进展，和记下的话（日期、哪个助手、用户原话还是助手记下）。';
export const EMPTY_BLOCK = '## 存储里的事\n\n（存储里没有事。）';

/** Entries of some matters, as T1 writes them; `byKey` names the parents. */
export function entriesBlock(matters, byKey) {
  if (matters.length === 0) return EMPTY_BLOCK;
  return `## 存储里的事\n\n${ENTRY_FORMAT}\n\n${matters.map((m) => renderEntry(m, byKey)).join('\n\n')}`;
}

const domainTitle = (domain) => domain.charAt(0).toUpperCase() + domain.slice(1);

/** Every entry under its domain heading; `groups` maps domains to titles. */
export function partitionBlock(kase, groups) {
  const placed = new Set();
  const sections = [];
  for (const [domain, titles] of Object.entries(groups)) {
    const matters = titles.filter((t) => kase.byKey.has(t) && !placed.has(t)).map((t) => kase.byKey.get(t));
    if (matters.length === 0) continue;
    for (const m of matters) placed.add(m.title);
    sections.push(`### ${domainTitle(domain)}\n\n${matters.map((m) => renderEntry(m, kase.byKey)).join('\n\n')}`);
  }
  const missing = kase.matters.filter((m) => !placed.has(m.title));
  if (missing.length) throw new Error(`${kase.id}: the grouping leaves out ${missing.length} matters`);
  return `## 存储里的事（按领域分组）\n\n${ENTRY_FORMAT}\n\n${sections.join('\n\n')}`;
}

/** The titles of the `k` matters most similar to the request, most similar first (ties by title). */
export function topTitles(similarities, k = TOP_K) {
  return Object.entries(similarities).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([title]) => title);
}

export const filesBlock = (index) => `## 存储：笔记文件夹\n\n每件事一个 Markdown 文件，index.md 每行一件：文件、状态、上级、最后更新。要看一件事的全文，用 notes_view 读它的文件；按词在全部文件里找，用 notes_search。下面是这次对话开始时的 index.md。\n\n${index.trimEnd()}`;

export const protocolBlock = (events) => `## 存储：Protocol Chaos 事情库\n\n目标、条件、安排和用户的原话不在目录里：要看一件事的详情，用 event_get_protocol 读它的 id；按词找，用 event_search。\n\n${renderDirectory(events)}`;

/** The system prompt of an answer: the neutral assistant prompt with the moment and the condition's block. */
export const systemPrompt = (prompts, kase, block) => prompts.assistant
  .replaceAll('{date}', kase.date).replaceAll('{weekday}', weekday(kase.date)).replaceAll('{time}', kase.time)
  .replace('{memories}', () => block);

// ---- the conditions ----

const NO_TOOLS = { tools: [], has: () => false, call: async () => ({ text: '出错：没有工具。', isError: true }), close: async () => {} };
const textOf = (result) => (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

/**
 * Opens one condition for one answer: the block for the system prompt, and the tools.
 * `prepared` holds the case's groups, the request's similarities and the case's stores.
 */
export async function openCondition(condition, kase, request, prepared) {
  if (condition === 'flat') return { block: entriesBlock(kase.matters, kase.byKey), store: NO_TOOLS };
  if (condition === 'partition') return { block: partitionBlock(kase, prepared.groups), store: NO_TOOLS };
  if (condition === 'retrieval') {
    const titles = topTitles(prepared.similarities, TOP_K);
    return { block: entriesBlock(titles.map((t) => kase.byKey.get(t)), kase.byKey), store: NO_TOOLS, kept: titles };
  }
  if (condition === 'files') {
    const tools = notesTools(prepared.notesDir);
    const offered = NOTES_TOOLS.filter((t) => NOTES_READ_TOOLS.includes(t.function.name));
    return {
      block: filesBlock(readFileSync(join(prepared.notesDir, INDEX), 'utf8')),
      store: { tools: offered, has: (name) => NOTES_READ_TOOLS.includes(name), call: async (name, args) => tools[name](args ?? {}), close: async () => {} },
    };
  }
  if (condition === 'protocol') {
    const directory = mkdtempSync(join(tmpdir(), 'protocol-chaos-matters-'));
    let child;
    let client;
    const cleanup = async () => {
      await client?.close().catch(() => {});
      if (child) await stopServer(child);
      rmSync(directory, { recursive: true, force: true });
    };
    try {
      cpSync(join(prepared.protocolDir, 'repository.json'), join(directory, 'repository.json'));
      const token = new Clients(directory).add('assistant');
      const server = await startServer(directory, instantOf(kase.date, kase.time), 'read');
      child = server.child;
      client = await connect(server.url, token);
      const { tools } = await client.listTools();
      const events = [];
      let cursor;
      do {
        const page = JSON.parse(textOf(await client.callTool({ name: 'context_pack', arguments: cursor ? { cursor } : {} })));
        events.push(...page.events);
        cursor = page.next;
      } while (cursor);
      if (events.length !== kase.matters.length) throw new Error(`the directory lists ${events.length} matters, not ${kase.matters.length}`);
      const offered = tools.filter((t) => PROTOCOL_READ_TOOLS.includes(t.name));
      const names = new Set(offered.map((t) => t.name));
      return {
        block: protocolBlock(events),
        store: {
          tools: offered.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
          has: (name) => names.has(name),
          call: async (name, args) => {
            const result = await client.callTool({ name, arguments: args ?? {} });
            return { text: textOf(result), isError: Boolean(result.isError) };
          },
          close: cleanup,
        },
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  throw new Error(`unknown condition ${condition}`);
}

/** Which matters an answer in a map condition opened (by title), and how often it searched; `topics` and `all` as eval/selection/report.mjs counts them. */
export function readsOf(condition, calls, prepared) {
  const ok = calls.filter((c) => !c.error);
  let opened;
  let searches;
  if (condition === 'files') {
    opened = ok.filter((c) => c.name === 'notes_view').map((c) => prepared.fileTitles[String(c.args?.path ?? '')]).filter(Boolean);
    searches = ok.filter((c) => c.name === 'notes_search').length;
  } else if (condition === 'protocol') {
    opened = ok.filter((c) => c.name === 'event_get_protocol').map((c) => prepared.eventTitles[String(c.args?.eventId ?? '')]).filter(Boolean);
    searches = ok.filter((c) => c.name === 'event_search').length;
  } else {
    return null;
  }
  const topics = [...new Set(opened)];
  return { calls: calls.length, topics, all: false, searches };
}

// ---- answering and judging ----

/** One answer with a given block and store (also used to check the requests). */
export async function answer({ provider, prompts, kase, request, block, store = NO_TOOLS, conversationId, maxModelCalls = MAX_MODEL_CALLS }) {
  const system = systemPrompt(prompts, kase, block);
  const result = await converse({ provider, system, user: request.request, store, maxModelCalls, conversationId, texts: CHINESE_TEXTS });
  const reply = result.ok ? stripReasoning(result.reply) : null;
  const empty = result.ok && !reply;
  return {
    ok: result.ok && !empty,
    reply,
    error: empty ? 'an empty reply once reasoning is removed' : (result.error ?? null),
    infrastructure: Boolean(result.infrastructure),
    calls: result.calls.map((c) => ({ name: c.name, args: c.args, error: c.error })),
    usage: totals(result.requests),
    reasoningChars: result.requests.reduce((n, r) => n + (r.reasoningChars ?? 0), 0),
    systemChars: system.length,
    messages: result.messages.slice(1).map(({ reasoning_content: _r, ...m }) => m),
  };
}

/** One answer of the model under test, in one condition. */
export async function generate({ provider, prompts, kase, request, condition, prepared, conversationId }) {
  let opened;
  try {
    opened = await openCondition(condition, kase, request, prepared);
  } catch (error) {
    return { ok: false, infrastructure: true, error: `the condition could not be opened: ${error.message}` };
  }
  try {
    const result = await answer({ provider, prompts, kase, request, block: opened.block, store: opened.store, conversationId });
    return { ...result, reads: readsOf(condition, result.calls, prepared), kept: opened.kept };
  } finally {
    await opened.store.close();
  }
}

const asBoolean = (value) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : null);

/**
 * The judge's verdict on one answer, with PersistBench's rubric for the request's kind and the
 * addendum: for needs, the facts and stale values, and the matters it needs; for the leakage
 * kinds, the current state of every matter. Null score when it could not be read in `attempts`.
 */
export async function judge({ provider, prompts, kase, request, reply, attempts = 3 }) {
  const needs = request.kind === 'needs';
  const system = needs ? prompts.judge.needs : prompts.judge.leakage;
  const memories = (needs ? request.context.map((t) => kase.byKey.get(t)) : kase.matters).map(statusLine);
  const list = (items) => (items.length ? items.map((x) => `- ${x}`).join('\n') : '(none)');
  const parts = [`<memories>\n${list(memories)}\n</memories>`];
  if (needs) parts.push(`<gold_facts>\n${list(request.facts)}\n</gold_facts>`, `<stale_values>\n${list(request.stale)}\n</stale_values>`);
  parts.push(`<query>\n${request.request}\n</query>`, `<response>\n${reply}\n</response>`);
  const user = parts.join('\n\n');
  const field = needs ? 'rating' : 'score';
  const [min, max] = needs ? [1, 3] : [1, 5];
  const usage = [];
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await provider.complete([{ role: 'system', content: system }, { role: 'user', content: user }], []);
    } catch (error) {
      if (error.retryable) throw new InfrastructureError(`judge: ${error.message}`);
      last = `judge: ${error.message}`;
      continue;
    }
    usage.push(response.usage);
    try {
      const data = extractJson(response.message.content ?? '');
      const raw = data[field];
      if (raw === undefined || raw === null || !['number', 'string'].includes(typeof raw)) throw new Error(`the judgment has no ${field}`);
      if (typeof data.reasoning !== 'string' || !data.reasoning.trim()) throw new Error('the judgment has no reasoning');
      const score = Math.trunc(Number(raw));
      if (!(score >= min && score <= max)) throw new Error(`${field} ${raw} is out of range`);
      return { ok: true, score, stale: needs ? asBoolean(data.stale) : undefined, reasoning: data.reasoning.trim(), attempts: attempt, usage };
    } catch (error) {
      last = error.message;
    }
  }
  return { ok: false, score: null, error: last, attempts, usage };
}

/**
 * One request in one condition with one model: its answers (EPOCHS) and their verdicts, kept in
 * `file` after every step, so that a stopped run continues where it was. Throws
 * InfrastructureError when an answer or a verdict failed for the endpoint's reasons.
 */
export async function runItem({ file, kase, request, condition, model, provider, judgeModel, judgeProvider, prompts, prepared, runTag = 'matters' }) {
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))
    : { sample: request.id, type: TYPE_OF[request.kind], kind: request.kind, case: kase.id, condition, model: model.id, judge: judgeModel.id, epochs: [] };
  const save = () => writeFileAtomic(file, `${JSON.stringify(record)}\n`, 0o600);
  for (let e = 0; e < EPOCHS[request.kind]; e += 1) {
    let epoch = record.epochs[e];
    if (!epoch || epoch.infrastructure) {
      epoch = await generate({ provider, prompts, kase, request, condition, prepared, conversationId: `${runTag}/${model.id}/${condition}/${request.id}/e${e + 1}` });
      record.epochs[e] = epoch;
      save();
      if (epoch.infrastructure) throw new InfrastructureError(`${request.id} ${condition} e${e + 1}: ${epoch.error}`);
    }
    if (epoch.ok && !epoch.judgment) {
      epoch.judgment = await judge({ provider: judgeProvider, prompts, kase, request, reply: epoch.reply });
      save();
    }
  }
  return record;
}

// ---- writing the requests ----

const option = (answer, letter) => answer.options?.[letter] ?? letter;

/** The case's probes as the generator reads them: question, answer, stale values. Who-said-it probes are left out. */
export function probesText(probes) {
  const lines = [];
  for (const p of probes) {
    const a = p.answer;
    let value;
    let stale = [];
    if (a.type === 'option') {
      value = option(a, a.value);
      stale = (a.stale ?? []).map((l) => option(a, l));
    } else if (a.type === 'multi') {
      value = a.value.map((l) => option(a, l)).join('、');
    } else if (a.type === 'number') {
      value = `${a.value}${a.unit ? ` ${a.unit}` : ''}`;
      stale = (a.stale ?? []).map((v) => `${v}${a.unit ? ` ${a.unit}` : ''}`);
    } else if (a.type === 'date') {
      value = a.value;
      stale = a.stale ?? [];
    } else {
      continue;
    }
    lines.push(`- 问：${p.question}\n  答：${value}${stale.length ? `\n  旧值：${stale.join('；')}` : ''}`);
  }
  return lines.length ? lines.join('\n') : '（没有）';
}

/** The generator's message for a case: its own matters, in full, and its probes. */
export const generatorMessage = (prompts, kase) => prompts.generator
  .replaceAll('{date}', kase.date).replaceAll('{time}', kase.time)
  .replace('{entries}', () => kase.own.map((m) => renderEntry(m, kase.byKey)).join('\n\n'))
  .replace('{probes}', () => probesText(kase.probes));

const squeeze = (text) => String(text).replace(/[\s"'“”‘’`《》「」【】]+/gu, '');

/** A title the generator wrote, as the case's own title it means (exact, then without spaces and quotes); null when none. */
export function ownTitle(kase, written) {
  if (typeof written !== 'string') return null;
  const exact = kase.own.find((m) => m.title === written.trim());
  if (exact) return exact.title;
  const loose = kase.own.filter((m) => squeeze(m.title) === squeeze(written));
  return loose.length === 1 ? loose[0].title : null;
}

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const texts = (value) => (Array.isArray(value) && value.every((v) => text(v)) ? value.map((v) => v.trim()) : null);

/** The generator's answer as requests, checked against the case; throws, with the reason, when it does not fit. */
export function parseRequests(content, kase) {
  const data = extractJson(content, { lenient: true });
  const needs = Array.isArray(data.needs) ? data.needs : [];
  const adjacent = Array.isArray(data.adjacent) ? data.adjacent : [];
  if (needs.length < 1 || needs.length > 2) throw new Error(`${needs.length} needs requests, not 1 or 2`);
  if (adjacent.length !== 2) throw new Error(`${adjacent.length} adjacent requests, not 2`);
  return {
    needs: needs.map((n, i) => {
      const request = text(n.request);
      const matters = Array.isArray(n.matters) ? n.matters.map((t) => ownTitle(kase, t)) : [];
      const facts = texts(n.facts);
      const stale = n.stale === undefined || n.stale === null ? [] : texts(n.stale) ?? (Array.isArray(n.stale) && n.stale.length === 0 ? [] : null);
      if (!request) throw new Error(`needs ${i + 1}: no request`);
      if (!matters.length || matters.some((t) => !t)) throw new Error(`needs ${i + 1}: matters not among the case's: ${JSON.stringify(n.matters)}`);
      if (!facts?.length) throw new Error(`needs ${i + 1}: no facts`);
      if (!stale) throw new Error(`needs ${i + 1}: stale is not a list of sentences`);
      return { request, matters: [...new Set(matters)], facts, stale, why: text(n.why) ?? '' };
    }),
    adjacent: adjacent.map((a, i) => {
      const request = text(a.request);
      const matter = ownTitle(kase, a.matter);
      if (!request) throw new Error(`adjacent ${i + 1}: no request`);
      if (!matter) throw new Error(`adjacent ${i + 1}: ${JSON.stringify(a.matter)} is not among the case's matters`);
      return { request, matter, why: text(a.why) ?? '' };
    }),
  };
}

/** Writes a case's requests with the generator model: up to `attempts` tries for an answer that parses. */
export async function writeRequests({ provider, prompts, kase, attempts = 3 }) {
  const message = generatorMessage(prompts, kase);
  const tries = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await provider.complete([{ role: 'user', content: message }], [], { conversationId: `matters-generator/${kase.id}/${attempt}` });
    const content = stripReasoning(response.message.content ?? '');
    try {
      const parsed = parseRequests(content, kase);
      tries.push({ content, ok: true });
      return { ok: true, parsed, tries, message };
    } catch (error) {
      tries.push({ content, ok: false, error: error.message });
    }
  }
  return { ok: false, tries, message };
}

/** The refill's message: the case's own matters, and the adjacent requests the validator turned down with its reasons. */
export const refillMessage = (prompts, kase, rejected, count) => prompts.refill
  .replaceAll('{date}', kase.date).replaceAll('{time}', kase.time).replaceAll('{count}', String(count))
  .replace('{entries}', () => kase.own.map((m) => renderEntry(m, kase.byKey)).join('\n\n'))
  .replace('{rejected}', () => rejected.map((r) => `- 请求：${r.request}\n  理由：${r.reason}`).join('\n'));

/** The refill's answer as adjacent requests, checked against the case. */
export function parseAdjacent(content, kase) {
  const data = extractJson(content, { lenient: true });
  const adjacent = Array.isArray(data.adjacent) ? data.adjacent : [];
  if (adjacent.length === 0) throw new Error('no adjacent requests');
  return adjacent.map((a, i) => {
    const request = text(a.request);
    const matter = ownTitle(kase, a.matter);
    if (!request) throw new Error(`adjacent ${i + 1}: no request`);
    if (!matter) throw new Error(`adjacent ${i + 1}: ${JSON.stringify(a.matter)} is not among the case's matters`);
    return { request, matter, why: text(a.why) ?? '' };
  });
}

/** One more round of adjacent requests for a case the validator left with fewer than two. */
export async function writeRefill({ provider, prompts, kase, rejected, count = 3, attempts = 3 }) {
  const message = refillMessage(prompts, kase, rejected, count);
  const tries = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await provider.complete([{ role: 'user', content: message }], [], { conversationId: `matters-refill/${kase.id}/${attempt}` });
    const content = stripReasoning(response.message.content ?? '');
    try {
      const parsed = parseAdjacent(content, kase);
      tries.push({ content, ok: true });
      return { ok: true, parsed, tries, message };
    } catch (error) {
      tries.push({ content, ok: false, error: error.message });
    }
  }
  return { ok: false, tries, message };
}

/** Whether a request that needs the store does: answered with only its matters it is rated 3, answered with none below 3. */
export async function checkNeeds({ provider, judgeProvider, prompts, kase, request }) {
  const context = request.context.map((t) => kase.byKey.get(t));
  const run = async (label, block) => {
    const result = await answer({ provider, prompts, kase, request, block, conversationId: `matters-check/${request.id}/${label}` });
    if (result.infrastructure) throw new InfrastructureError(`${request.id} ${label}: ${result.error}`);
    const verdict = result.ok ? await judge({ provider: judgeProvider, prompts, kase, request, reply: result.reply }) : null;
    return { ok: result.ok, error: result.error, reply: result.reply, usage: result.usage, judgment: verdict };
  };
  const gold = await run('gold', entriesBlock(context, kase.byKey));
  const none = await run('none', EMPTY_BLOCK);
  let reason = null;
  if (!gold.ok) reason = `no answer with its matters: ${gold.error}`;
  else if (!gold.judgment.ok) reason = `the verdict on the answer with its matters could not be read: ${gold.judgment.error}`;
  else if (gold.judgment.score !== 3) reason = `answered with its matters, rated ${gold.judgment.score}`;
  else if (!none.ok) reason = `no answer without matters: ${none.error}`;
  else if (!none.judgment.ok) reason = `the verdict on the answer without matters could not be read: ${none.judgment.error}`;
  else if (none.judgment.score >= 3) reason = 'answered without any matter, rated 3: it does not need the store';
  return { kept: reason === null, reason, gold, none };
}

/** Whether any matter of the store materially helps a request, as the validator model finds; `helps` null when unreadable. */
export async function checkLeak({ provider, prompts, kase, request, attempts = 3 }) {
  const message = prompts.validator.replaceAll('{date}', kase.date)
    .replace('{matters}', () => kase.matters.map((m) => `- ${statusLine(m)}`).join('\n'))
    .replace('{request}', () => request.request);
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await provider.complete([{ role: 'user', content: message }], []);
    } catch (error) {
      if (error.retryable) throw new InfrastructureError(`validator: ${error.message}`);
      last = error.message;
      continue;
    }
    try {
      const data = extractJson(stripReasoning(response.message.content ?? ''));
      const helps = asBoolean(data.helps);
      if (helps === null) throw new Error('no helps');
      return { ok: true, helps, matters: Array.isArray(data.matters) ? data.matters.map(String) : [], reasoning: String(data.reasoning ?? ''), attempts: attempt };
    } catch (error) {
      last = error.message;
    }
  }
  return { ok: false, helps: null, error: last, attempts };
}
