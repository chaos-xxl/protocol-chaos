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
import { systemPrompt } from './prompts.mjs';
import { probeMessage, score } from './score.mjs';
import { converse, totals } from './session.mjs';
import { copyDirectory, writeJson } from './util.mjs';

export const ARMS = { P, T1, T2 };

/** The matters a case starts from: the first `library` matters of the library, then its seeds. */
export const caseMatters = (library, caseDef) => [...library.slice(0, caseDef.library), ...caseDef.seeds];

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
 * {rows: probe results, conversations: per-conversation counts}.
 */
export async function runCase({ caseDef, arm: armName, model, rep, provider, library, directory, prompts, maxModelCalls = 25, keepStores = true }) {
  const arm = ARMS[armName];
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  const store = join(directory, 'store');
  const meta = arm.prepare(store, caseMatters(library, caseDef));
  const conversations = [];

  const talk = async (kind, name, at, user, storeDir) => {
    const handle = await arm.open(storeDir, { ...at, meta });
    let result;
    let system;
    try {
      system = systemPrompt(prompts, armName, { ...at, view: handle.view });
      result = await converse({ provider, system, user, store: handle, maxModelCalls });
    } finally {
      await handle.close();
    }
    const counts = totals(result.requests);
    const summary = {
      kind, name, date: at.date, time: at.time, assistant: at.assistant, ok: result.ok, error: result.error ?? null,
      toolCalls: result.toolCalls, toolErrors: result.toolErrors, systemChars: system.length, ...counts,
      models: [...new Set(result.requests.map((r) => r.model).filter(Boolean))],
      fingerprints: [...new Set(result.requests.map((r) => r.fingerprint).filter(Boolean))],
    };
    saveConversation(join(directory, 'conversations'), name, { ...summary, system, messages: result.messages.slice(1), requests: result.requests });
    conversations.push(summary);
    return result;
  };

  for (const session of caseDef.sessions) {
    await talk('session', `s${session.index}`, session, session.user, store);
  }
  const rows = [];
  for (const probe of caseDef.probes) {
    const copy = join(directory, 'probes', probe.id);
    copyDirectory(store, copy);
    const result = await talk('probe', probe.id, probe, probeMessage(probe.question, probe.answer), copy);
    const scored = result.ok ? score(probe.answer, result.reply) : { outcome: 'failed', value: null, normalized: null, method: result.error };
    const summary = conversations.at(-1);
    rows.push({
      model: model.id, rep, template: caseDef.template, case: caseDef.id, probe: probe.id, category: caseDef.category, arm: armName,
      library: caseDef.library, scale: Boolean(caseDef.scale), author: caseDef.author,
      question: probe.question, gold: probe.answer,
      ...scored, reply: result.reply ?? null,
      probeInput: summary.input, probeCached: summary.cached, probeOutput: summary.output, probeRequests: summary.requests,
    });
    if (!keepStores) rmSync(copy, { recursive: true, force: true });
  }
  const record = { case: caseDef.id, arm: armName, model: model.id, rep, finishedAt: new Date().toISOString(), rows, conversations };
  writeJson(join(directory, 'result.json'), record);
  return record;
}
