#!/usr/bin/env node
// PersistBench under five ways of giving a model its memories (README.md).
//
//   node --env-file=eval/.env.local eval/selection/cli.mjs prepare [--classifier ID] [--embedding ID] [--limit N]
//       Groups every sample's memories by domain (the classifier model) and embeds them (the
//       embedding model), once, into eval/runs/selection-cache/. Every run reads the same cache.
//   node --env-file=eval/.env.local eval/selection/cli.mjs run --model ID --judge ID --out DIR
//       [--conditions flat,partition,retrieval,files,protocol] [--types cross_domain,beneficial_memory_usage]
//       [--limit N] [--concurrency N] [--dry] [--cache DIR]
//       Answers every sample in every condition and judges the answers. Run it again with the
//       same --out to continue; it refuses if the prompts, the samples, the cache or the code changed.
//   node eval/selection/cli.mjs report DIR [DIR ...]
//       Writes report.md, summary.json and chart.svg into the first DIR.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkModel, createProvider, createScriptedProvider } from '../lib/provider.mjs';
import { pause, random, readJson, runLimited, seedOf, sha256, shuffle, writeFileAtomic, writeJson } from '../lib/util.mjs';
import {
  CONDITIONS, InfrastructureError, TYPES, classify, loadPrompts, loadSamples, runItem, sampleHashes, similarities,
} from './persistbench.mjs';
import { analyze, loadRecords, renderChart, renderReport } from './report.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EVAL = join(ROOT, 'eval');
const DEFAULT_CACHE = join(EVAL, 'runs', 'selection-cache');
let CACHE = DEFAULT_CACHE;
const say = (text) => process.stderr.write(`${text}\n`);
function fail(message) {
  say(message);
  process.exit(1);
}
const INFRA_ATTEMPTS = 4;
const INFRA_PAUSE_MS = 60_000;
const INFRA_STREAK_STOP = 5;

/** Published points (Zhao et al. 2026, PersistBench, seven-model averages), drawn hollow on the chart for reference. */
const PUBLISHED = [
  { condition: 'flat', leakage: 0.562, missed: 0.233 },
  { condition: 'partition', leakage: 0.562 * (1 - 0.088), missed: 0.207 },
  { condition: 'retrieval', leakage: 0.244, missed: 0.713 },
];

function models(values) {
  const file = resolve(values.models ?? join(EVAL, 'models.local.json'));
  if (!existsSync(file)) fail(`No model list at ${file}.`);
  return readJson(file).models.map(checkModel);
}
const find = (list, id, what) => list.find((m) => m.id === id) ?? fail(`No ${what} ${id} in the model list.`);

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
const codeHash = () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) files.push(path);
    }
  };
  for (const dir of ['eval/selection', 'eval/lib', 'server']) walk(join(ROOT, dir));
  return sha256(files.sort().map((f) => `${relative(ROOT, f)}\n${readFileSync(f, 'utf8')}`).join('\n\u0000\n'));
};

const readCache = (name) => (existsSync(join(CACHE, name)) ? readJson(join(CACHE, name)) : {});

// ---- prepare ----

async function prepare(values) {
  const list = models(values);
  const classifierModel = find(list, values.classifier ?? 'deepseek-v4-pro', 'classifier');
  const embeddingModel = find(list, values.embedding ?? 'text-embedding-3-small', 'embedding model');
  const prompts = loadPrompts();
  let samples = loadSamples(values.types ? values.types.split(',') : TYPES);
  if (values.limit) samples = samples.slice(0, Number(values.limit));
  mkdirSync(CACHE, { recursive: true, mode: 0o700 });
  const grouping = readCache('grouping.json');
  const similarity = readCache('similarity.json');
  const provider = createProvider(classifierModel);
  let done = 0;
  await runLimited(samples.map((sample) => async () => {
    if (!grouping[sample.id]) {
      const result = await classify({ provider, prompts, memories: sample.memories });
      grouping[sample.id] = { classifier: classifierModel.id, groups: result.groups, fallback: result.fallback, attempts: result.attempts };
      writeJson(join(CACHE, 'grouping.json'), grouping, 0o600);
    }
    if (!similarity[sample.id]) {
      similarity[sample.id] = { model: embeddingModel.id, similarities: await similarities(embeddingModel, sample) };
      writeJson(join(CACHE, 'similarity.json'), similarity, 0o600);
    }
    done += 1;
    if (done % 25 === 0 || done === samples.length) say(`prepared ${done}/${samples.length}`);
  }), Number(values.concurrency ?? 6));
  const fallbacks = samples.filter((s) => grouping[s.id].fallback.length).length;
  say(`grouping: ${samples.length} samples, ${fallbacks} with memories the classifier did not place (put under personal)`);
}

