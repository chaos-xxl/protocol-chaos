// Screening candidate models before the pilot, at the cost of a few conversations each: can
// the model use the protocol arm's 14 tools and the files arm's five, with the real system
// prompts, follow the answer format, and does the endpoint report usage and serve repeated
// prefixes from its cache? Each model gets four conversations from one dev case:
//   P1   the case's first message, in arm P, on a fresh store
//   P2   the same again on another fresh store (the cache should now hold the prefix)
//   T2   the same message in arm T2
//   Q    after P1, a probe in arm P on P1's store, scored like any probe
// The screen says whether a model can take part; how well it does is for the experiment.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { ARMS, caseMatters } from './case.mjs';
import { loadPrompts, systemPrompt } from './prompts.mjs';
import { createProvider } from './provider.mjs';
import { probeMessage, score } from './score.mjs';
import { converse, totals } from './session.mjs';
import { copyDirectory, runLimited } from './util.mjs';

const CASE = 'd1-moving-budget~1';

/** A model's settings from a gateway description and the model's name there. */
export function modelFromGateway(gateway, name) {
  const matches = (pattern) => (pattern ? new RegExp(pattern, 'i').test(name) : false);
  const anthropic = matches(gateway.anthropicPattern);
  const api = gateway.models?.[name]?.api ?? (anthropic ? 'anthropic' : matches(gateway.responsesPattern) ? 'responses' : 'openai');
  return {
    id: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''),
    model: name,
    api,
    endpoint: { anthropic: gateway.anthropicEndpoint, responses: gateway.responsesEndpoint, openai: gateway.openaiEndpoint }[api],
    apiKeyEnv: gateway.apiKeyEnv,
    ...(gateway.conversationHeader ? { conversationHeader: gateway.conversationHeader } : {}),
    ...(gateway.requestIdHeader ? { requestIdHeader: gateway.requestIdHeader } : {}),
    body: { ...(gateway.body ?? {}), ...(gateway.models?.[name]?.body ?? {}) },
    passback: gateway.models?.[name]?.passback ?? (api === 'openai' ? gateway.passback ?? [] : []),
    concurrency: gateway.concurrency ?? 4,
    timeoutMs: gateway.timeoutMs ?? 180_000,
    maxRetries: gateway.maxRetries ?? 3,
  };
}

const usedTools = (messages) => messages.filter((m) => m.role === 'assistant').flatMap((m) => (m.tool_calls ?? []).map((c) => c.function.name));

async function conversation({ provider, prompts, arm, store, at, user, meta, tag }) {
  const handle = await ARMS[arm].open(store, { ...at, meta });
  try {
    const system = systemPrompt(prompts, arm, { ...at, view: handle.view });
    const result = await converse({ provider, system, user, store: handle, maxModelCalls: 12, conversationId: tag });
    return { result, system };
  } finally {
    await handle.close();
  }
}

