#!/usr/bin/env node
// The matter benchmark (README.md).
//
//   node --env-file=eval/.env.local eval/matters/cli.mjs prepare [--pilot DIR] [--generator ID] [--validator ID]
//       [--judge ID] [--classifier ID] [--embedding ID] [--concurrency N] [--cache DIR]
//       Writes each case's stores, groups its matters by domain, writes its requests and checks
//       them, and embeds the matters and the kept requests, into the cache. Each step is kept;
//       run it again to continue.
//   node --env-file=eval/.env.local eval/matters/cli.mjs run --model ID --judge ID --out DIR
//       [--conditions flat,partition,retrieval,files,protocol] [--kinds needs,adjacent,unrelated]
//       [--limit N] [--concurrency N] [--cache DIR]
//       Answers every kept request in every condition and judges the answers. Run it again with
//       the same --out to continue; it refuses if the prompts, the requests, the cache or the code changed.
//   node --env-file=eval/.env.local eval/matters/cli.mjs rejudge DIR [DIR ...] --judge ID [--kinds needs]
//       Judges the answers of finished runs again with the current judge prompts, keeping the
//       first verdicts (README.md, "Changes").
//   node eval/matters/cli.mjs report DIR [DIR ...]
//       Writes report.md, summary.json and chart.svg into the first DIR.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkModel, createProvider } from '../lib/provider.mjs';
import { renderEntry } from '../lib/render.mjs';
import { pause, random, readJson, runLimited, seedOf, sha256, shuffle, writeJson } from '../lib/util.mjs';
import { InfrastructureError, classify, cosine, embed } from '../selection/persistbench.mjs';
import {
  CONDITIONS, KINDS, checkLeak, checkNeeds, judge, loadCases, loadPrompts, runItem, withAncestors, writeRefill, writeRequests, writeStores,
} from './bench.mjs';
import { writeReport } from './report.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EVAL = join(ROOT, 'eval');
const HERE = fileURLToPath(new URL('./', import.meta.url));
let CACHE = join(EVAL, 'runs', 'matters-cache');
const DEFAULT_PILOT = join(EVAL, 'runs', 'pilot-4-pro');
const say = (text) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${text}\n`);
function fail(message) {
  say(message);
  process.exit(1);
}
const INFRA_ATTEMPTS = 4;
const INFRA_PAUSE_MS = 60_000;
const INFRA_STREAK_STOP = 5;

function models(values) {
  const file = resolve(values.models ?? join(EVAL, 'models.local.json'));
  if (!existsSync(file)) fail(`No model list at ${file}.`);
  return readJson(file).models.map(checkModel);
}
const find = (list, id, what) => list.find((m) => m.id === id) ?? fail(`No ${what} ${id} in the model list.`);
const cachePath = (...parts) => join(CACHE, ...parts);
const readCache = (name, fallback = {}) => (existsSync(cachePath(name)) ? readJson(cachePath(name)) : fallback);
const writeCache = (name, value) => writeJson(cachePath(name), value, 0o600);

function gitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'eval', 'server'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((l) => l.trim() && !l.includes('eval/runs/') && !l.includes('.local') && !l.includes('eval/external/')).length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}
/** The code a run depends on: this benchmark, the harness library, the PersistBench module it borrows from, the server. */
const codeHash = () => {
  const files = [join(EVAL, 'selection', 'persistbench.mjs')];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) files.push(path);
    }
  };
  for (const dir of ['eval/matters', 'eval/lib', 'server']) walk(join(ROOT, dir));
  return sha256(files.sort().map((f) => `${relative(ROOT, f)}\n${readFileSync(f, 'utf8')}`).join('\n\u0000\n'));
};

// ---- prepare ----

const stamp = (what, model) => ({ model: model.id, at: new Date().toISOString(), ...what });

async function prepareCase(kase, ctx) {
  const { prompts, generator, answerer, validator, judgeProvider, classifier, pool, ids } = ctx;
  // 1. The stores, rendered from the canonical matters.
  const storeDir = cachePath('stores', kase.id);
  const mapsFile = join(storeDir, 'maps.json');
  if (!existsSync(mapsFile) || readJson(mapsFile).storeHash !== kase.storeHash) {
    const { eventTitles, fileTitles } = writeStores(storeDir, kase);
    writeJson(mapsFile, { storeHash: kase.storeHash, matters: kase.matters.length, eventTitles, fileTitles }, 0o600);
  }
  // 2. The matters by domain.
  const groups = readCache('groups.json');
  if (!groups[kase.id] || groups[kase.id].storeHash !== kase.storeHash) {
    const items = kase.matters.map((m) => (m.facts.goal ? `${m.title}：${m.facts.goal}` : m.title));
    const result = await classify({ provider: classifier.provider, prompts, memories: items });
    if (result.fallback.length === items.length) {
      // No answer could be read at all: not a grouping. Left for the next prepare.
      say(`${kase.id}: the classifier gave no usable answer in ${result.attempts} tries; not grouped`);
    } else {
      const byDomain = Object.fromEntries(Object.entries(result.groups).map(([domain, list]) => [domain, list.map((i) => kase.matters[i].title)]));
      const fresh = readCache('groups.json');
      fresh[kase.id] = stamp({ storeHash: kase.storeHash, groups: byDomain, fallback: result.fallback.map((i) => kase.matters[i].title), attempts: result.attempts }, classifier.model);
      writeCache('groups.json', fresh);
      say(`${kase.id}: grouped (${Object.keys(byDomain).length} domains, ${result.fallback.length} not placed)`);
    }
  }
  // 3. The requests, written and checked.
  const file = cachePath('requests', `${kase.id}.json`);
  const state = existsSync(file) ? readJson(file) : { case: kase.id, storeHash: kase.storeHash };
  const save = () => writeJson(file, state, 0o600);
  if (!state.written) {
    const written = await writeRequests({ provider: generator.provider, prompts, kase });
    state.written = stamp({ ok: written.ok, tries: written.tries, message: written.message, parsed: written.parsed ?? null }, generator.model);
    save();
    if (!written.ok) {
      say(`${kase.id}: no usable requests after ${written.tries.length} tries: ${written.tries.at(-1)?.error}`);
      return;
    }
  }
  if (!state.written.ok) return;
  const parsed = state.written.parsed;
  state.needs ??= parsed.needs.map((n, i) => ({ id: ids(kase, 'needs', i), kind: 'needs', ...n, context: withAncestors(n.matters, kase.byKey) }));
  state.adjacent ??= parsed.adjacent.map((a, i) => ({ id: ids(kase, 'adjacent', i), kind: 'adjacent', ...a }));
  save();
  for (const request of state.needs) {
    if (request.check) continue;
    request.check = stamp(await checkNeeds({ provider: answerer.provider, judgeProvider, prompts, kase, request }), answerer.model);
    save();
  }
  for (const request of state.adjacent) {
    if (request.check) continue;
    request.check = stamp(await checkLeak({ provider: validator.provider, prompts, kase, request }), validator.model);
    save();
  }
  // One refill round when the validator left fewer than two: three more candidates, checked in
  // order until the case has two (README.md).
  const passed = (r) => r.check?.ok && r.check.helps === false;
  const keptAdjacent = () => [...state.adjacent, ...(state.refill?.requests ?? [])].filter(passed).length;
  if (keptAdjacent() < 2 && !state.refill) {
    const rejected = state.adjacent.filter((r) => !passed(r)).map((r) => ({ request: r.request, reason: r.check.ok ? r.check.reasoning : `（理由读不出：${r.check.error}）` }));
    const written = await writeRefill({ provider: generator.provider, prompts, kase, rejected, count: 3 });
    const requests = written.ok ? written.parsed.map((a, i) => ({ id: ids(kase, 'adjacent', state.adjacent.length + i), kind: 'adjacent', refill: true, ...a })) : [];
    state.refill = stamp({ ok: written.ok, tries: written.tries, message: written.message, requests }, generator.model);
    save();
  }
  for (const request of state.refill?.requests ?? []) {
    if (keptAdjacent() >= 2) break;
    if (request.check) continue;
    request.check = stamp(await checkLeak({ provider: validator.provider, prompts, kase, request }), validator.model);
    save();
  }
  state.unrelated ??= { order: shuffle(random(seedOf('unrelated', kase.id)), pool.map((_, i) => i)), tried: [] };
  save();
  while (!state.unrelated.chosen && state.unrelated.tried.length < 5) {
    const index = state.unrelated.order[state.unrelated.tried.length];
    const request = { id: ids(kase, 'unrelated', 0), kind: 'unrelated', request: pool[index], pool: index };
    const check = stamp(await checkLeak({ provider: validator.provider, prompts, kase, request }), validator.model);
    state.unrelated.tried.push({ ...request, check });
    if (check.ok && check.helps === false) state.unrelated.chosen = request;
    save();
  }
}

/** The kept requests of every case, and the dropped ones with their reasons. */
function collectRequests(cases) {
  const kept = [];
  const dropped = [];
  for (const kase of cases) {
    const file = cachePath('requests', `${kase.id}.json`);
    if (!existsSync(file)) {
      dropped.push({ case: kase.id, reason: 'not prepared' });
      continue;
    }
    const state = readJson(file);
    if (!state.written?.ok) {
      dropped.push({ case: kase.id, reason: 'the generator gave no usable requests' });
      continue;
    }
    const base = (r) => ({ id: r.id, case: kase.id, kind: r.kind, request: r.request });
    for (const r of state.needs ?? []) {
      if (r.check?.kept) kept.push({ ...base(r), matters: r.matters, context: r.context, facts: r.facts, stale: r.stale, why: r.why });
      else dropped.push({ ...base(r), reason: r.check ? r.check.reason : 'not checked' });
    }
    for (const r of [...(state.adjacent ?? []), ...(state.refill?.requests ?? [])]) {
      if (r.check?.ok && r.check.helps === false) kept.push({ ...base(r), matter: r.matter, why: r.why, ...(r.refill ? { refill: true } : {}) });
      else if (!r.check && r.refill) dropped.push({ ...base(r), reason: 'not needed: the case already had two' });
      else dropped.push({ ...base(r), reason: !r.check ? 'not checked' : !r.check.ok ? `the validator could not be read: ${r.check.error}` : `the validator finds it helped by: ${r.check.matters.join('、')}` });
    }
    if (state.unrelated?.chosen) kept.push({ ...base(state.unrelated.chosen), pool: state.unrelated.chosen.pool });
    for (const t of state.unrelated?.tried ?? []) {
      if (t.pool !== state.unrelated.chosen?.pool) dropped.push({ ...base(t), reason: t.check.ok ? `the validator finds it helped by: ${t.check.matters.join('、')}` : `the validator could not be read: ${t.check.error}` });
    }
  }
  return { kept, dropped };
}

async function embedCase(kase, requests, embeddingModel) {
  const entries = kase.matters.map((m) => renderEntry(m, kase.byKey));
  const vectors = [];
  for (let i = 0; i < entries.length; i += 64) vectors.push(...await embed(embeddingModel, entries.slice(i, i + 64)));
  const queries = await embed(embeddingModel, requests.map((r) => r.request));
  return Object.fromEntries(requests.map((r, i) => [r.id, Object.fromEntries(kase.matters.map((m, j) => [m.title, cosine(queries[i], vectors[j])]))]));
}

async function prepare(values) {
  const list = models(values);
  const pick = (id, what) => {
    const model = find(list, id, what);
    return { model, provider: createProvider(model) };
  };
  const generator = pick(values.generator ?? 'deepseek-v4-pro', 'generator');
  const answerer = generator;
  const validator = pick(values.validator ?? 'kimi-k2.6', 'validator');
  const judgeModel = pick(values.judge ?? 'kimi-k2.6', 'judge');
  // Thinking off: with thinking on, its reasoning over 150 matters used every output token (README.md).
  const classifier = pick(values.classifier ?? 'deepseek-v4-pro-nothink', 'classifier');
  const embeddingModel = find(list, values.embedding ?? 'text-embedding-3-small', 'embedding model');
  const prompts = loadPrompts();
  const cases = loadCases(resolve(values.pilot ?? DEFAULT_PILOT));
  const pool = readJson(join(HERE, 'unrelated.json')).requests;
  if (pool.length !== 40) fail(`unrelated.json holds ${pool.length} requests, not 40`);
  mkdirSync(cachePath('requests'), { recursive: true, mode: 0o700 });
  writeCache('prompts.json', prompts.hashes);
  const ids = (kase, kind, i) => `${kase.id}.${kind}${i + 1}`;
  const ctx = { prompts, generator, answerer, validator, judgeProvider: judgeModel.provider, classifier, pool, ids };
  let done = 0;
  await runLimited(cases.map((kase) => async () => {
    try {
      await prepareCase(kase, ctx);
    } catch (error) {
      if (!(error instanceof InfrastructureError) && !error.retryable) throw error;
      say(`${kase.id}: left for the next prepare: ${error.message.slice(0, 200)}`);
    }
    done += 1;
    say(`prepared ${done}/${cases.length} (${kase.id})`);
  }), Number(values.concurrency ?? 8));
  const { kept, dropped } = collectRequests(cases);
  const similarity = readCache('similarity.json');
  for (const kase of cases) {
    const mine = kept.filter((r) => r.case === kase.id && !similarity[r.id]);
    if (!mine.length) continue;
    Object.assign(similarity, await embedCase(kase, mine, embeddingModel));
    writeCache('similarity.json', similarity);
  }
  writeCache('requests.json', { kept, dropped });
  const count = (kind) => kept.filter((r) => r.kind === kind).length;
  say(`requests kept: ${count('needs')} needs, ${count('adjacent')} adjacent, ${count('unrelated')} unrelated; dropped ${dropped.length}`);
}

// ---- run ----

function loadPrepared(cases) {
  const { kept } = readCache('requests.json', { kept: [] });
  const groups = readCache('groups.json');
  const similarity = readCache('similarity.json');
  const prepared = {};
  for (const kase of cases) {
    const maps = existsSync(cachePath('stores', kase.id, 'maps.json')) ? readJson(cachePath('stores', kase.id, 'maps.json')) : null;
    if (!maps || maps.storeHash !== kase.storeHash) fail(`${kase.id}: its stores are not prepared; run prepare first.`);
    if (!groups[kase.id] || groups[kase.id].storeHash !== kase.storeHash) fail(`${kase.id}: its matters are not grouped; run prepare first.`);
    prepared[kase.id] = {
      groups: groups[kase.id].groups, protocolDir: cachePath('stores', kase.id, 'protocol'), notesDir: cachePath('stores', kase.id, 'notes'),
      eventTitles: maps.eventTitles, fileTitles: maps.fileTitles,
    };
  }
  for (const r of kept) if (!similarity[r.id]) fail(`${r.id} is not embedded; run prepare first.`);
  return { kept, groups, similarity, prepared };
}

async function run(values) {
  if (!values.out) fail('--out DIR is required');
  const out = resolve(values.out);
  const conditions = (values.conditions ?? CONDITIONS.join(',')).split(',');
  if (!conditions.every((c) => CONDITIONS.includes(c))) fail(`--conditions takes ${CONDITIONS.join(', ')}`);
  const kinds = (values.kinds ?? KINDS.join(',')).split(',');
  if (!kinds.every((k) => KINDS.includes(k))) fail(`--kinds takes ${KINDS.join(', ')}`);
  const list = models(values);
  const model = find(list, values.model ?? fail('--model ID is required'), 'model');
  const judgeModel = find(list, values.judge ?? fail('--judge ID is required'), 'judge');
  const prompts = loadPrompts();
  const cases = loadCases(resolve(values.pilot ?? DEFAULT_PILOT));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const { kept, groups, similarity, prepared } = loadPrepared(cases);
  let requests = kept.filter((r) => kinds.includes(r.kind));
  if (values.limit) {
    const n = Number(values.limit);
    requests = kinds.flatMap((k) => requests.filter((r) => r.kind === k).slice(0, n));
  }
  if (requests.length === 0) fail('No requests; run prepare first.');
  const manifest = {
    name: basename(out), startedAt: new Date().toISOString(), git: gitState(), node: process.version,
    model: { id: model.id, model: model.model, body: model.body ?? {}, passback: model.passback ?? [] },
    judge: { id: judgeModel.id, model: judgeModel.model, body: judgeModel.body ?? {} },
    conditions, kinds, requests: requests.length, limit: values.limit ? Number(values.limit) : null,
    hashes: {
      stores: sha256(JSON.stringify(cases.map((c) => [c.id, c.storeHash]))), prompts: prompts.hashes, code: codeHash(),
      requests: sha256(JSON.stringify(requests)),
      groups: sha256(JSON.stringify(cases.map((c) => [c.id, groups[c.id].groups]))),
      similarity: sha256(JSON.stringify(requests.map((r) => [r.id, similarity[r.id]]))),
    },
  };
  const manifestFile = join(out, 'manifest.json');
  if (existsSync(manifestFile)) {
    const before = readJson(manifestFile);
    for (const field of ['stores', 'code', 'requests', 'groups', 'similarity']) {
      if (JSON.stringify(before.hashes[field]) !== JSON.stringify(manifest.hashes[field])) fail(`Cannot continue ${out}: the ${field} changed since it started.`);
    }
    if (JSON.stringify(before.hashes.prompts) !== JSON.stringify(manifest.hashes.prompts)) fail(`Cannot continue ${out}: the prompts changed.`);
    if (before.model.id !== model.id || before.judge.id !== judgeModel.id) fail(`Cannot continue ${out}: it ran ${before.model.id}, judged by ${before.judge.id}.`);
  } else {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeJson(manifestFile, manifest);
  }
  const provider = createProvider(model);
  const judgeProvider = createProvider(judgeModel);
  const items = requests.flatMap((request) => shuffle(random(seedOf(model.id, request.id)), conditions).map((condition) => ({ request, condition })));
  let done = 0;
  let streak = 0;
  let stopped = false;
  const started = Date.now();
  await runLimited(items.map(({ request, condition }) => async () => {
    if (stopped) return;
    const dir = join(out, 'items', model.id, condition);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${request.id}.json`);
    const kase = byId.get(request.case);
    const here = { ...prepared[kase.id], similarities: similarity[request.id] };
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runItem({ file, kase, request, condition, model, provider, judgeModel, judgeProvider, prompts, prepared: here, runTag: basename(out) });
        streak = 0;
        break;
      } catch (error) {
        if (!(error instanceof InfrastructureError)) throw error;
        if (attempt < INFRA_ATTEMPTS && !stopped) {
          say(`${request.id} ${condition}: ${error.message.slice(0, 160)}; again in ${attempt} min (${attempt + 1}/${INFRA_ATTEMPTS})`);
          await pause(INFRA_PAUSE_MS * attempt);
          continue;
        }
        streak += 1;
        say(`${request.id} ${condition}: left to the infrastructure: ${error.message.slice(0, 160)}`);
        if (streak >= INFRA_STREAK_STOP && !stopped) {
          stopped = true;
          say(`${streak} items in a row failed on the infrastructure; stopping. Run the same command again to continue.`);
        }
        break;
      }
    }
    done += 1;
    if (done % 20 === 0 || done === items.length) say(`${model.id}: ${done}/${items.length} items, ${Math.round((Date.now() - started) / 1000)} s`);
  }), Number(values.concurrency ?? model.concurrency ?? 4));
  writeReport([out], { cache: CACHE });
  if (stopped) fail('Stopped: the infrastructure kept failing.');
}