// ---- run ----

/** A stand-in for the models in a dry run: it reads the first index entry when there is an index, answers, and judges 1 (or 3). */
function dryProviders() {
  const answer = createScriptedProvider(({ messages, tools }) => {
    const steps = messages.filter((m) => m.role === 'assistant').length;
    if (tools.length && steps === 0) {
      const name = tools[0].function.name;
      const topic = /\n- ([a-z_]+)(?:\.md)? \(/.exec(messages[0].content)?.[1] ?? 'personal';
      const args = name === 'read_memory_file' ? { name: `${topic}.md` } : { entityId: 'current_user', topics: [topic] };
      return { tool_calls: [{ name: tools.find((t) => t.function.name !== 'entity_search')?.function.name ?? name, arguments: args }] };
    }
    return { content: 'Here is a short answer.' };
  }, { id: 'dry' });
  const judgeProvider = createScriptedProvider(({ messages }) => (messages[0].content.includes('"rating"')
    ? { content: '{"rating": 3, "reasoning": "dry run"}' } : { content: '{"score": 1, "reasoning": "dry run"}' }), { id: 'dry-judge' });
  return { answer, judgeProvider };
}

async function run(values) {
  if (!values.out) fail('--out DIR is required');
  const out = resolve(values.out);
  const conditions = (values.conditions ?? CONDITIONS.join(',')).split(',');
  if (!conditions.every((c) => CONDITIONS.includes(c))) fail(`--conditions takes ${CONDITIONS.join(', ')}`);
  const types = (values.types ?? TYPES.join(',')).split(',');
  if (!types.every((t) => TYPES.includes(t))) fail(`--types takes ${TYPES.join(', ')}`);
  const list = values.dry ? [] : models(values);
  const model = values.dry ? { id: 'dry', model: 'dry' } : find(list, values.model ?? fail('--model ID is required'), 'model');
  const judgeModel = values.dry ? { id: 'dry-judge', model: 'dry' } : find(list, values.judge ?? fail('--judge ID is required'), 'judge');
  const prompts = loadPrompts();
  let samples = loadSamples(types);
  if (values.limit) {
    // The first N of each type, so that a short run has both kinds.
    const n = Number(values.limit);
    samples = types.flatMap((t) => samples.filter((s) => s.type === t).slice(0, n));
  }
  const grouping = readCache('grouping.json');
  const similarity = readCache('similarity.json');
  const needGrouping = conditions.some((c) => ['partition', 'files', 'protocol'].includes(c));
  const missing = samples.filter((s) => (needGrouping && !grouping[s.id]) || (conditions.includes('retrieval') && !similarity[s.id]));
  if (missing.length) fail(`${missing.length} samples are not prepared; run prepare first.`);
  const manifest = {
    name: basename(out), startedAt: new Date().toISOString(), git: gitState(), node: process.version,
    model: { id: model.id, model: model.model, body: model.body ?? {}, passback: model.passback ?? [] },
    judge: { id: judgeModel.id, model: judgeModel.model, body: judgeModel.body ?? {} },
    conditions, types, samples: samples.length, limit: values.limit ? Number(values.limit) : null,
    hashes: {
      samples: sampleHashes(), prompts: prompts.hashes, code: codeHash(),
      grouping: sha256(JSON.stringify(Object.fromEntries(samples.map((s) => [s.id, grouping[s.id] ?? null])))),
      similarity: sha256(JSON.stringify(Object.fromEntries(samples.map((s) => [s.id, similarity[s.id] ?? null])))),
    },
  };
  const manifestFile = join(out, 'manifest.json');
  if (existsSync(manifestFile)) {
    const before = readJson(manifestFile);
    for (const field of ['samples', 'code', 'grouping', 'similarity']) {
      if (JSON.stringify(before.hashes[field]) !== JSON.stringify(manifest.hashes[field])) fail(`Cannot continue ${out}: the ${field} changed since it started.`);
    }
    if (JSON.stringify(before.hashes.prompts) !== JSON.stringify(manifest.hashes.prompts)) fail(`Cannot continue ${out}: the prompts changed.`);
    if (before.model.id !== model.id || before.judge.id !== judgeModel.id) fail(`Cannot continue ${out}: it ran ${before.model.id}, judged by ${before.judge.id}.`);
  } else {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeJson(manifestFile, manifest);
  }
  const { answer, judgeProvider: dryJudge } = values.dry ? dryProviders() : {};
  const provider = values.dry ? answer : createProvider(model);
  const judgeProvider = values.dry ? dryJudge : createProvider(judgeModel);
  const items = samples.flatMap((sample) => shuffle(random(seedOf(model.id, sample.id)), conditions).map((condition) => ({ sample, condition })));
  let done = 0;
  let streak = 0;
  let stopped = false;
  const started = Date.now();
  await runLimited(items.map(({ sample, condition }) => async () => {
    if (stopped) return;
    const file = join(out, 'items', model.id, condition, `${sample.id}.json`);
    mkdirSync(join(out, 'items', model.id, condition), { recursive: true, mode: 0o700 });
    const prepared = { grouping: grouping[sample.id], similarities: similarity[sample.id]?.similarities };
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runItem({ file, sample, condition, model, provider, judgeModel, judgeProvider, prompts, prepared, runTag: basename(out) });
        streak = 0;
        break;
      } catch (error) {
        if (!(error instanceof InfrastructureError)) throw error;
        if (attempt < INFRA_ATTEMPTS && !stopped) {
          say(`${sample.id} ${condition}: ${error.message.slice(0, 160)}; again in ${attempt} min (${attempt + 1}/${INFRA_ATTEMPTS})`);
          await pause(INFRA_PAUSE_MS * attempt);
          continue;
        }
        streak += 1;
        say(`${sample.id} ${condition}: left to the infrastructure: ${error.message.slice(0, 160)}`);
        if (streak >= INFRA_STREAK_STOP && !stopped) {
          stopped = true;
          say(`${streak} items in a row failed on the infrastructure; stopping. Run the same command again to continue.`);
        }
        break;
      }
    }
    done += 1;
    if (done % 25 === 0 || done === items.length) say(`${model.id}: ${done}/${items.length} items, ${Math.round((Date.now() - started) / 1000)} s`);
  }), Number(values.concurrency ?? model.concurrency ?? 4));
  report([out]);
  if (stopped) fail('Stopped: the infrastructure kept failing.');
}

