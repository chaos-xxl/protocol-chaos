// One case in one arm with one model: the starting store (the background library and the
// case's seeds), each scripted message as a new conversation, then each probe as a new
// conversation on its own copy of the store as the sessions left it. Every conversation is
// kept, compressed, next to the case's result.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import P from './arms/protocol.mjs';
import T1 from './arms/entries.mjs';
import T2 from './arms/files.mjs';
import { checkEquivalence } from './equivalence.mjs';
import { MODES, systemPrompt } from './prompts.mjs';
import { probeMessage, score } from './score.mjs';
import { converse, totals } from './session.mjs';
import { copyDirectory, writeJson } from './util.mjs';

export const ARMS = { P, T1, T2 };

/**
 * The endpoint or a local server failed, not the model: the case run is repeated, and if it
 * keeps failing it is left out of the analysis rather than scored.
 */
export class InfrastructureError extends Error {}

/** The matters a case starts from: the first `library` matters of the library, then its seeds. */
export const caseMatters = (library, caseDef) => [...library.slice(0, caseDef.library), ...caseDef.seeds];

/** When the organizer works (Beijing time): every night with sessions, after the day's conversations. */
export const ORGANIZE_TIME = '23:30';

/**
 * A case as it happens, in time order: the sessions, the probes and, in mode organized, one
 * organizing on the night of every day with a session. At the same minute a session comes
 * first, then a probe, then the organizing.
 */
export function timeline(caseDef, mode = 'inline') {
  const items = [
    ...caseDef.sessions.map((session) => ({ kind: 'session', at: session, name: `s${session.index}` })),
    ...caseDef.probes.map((probe) => ({ kind: 'probe', at: probe, name: probe.id })),
  ];
  if (mode === 'organized') {
    const nights = [...new Set(caseDef.sessions.map((s) => s.date))];
    nights.forEach((date, i) => items.push({ kind: 'organize', at: { date, time: ORGANIZE_TIME }, name: `o${i + 1}` }));
  }
  const rank = { session: 0, probe: 1, organize: 2 };
  return items
    .map((item, order) => ({ ...item, order }))
    .sort((a, b) => {
      const x = `${a.at.date} ${a.at.time}`;
      const y = `${b.at.date} ${b.at.time}`;
      return x < y ? -1 : x > y ? 1 : rank[a.kind] - rank[b.kind] || a.order - b.order;
    });
}

/** Writes the three starting stores of a case and checks they hold the same; returns the differences. */
export function verifyCase(library, caseDef, directory) {
  const matters = caseMatters(library, caseDef);
  const directories = {};
  for (const [name, arm] of Object.entries(ARMS)) {
    directories[name] = join(directory, name);
    arm.prepare(directories[name], matters);
  }
  return checkEquivalence(matters, directories);
}

function saveConversation(directory, name, record) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json.gz`), gzipSync(JSON.stringify(record)));
}

/**
 * Runs one case in one arm. Writes <directory>/result.json and returns it:
 * {rows: probe results, conversations: per-conversation counts}. `provider` writes (the
 * sessions); `readerProvider`, when given, answers the probes instead, as the model `reader`.
 * `mode` (prompts.mjs): inline, the assistants record and bring the current state up to date;
 * light, they only record; organized, they only record and `organizerProvider` (the model
 * `organizer`) folds the new words in every night.
 */
export async function runCase({
  caseDef, arm: armName, armImpl, model, rep, provider, readerProvider, reader, organizerProvider, organizer, mode = 'inline',
  library, directory, prompts, maxModelCalls = 25, keepStores = true, runTag = 'run',
}) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (mode === 'organized' && !organizerProvider) throw new Error('mode organized needs an organizer');
  const arm = armImpl ?? ARMS[armName];
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  const store = join(directory, 'store');
  const meta = arm.prepare(store, caseMatters(library, caseDef));
  const conversations = [];

  const talk = async (kind, name, at, user, storeDir, via = provider) => {
    const role = kind === 'organize' ? 'organizer' : 'assistant';
    let handle;
    try {
      handle = await arm.open(storeDir, { ...at, meta, mode, role });
    } catch (error) {
      throw new InfrastructureError(`${name}: the store could not be opened: ${error.message}`);
    }
    let result;
    let system;
    try {
      system = systemPrompt(prompts, armName, { ...at, view: handle.view, mode, role });
      result = await converse({ provider: via, system, user, store: handle, maxModelCalls, conversationId: `${runTag}/${model.id}/r${rep}/${caseDef.id}/${armName}/${name}` });
    } finally {
      await handle.close();
    }
    const counts = totals(result.requests);
    const summary = {
      kind, name, date: at.date, time: at.time, assistant: at.assistant, ok: result.ok, error: result.error ?? null,
      toolCalls: result.toolCalls, toolErrors: result.toolErrors, systemChars: system.length, ...counts,
      calls: result.calls.map((call) => ({ tool: arm.label(call.name, call.args), error: call.error })),
      models: [...new Set(result.requests.map((r) => r.model).filter(Boolean))],
      fingerprints: [...new Set(result.requests.map((r) => r.fingerprint).filter(Boolean))],
    };
    saveConversation(join(directory, 'conversations'), name, { ...summary, system, messages: result.messages.slice(1), requests: result.requests });
    conversations.push(summary);
    if (result.infrastructure) throw new InfrastructureError(`${name}: ${result.error}`);
    return result;
  };

  const rows = [];
  const organizing = mode === 'organized' ? arm.organizeStart(store) : null;
  let nightsDone = 0;
  let nightsSkipped = 0;
  for (const item of timeline(caseDef, mode)) {
    if (item.kind === 'session') {
      await talk('session', item.name, item.at, item.at.user, store);
      continue;
    }
    if (item.kind === 'organize') {
      // The organizer is given what is new since the last night; a night with nothing new is skipped, as an
      // organizer that finds nothing to do would do.
      const message = arm.organizeMessage(store, organizing, item.at);
      if (message === null) {
        nightsSkipped += 1;
        continue;
      }
      await talk('organize', item.name, item.at, message, store, organizerProvider);
      arm.organizeDone(store, organizing);
      nightsDone += 1;
      continue;
    }
    const probe = item.at;
    const copy = join(directory, 'probes', probe.id);
    copyDirectory(store, copy);
    const result = await talk('probe', probe.id, probe, probeMessage(probe.question, probe.answer), copy, readerProvider ?? provider);
    const scored = result.ok ? score(probe.answer, result.reply) : { outcome: 'failed', value: null, normalized: null, method: result.error };
    const summary = conversations.at(-1);
    rows.push({
      model: model.id, reader: reader ?? model.id, rep, template: caseDef.template, case: caseDef.id, probe: probe.id, category: caseDef.category, arm: armName,
      library: caseDef.library, scale: Boolean(caseDef.scale), author: caseDef.author,
      mode, organizer: organizer ?? null, nightsBefore: nightsDone,
      question: probe.question, gold: probe.answer,
      ...scored, reply: result.reply ?? null,
      probeInput: summary.input, probeCached: summary.cached, probeOutput: summary.output, probeRequests: summary.requests,
    });
    if (!keepStores) rmSync(copy, { recursive: true, force: true });
  }
  const record = {
    case: caseDef.id, arm: armName, model: model.id, reader: reader ?? model.id, rep, mode, organizer: organizer ?? null,
    nights: { done: nightsDone, skipped: nightsSkipped }, finishedAt: new Date().toISOString(), rows, conversations,
  };
  writeJson(join(directory, 'result.json'), record);
  return record;
}