// ---- rejudge ----

const recordFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.json')) out.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
};

/**
 * Judges the answers of finished runs again with the current judge prompts (README.md,
 * "Changes"). The first verdict of each answer is kept as judgmentAsRun; an answer already
 * judged with these prompts is left as it is, so that the command continues where it stopped.
 */
async function rejudge(values, dirs) {
  const list = models(values);
  const judgeModel = find(list, values.judge ?? fail('--judge ID is required'), 'judge');
  const prompts = loadPrompts();
  const kinds = (values.kinds ?? 'needs').split(',');
  if (!kinds.every((k) => KINDS.includes(k))) fail(`--kinds takes ${KINDS.join(', ')}`);
  const byId = new Map(loadCases(resolve(values.pilot ?? DEFAULT_PILOT)).map((c) => [c.id, c]));
  const requests = new Map(readCache('requests.json', { kept: [] }).kept.map((r) => [r.id, r]));
  const provider = createProvider(judgeModel);
  const mark = sha256(JSON.stringify([judgeModel.id, prompts.hashes.judgeNeeds, prompts.hashes.judgeLeakage, codeHash()]));
  for (const dir of dirs) {
    const files = recordFiles(join(dir, 'items')).filter((f) => kinds.includes(readJson(f).kind));
    let done = 0;
    let left = 0;
    await runLimited(files.map((file) => async () => {
      const record = readJson(file);
      const kase = byId.get(record.case);
      const request = requests.get(record.sample);
      if (!kase || !request) fail(`${file}: its case or request is not in the cache`);
      for (const epoch of record.epochs) {
        if (!epoch.ok || epoch.rejudged === mark) continue;
        try {
          const verdict = await judge({ provider, prompts, kase, request, reply: epoch.reply });
          if (!('judgmentAsRun' in epoch)) epoch.judgmentAsRun = epoch.judgment ?? null;
          epoch.judgment = verdict;
          epoch.rejudged = mark;
          writeJson(file, record, 0o600);
        } catch (error) {
          if (!(error instanceof InfrastructureError)) throw error;
          left += 1;
          say(`${record.sample} ${record.condition}: left for the next rejudge: ${error.message.slice(0, 120)}`);
        }
      }
      done += 1;
      if (done % 20 === 0 || done === files.length) say(`${basename(dir)}: ${done}/${files.length} records`);
    }), Number(values.concurrency ?? 16));
    const manifestFile = join(dir, 'manifest.json');
    const manifest = readJson(manifestFile);
    (manifest.rejudged ??= []).push({ at: new Date().toISOString(), judge: judgeModel.id, kinds, prompts: prompts.hashes, code: codeHash(), git: gitState(), mark, left });
    writeJson(manifestFile, manifest);
    say(`${basename(dir)}: judged again${left ? `, ${left} answers left for the next rejudge` : ''}`);
  }
  writeReport(dirs, { cache: CACHE });
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: 'string' }, model: { type: 'string' }, judge: { type: 'string' }, generator: { type: 'string' }, validator: { type: 'string' },
    classifier: { type: 'string' }, embedding: { type: 'string' }, pilot: { type: 'string' }, conditions: { type: 'string' }, kinds: { type: 'string' },
    limit: { type: 'string' }, concurrency: { type: 'string' }, out: { type: 'string' }, cache: { type: 'string' },
  },
});
if (values.cache) CACHE = resolve(values.cache);
const [command, ...rest] = positionals;
if (command === 'prepare') await prepare(values);
else if (command === 'run') await run(values);
else if (command === 'rejudge') await rejudge(values, rest.length ? rest.map((d) => resolve(d)) : fail('rejudge DIR [DIR ...] --judge ID [--kinds needs]'));
else if (command === 'report') writeReport(rest.length ? rest.map((d) => resolve(d)) : fail('report DIR [DIR ...]'), { cache: CACHE });
else fail('Commands: prepare, run, rejudge, report. See the top of eval/matters/cli.mjs.');