/** Screens one model; never throws: a failure is part of the result. */
export async function screenModel(model, { library, caseDef, prompts, out, provider: given }) {
  const work = mkdtempSync(join(tmpdir(), 'protocol-chaos-screen-'));
  const record = { id: model.id, model: model.model, api: model.api ?? 'openai', conversations: {} };
  const keep = (name, value) => {
    const dir = join(out, 'conversations', model.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json.gz`), gzipSync(JSON.stringify(value)));
  };
  try {
    const provider = given ?? createProvider(model);
    const matters = caseMatters(library, caseDef);
    const session = caseDef.sessions[0];
    const probe = caseDef.probes[0];
    for (const [name, arm] of [['P1', 'P'], ['P2', 'P'], ['T2', 'T2']]) {
      const store = join(work, name);
      const meta = ARMS[arm].prepare(store, matters);
      const { result, system } = await conversation({ provider, prompts, arm, store, at: session, user: session.user, meta, tag: `screen/${model.id}/${name}` });
      keep(name, { system, messages: result.messages.slice(1), requests: result.requests, error: result.error ?? null });
      record.conversations[name] = { ok: result.ok, error: result.error ?? null, tools: usedTools(result.messages), toolErrors: result.toolErrors, ...totals(result.requests),
        firstCached: result.requests[0]?.usage?.cached ?? null, served: [...new Set(result.requests.map((r) => r.model).filter(Boolean))] };
      if (name === 'P1') record.meta = { store, meta };
    }
    // The probe, on the store P1 left (copied, as in the experiment).
    const copy = join(work, 'Q');
    copyDirectory(record.meta.store, copy);
    const user = probeMessage(probe.question, probe.answer);
    const { result, system } = await conversation({ provider, prompts, arm: 'P', store: copy, at: probe, user, meta: record.meta.meta, tag: `screen/${model.id}/Q` });
    keep('Q', { system, messages: result.messages.slice(1), requests: result.requests, error: result.error ?? null });
    // After only the first message the budget is the first value; the probe's gold answer is the last one.
    const scored = result.ok ? score({ ...probe.answer, value: caseDef.sessions[0].user.match(/\d+/)[0], stale: [] }, result.reply) : null;
    record.conversations.Q = { ok: result.ok, error: result.error ?? null, tools: usedTools(result.messages), toolErrors: result.toolErrors, ...totals(result.requests),
      outcome: scored?.outcome ?? 'failed', answer: scored?.value ?? null };
  } catch (error) {
    record.error = error.message;
  } finally {
    delete record.meta;
    rmSync(work, { recursive: true, force: true });
  }
  const c = record.conversations;
  const p1 = c.P1 ?? {};
  record.verdict = {
    recordsAndOrganizes: Boolean(p1.ok && p1.tools?.includes('event_note') && p1.tools?.includes('event_record_expression')),
    writesFiles: Boolean(c.T2?.ok && c.T2.tools?.some((t) => ['notes_create', 'notes_str_replace', 'notes_append'].includes(t))),
    answersInFormat: Boolean(c.Q?.ok && c.Q.outcome !== 'unparseable' && c.Q.outcome !== 'failed'),
    reportsUsage: Object.values(c).some((x) => x.requests > 0) ? Object.values(c).filter((x) => x.requests > 0).every((x) => x.input !== null && x.output !== null) : null,
    reportsCache: c.P2?.firstCached === null || c.P2?.firstCached === undefined ? null : c.P2.firstCached > 0,
  };
  return record;
}

export async function screen(models, { library, cases, out, concurrency = 4, providers = {} }) {
  const caseDef = cases.find((c) => c.id === CASE);
  if (!caseDef) throw new Error(`the screen needs the dev case ${CASE}`);
  const prompts = loadPrompts();
  return runLimited(models.map((model) => () => screenModel(model, { library, caseDef, prompts, out, provider: providers[model.id] })), concurrency);
}

const mark = (value) => (value === true ? 'yes' : value === false ? 'no' : '—');
const n = (value) => (value === null || value === undefined ? '—' : Number(value).toLocaleString('en'));

export function renderScreen(records) {
  const lines = [
    '# Model screen',
    '',
    `Four conversations per model from the dev case ${CASE}: P1 and P2 (the first message in arm P on fresh stores), T2 (the same in arm T2), Q (a probe in arm P after P1).`,
    '',
    '| Model | Records and organizes in P | Writes files in T2 | Answers in format | Usage | Cache on P2 | Tool calls P1 / T2 / Q | Tool errors | Requests | Time P1 (s) | Input P1 | Output P1 | Reasoning P1 | Served as | Error |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of records) {
    const c = r.conversations;
    const v = r.verdict;
    const errors = [r.error, ...Object.entries(c).map(([k, x]) => (x.error ? `${k}: ${x.error}` : null))].filter(Boolean).join('; ').replace(/\|/g, '/').slice(0, 160);
    lines.push(`| ${r.model} | ${mark(v.recordsAndOrganizes)} | ${mark(v.writesFiles)} | ${mark(v.answersInFormat)}${c.Q?.outcome ? ` (${c.Q.outcome})` : ''} | ${mark(v.reportsUsage)} | ${mark(v.reportsCache)}${c.P2?.firstCached ? ` (${n(c.P2.firstCached)})` : ''} | ${[c.P1, c.T2, c.Q].map((x) => x?.tools?.length ?? '—').join(' / ')} | ${[c.P1, c.T2, c.Q].reduce((s, x) => s + (x?.toolErrors ?? 0), 0)} | ${Object.values(c).reduce((s, x) => s + (x.requests ?? 0), 0)} | ${c.P1 ? (c.P1.latencyMs / 1000).toFixed(1) : '—'} | ${n(c.P1?.input)} | ${n(c.P1?.output)} | ${n(c.P1?.reasoning)} | ${(c.P1?.served ?? []).join(', ') || '—'} | ${errors || ''} |`);
  }
  return `${lines.join('\n')}\n`;
}