// ---- report ----

function report(dirs) {
  const runDirs = dirs.map((d) => resolve(d));
  const records = loadRecords(runDirs);
  const analysis = analyze(records);
  const manifests = runDirs.filter((d) => existsSync(join(d, 'manifest.json'))).map((d) => readJson(join(d, 'manifest.json')));
  const target = runDirs[0];
  writeJson(join(target, 'summary.json'), { runs: manifests.map((m) => m.name), ...analysis });
  writeFileAtomic(join(target, 'report.md'), renderReport(analysis, manifests));
  writeFileAtomic(join(target, 'chart.svg'), renderChart(analysis, PUBLISHED));
  say(`Report: ${join(target, 'report.md')} (${records.length} records)`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: 'string' }, model: { type: 'string' }, judge: { type: 'string' }, classifier: { type: 'string' }, embedding: { type: 'string' },
    conditions: { type: 'string' }, types: { type: 'string' }, limit: { type: 'string' }, concurrency: { type: 'string' }, out: { type: 'string' }, dry: { type: 'boolean' },
    cache: { type: 'string' },
  },
});
if (values.cache) CACHE = resolve(values.cache);
const [command, ...rest] = positionals;
if (command === 'prepare') await prepare(values);
else if (command === 'run') await run(values);
else if (command === 'report') report(rest.length ? rest : fail('report DIR [DIR ...]'));
else fail('Commands: prepare, run, report. See the top of eval/selection/cli.mjs.');
