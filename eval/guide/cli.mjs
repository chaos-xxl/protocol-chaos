#!/usr/bin/env node
// PersistBench with a usage guide (README.md): the runner of eval/selection/ with the guide in
// the system prompt, and a report that pairs each condition with and without it.
//
//   node --env-file=eval/.env.local eval/guide/cli.mjs run --model ID --judge ID --out DIR
//       [--conditions flat,files,protocol] [--types ...] [--limit N] [--concurrency N]
//   node eval/guide/cli.mjs report --guide DIR[,DIR] --without DIR[,DIR]
//       Writes report.md and summary.json into the first --guide DIR.
//
// It only reads from eval/selection, eval/lib and server: the PersistBench runs are checked
// against that code, and this module does not change it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkModel, createProvider } from '../lib/provider.mjs';
import { pause, random, readJson, runLimited, seedOf, sha256, shuffle, writeFileAtomic, writeJson } from '../lib/util.mjs';
import { InfrastructureError, TYPES, loadSamples, runItem, sampleHashes } from '../selection/persistbench.mjs';
import { loadRecords } from '../selection/report.mjs';
import { CONDITIONS, analyzeGuide, guidedPrompts, renderGuideReport } from './guide.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EVAL = join(ROOT, 'eval');
const CACHE = join(EVAL, 'runs', 'selection-cache');
const say = (text) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${text}\n`);
function fail(message) {
  say(message);
  process.exit(1);
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
  for (const dir of ['eval/guide', 'eval/selection', 'eval/lib', 'server']) walk(join(ROOT, dir));
  return sha256(files.sort().map((f) => `${relative(ROOT, f)}\n${readFileSync(f, 'utf8')}`).join('\n\u0000\n'));
};
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

async function run(values) {
  if (!values.out) fail('--out DIR is required');
  const out = resolve(values.out);
  const conditions = (values.conditions ?? CONDITIONS.join(',')).split(',');
  if (!conditions.every((c) => CONDITIONS.includes(c))) fail(`--conditions takes ${CONDITIONS.join(', ')}`);
  const types = (values.types ?? TYPES.join(',')).split(',');
  const list = readJson(resolve(values.models ?? join(EVAL, 'models.local.json'))).models.map(checkModel);
  const find = (id, what) => list.find((m) => m.id === id) ?? fail(`No ${what} ${id} in the model list.`);
  const model = find(values.model ?? fail('--model ID is required'), 'model');
  const judgeModel = find(values.judge ?? fail('--judge ID is required'), 'judge');
  const prompts = guidedPrompts();
  let samples = loadSamples(types);
  if (values.limit) samples = types.flatMap((t) => samples.filter((s) => s.type === t).slice(0, Number(values.limit)));
  const grouping = readJson(join(CACHE, 'grouping.json'));
  const missing = samples.filter((s) => !grouping[s.id]);
  if (missing.length) fail(`${missing.length} samples are not grouped; run eval/selection prepare first.`);
  const manifest = {
    name: basename(out), startedAt: new Date().toISOString(), git: gitState(), node: process.version,
    model: { id: model.id, model: model.model, body: model.body ?? {}, passback: model.passback ?? [] },
    judge: { id: judgeModel.id, model: judgeModel.model, body: judgeModel.body ?? {} },
    conditions, types, samples: samples.length, guide: true,
    hashes: {
      samples: sampleHashes(), prompts: prompts.hashes, code: codeHash(),
      grouping: sha256(JSON.stringify(Object.fromEntries(samples.map((s) => [s.id, grouping[s.id]])))),
    },
  };
  const manifestFile = join(out, 'manifest.json');
  if (existsSync(manifestFile)) {
    const before = readJson(manifestFile);
    for (const field of ['samples', 'code', 'grouping', 'prompts']) {
      if (JSON.stringify(before.hashes[field]) !== JSON.stringify(manifest.hashes[field])) fail(`Cannot continue ${out}: the ${field} changed since it started.`);
    }
    if (before.model.id !== model.id || before.judge.id !== judgeModel.id) fail(`Cannot continue ${out}: it ran ${before.model.id}, judged by ${before.judge.id}.`);
  } else {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeJson(manifestFile, manifest);
  }
  const provider = createProvider(model);
  const judgeProvider = createProvider(judgeModel);
  const items = samples.flatMap((sample) => shuffle(random(seedOf(model.id, 'guide', sample.id)), conditions).map((condition) => ({ sample, condition })));
  let done = 0;
  let streak = 0;
  let stopped = false;
  const started = Date.now();
  await runLimited(items.map(({ sample, condition }) => async () => {
    if (stopped) return;
    const dir = join(out, 'items', model.id, condition);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${sample.id}.json`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runItem({ file, sample, condition, model, provider, judgeModel, judgeProvider, prompts, prepared: { grouping: grouping[sample.id] }, runTag: basename(out) });
        streak = 0;
        break;
      } catch (error) {
        if (!(error instanceof InfrastructureError)) throw error;
        if (attempt < 4 && !stopped) {
          say(`${sample.id} ${condition}: ${error.message.slice(0, 160)}; again in ${attempt} min`);
          await pause(60_000 * attempt);
          continue;
        }
        streak += 1;
        say(`${sample.id} ${condition}: left to the infrastructure: ${error.message.slice(0, 160)}`);
        if (streak >= 5 && !stopped) {
          stopped = true;
          say('5 items in a row failed on the infrastructure; stopping. Run the same command again to continue.');
        }
        break;
      }
    }
    done += 1;
    if (done % 25 === 0 || done === items.length) say(`${model.id}: ${done}/${items.length} items, ${Math.round((Date.now() - started) / 1000)} s`);
  }), Number(values.concurrency ?? 16));
  if (stopped) fail('Stopped: the infrastructure kept failing.');
}

function report(values) {
  const guideDirs = (values.guide ?? fail('--guide DIR is required')).split(',').map((d) => resolve(d));
  const withoutDirs = (values.without ?? fail('--without DIR is required')).split(',').map((d) => resolve(d));
  const analysis = analyzeGuide(loadRecords(guideDirs), loadRecords(withoutDirs));
  const manifests = [...guideDirs, ...withoutDirs].filter((d) => existsSync(join(d, 'manifest.json'))).map((d) => readJson(join(d, 'manifest.json')));
  writeJson(join(guideDirs[0], 'summary.json'), analysis);
  writeFileAtomic(join(guideDirs[0], 'report.md'), renderGuideReport(analysis, manifests));
  say(`Report: ${join(guideDirs[0], 'report.md')}`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: 'string' }, model: { type: 'string' }, judge: { type: 'string' }, conditions: { type: 'string' }, types: { type: 'string' },
    limit: { type: 'string' }, concurrency: { type: 'string' }, out: { type: 'string' }, guide: { type: 'string' }, without: { type: 'string' },
  },
});
const [command] = positionals;
if (command === 'run') await run(values);
else if (command === 'report') report(values);
else fail('Commands: run, report. See the top of eval/guide/cli.mjs.');
