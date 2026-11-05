#!/usr/bin/env node
// The experiment's command line.
//
//   node eval/cli.mjs validate [--split dev,formal]
//       Expands every template, generates the background library, and checks that each
//       case's three starting stores hold the same information. Costs nothing.
//   node --env-file=eval/.env.local eval/cli.mjs run --split dev [--models eval/models.local.json]
//       [--model ID ...] [--reps 2] [--arms P,T1,T2] [--cases PREFIX] [--scale] [--out DIR]
//       [--resume DIR] [--dry] [--concurrency N] [--allow-dirty]
//       Runs the cases. --dry plays the model with a stand-in (no network, no cost).
//   node eval/cli.mjs report RUN_DIR
//       Writes results.jsonl, summary.json, report.md and the review packet.
//   node eval/cli.mjs d7 [--out FILE]
//       The deterministic demonstration of two assistants writing at once.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ARMS, caseMatters, runCase, verifyCase } from './lib/case.mjs';
import { generateLibrary, describeLibrary } from './lib/library.mjs';
import { loadPrompts, systemPrompt } from './lib/prompts.mjs';
import { checkModel, createProvider } from './lib/provider.mjs';
import { rehearsalProvider } from './lib/rehearsal.mjs';
import { analyze, collect, renderReport, reviewPacket } from './lib/report.mjs';
import { expandAll, loadTemplates, scaleCases } from './lib/templates.mjs';
import { random, readJson, runLimited, seedOf, sha256, shuffle, writeFileAtomic, writeJson } from './lib/util.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVAL = join(ROOT, 'eval');
const TEMPLATES = join(EVAL, 'templates');
const SPLITS = ['dev', 'formal'];
const LIBRARY_SEED = 20261104;

const say = (text) => process.stderr.write(`${text}\n`);
function fail(message) {
  say(message);
  process.exit(1);
}

/** Every template in every split, expanded, and the library with all their keywords reserved. */
function material(splits) {
  const all = loadTemplates(TEMPLATES, SPLITS);
  const every = expandAll(all);
  const cases = every.filter((c) => splits.includes(c.split));
  // Keywords as the variants fill them in, from every split, so that dev and formal share one library.
  const reserved = [...new Set(every.flatMap((c) => c.keywords))].sort();
  const library = generateLibrary({ seed: LIBRARY_SEED, reserved });
  return { all, cases, library, reserved };
}

function hashFiles(files) {
  return sha256(files.sort().map((f) => `${relative(ROOT, f)}\n${readFileSync(f, 'utf8')}`).join('\n\u0000\n'));
}
const listFiles = (dir, test) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, test) : test(name) ? [path] : [];
  });
};

function gitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'eval', 'server', 'package.json'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((l) => l.trim() && !l.includes('eval/runs/') && !l.includes('.local')).length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

// ---- validate ----

function validate(values) {
  const splits = (values.split ?? SPLITS.join(',')).split(',');
  const { cases, library, reserved } = material(splits);
  const libraryText = JSON.stringify(library);
  const leaked = reserved.filter((word) => libraryText.includes(word));
  if (leaked.length) fail(`The library contains reserved keywords: ${leaked.join(', ')}`);
  const work = mkdtempSync(join(tmpdir(), 'protocol-chaos-validate-'));
  let bad = 0;
  try {
    for (const caseDef of cases) {
      const result = verifyCase(library, caseDef, join(work, caseDef.id.replace(/[^A-Za-z0-9_.-]/g, '_')));
      if (!result.ok) {
        bad += 1;
        say(`${caseDef.id}: the arms differ:\n  ${Object.entries(result.differences).filter(([, d]) => d.length).map(([arm, d]) => `${arm}: ${d.slice(0, 5).join('; ')}`).join('\n  ')}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const count = (key) => cases.reduce((m, c) => ({ ...m, [c[key]]: (m[c[key]] ?? 0) + 1 }), {});
  const templates = new Set(cases.map((c) => c.template));
  const byCategory = {};
  for (const c of cases) {
    byCategory[c.category] ??= { templates: new Set(), cases: 0, probes: 0 };
    byCategory[c.category].templates.add(c.template);
    byCategory[c.category].cases += 1;
    byCategory[c.category].probes += c.probes.length;
  }
  const lines = [
    `${templates.size} templates, ${cases.length} cases, ${cases.reduce((n, c) => n + c.probes.length, 0)} probes; splits ${JSON.stringify(count('split'))}; authors ${JSON.stringify(count('author'))}`,
    ...Object.entries(byCategory).sort().map(([k, v]) => `  ${k}: ${v.templates.size} templates, ${v.cases} cases, ${v.probes} probes`),
    `library: ${JSON.stringify(describeLibrary(library))}`,
    `reserved keywords: ${reserved.length}`,
    bad ? `${bad} cases whose arms differ` : 'every case: the three arms start from the same information',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (bad) process.exit(1);
}

// ---- run ----

async function run(values) {
  const split = values.split ?? 'dev';
  if (!SPLITS.includes(split)) fail(`--split must be one of ${SPLITS.join(', ')}`);
  const git = gitState();
  if (split === 'formal' && git.dirty !== false && !values['allow-dirty']) {
    fail('The formal split runs only from a committed tree (the pre-registration). Commit, or pass --allow-dirty for a rehearsal.');
  }
  const arms = (values.arms ?? 'P,T1,T2').split(',');
  if (!arms.every((a) => ARMS[a])) fail('--arms takes P, T1 and T2');
  const reps = Number(values.reps ?? 2);
  if (!Number.isInteger(reps) || reps < 1 || reps > 10) fail('--reps must be 1 to 10');

  const { cases: base, library } = material([split]);
  let cases = base;
  if (values.scale ?? split === 'formal') cases = [...cases, ...scaleCases(base)];
  if (values.cases) cases = cases.filter((c) => values.cases.split(',').some((prefix) => c.id.startsWith(prefix)));
  if (cases.length === 0) fail('No cases to run.');

  let models;
  if (values.dry) {
    models = [{ id: 'rehearsal', model: 'rehearsal', endpoint: 'http://127.0.0.1/', concurrency: Number(values.concurrency ?? 4) }];
  } else {
    const file = resolve(values.models ?? join(EVAL, 'models.local.json'));
    if (!existsSync(file)) fail(`No model list at ${file}. Copy eval/models.example.json to eval/models.local.json and fill it in.`);
    models = readJson(file).models.map(checkModel);
    if (values.model?.length) models = models.filter((m) => values.model.includes(m.id));
    if (models.length === 0) fail('No model selected.');
  }

  const out = resolve(values.resume ?? values.out ?? join(EVAL, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${split}`));
  const prompts = loadPrompts();
  const manifestFile = join(out, 'manifest.json');
  const manifest = {
    startedAt: new Date().toISOString(),
    split, reps, arms, dry: Boolean(values.dry), git, node: process.version,
    models: models.map(({ id, model, endpoint, body, passback, concurrency }) => ({ id, model, endpoint: endpoint ? new URL(endpoint).origin : null, body: body ?? {}, passback: passback ?? [], concurrency })),
    prompts: prompts.hashes,
    hashes: {
      templates: hashFiles(listFiles(TEMPLATES, (n) => n.endsWith('.json'))),
      code: hashFiles([...listFiles(join(EVAL, 'lib'), (n) => n.endsWith('.mjs')), ...listFiles(join(ROOT, 'server'), (n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')), join(EVAL, 'cli.mjs')]),
      library: sha256(JSON.stringify(library)),
    },
    cases: cases.length,
  };
  if (values.resume) {
    if (!existsSync(manifestFile)) fail(`${out} holds no run to resume`);
    const before = readJson(manifestFile);
    for (const key of ['templates', 'code', 'library']) if (before.hashes[key] !== manifest.hashes[key]) fail(`Cannot resume: the ${key} changed since the run started.`);
    if (JSON.stringify(before.prompts) !== JSON.stringify(manifest.prompts)) fail('Cannot resume: the prompts changed since the run started.');
  } else {
    if (existsSync(out)) fail(`${out} exists; use --resume to continue it`);
    writeJson(manifestFile, manifest);
    writeJson(join(out, 'cases.json'), cases);
    writeJson(join(out, 'library.json'), library);
  }

  for (const model of models) {
    const provider = values.dry ? rehearsalProvider() : createProvider(model);
    const concurrency = Number(values.concurrency ?? model.concurrency ?? 4);
    const jobs = [];
    for (const caseDef of cases) {
      for (let rep = 1; rep <= reps; rep += 1) {
        for (const arm of shuffle(random(seedOf(model.id, caseDef.id, String(rep))), arms)) {
          const directory = join(out, 'work', model.id, `rep${rep}`, caseDef.id, arm);
          jobs.push({ caseDef, rep, arm, directory });
        }
      }
    }
    let done = 0;
    const started = Date.now();
    await runLimited(jobs.map((job) => async () => {
      if (existsSync(join(job.directory, 'result.json'))) {
        done += 1;
        return;
      }
      try {
        await runCase({ ...job, model, provider, library, prompts });
      } catch (error) {
        // A case that could not run at all (a server that did not start, a store that could not be written) still counts:
        // each of its probes is a failure.
        writeJson(join(job.directory, 'result.json'), {
          case: job.caseDef.id, arm: job.arm, model: model.id, rep: job.rep, error: error.message, conversations: [],
          rows: job.caseDef.probes.map((probe) => ({
            model: model.id, rep: job.rep, template: job.caseDef.template, case: job.caseDef.id, probe: probe.id, category: job.caseDef.category,
            arm: job.arm, library: job.caseDef.library, scale: Boolean(job.caseDef.scale), author: job.caseDef.author, question: probe.question,
            gold: probe.answer, outcome: 'failed', value: null, normalized: null, method: `case: ${error.message}`, reply: null,
          })),
        });
      }
      done += 1;
      if (done % 10 === 0 || done === jobs.length) say(`${model.id}: ${done}/${jobs.length} case runs, ${Math.round((Date.now() - started) / 1000)} s`);
    }), concurrency);
  }
  report(out);
}

// ---- report ----

function report(runDir) {
  const dir = resolve(runDir);
  const records = collect(dir);
  if (records.length === 0) fail(`No results under ${dir}`);
  const manifest = existsSync(join(dir, 'manifest.json')) ? readJson(join(dir, 'manifest.json')) : {};
  const analysis = analyze(records);
  writeFileAtomic(join(dir, 'results.jsonl'), `${records.flatMap((r) => r.rows).map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeJson(join(dir, 'summary.json'), { manifest, ...analysis });
  writeFileAtomic(join(dir, 'report.md'), renderReport(analysis, manifest));
  const packet = reviewPacket(records);
  writeJson(join(dir, 'review-packet.json'), packet.entries);
  writeJson(join(dir, 'review-key.json'), packet.key);
  say(`Report: ${join(dir, 'report.md')} (${analysis.rows} probe results, ${packet.entries.length} answers to review)`);
}

// ---- preview: the system prompt of one conversation, for reviewing prompts ----

async function preview(values) {
  const { cases, library } = material(SPLITS);
  const caseDef = cases.find((c) => c.id === values.case) ?? cases[0];
  if (!caseDef) fail('No case.');
  const arm = values.arms ?? 'P';
  const work = mkdtempSync(join(tmpdir(), 'protocol-chaos-preview-'));
  try {
    const meta = ARMS[arm].prepare(work, caseMatters(library, caseDef));
    const session = caseDef.sessions[0];
    const handle = await ARMS[arm].open(work, { ...session, meta });
    const text = systemPrompt(loadPrompts(), arm, { ...session, view: handle.view });
    await handle.close();
    process.stdout.write(`${text}\n\n--- user ---\n${session.user}\n\n--- tools ---\n${JSON.stringify(handle.tools, null, 2)}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- main ----

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    split: { type: 'string' }, models: { type: 'string' }, model: { type: 'string', multiple: true }, reps: { type: 'string' },
    arms: { type: 'string' }, cases: { type: 'string' }, case: { type: 'string' }, scale: { type: 'boolean' }, out: { type: 'string' },
    resume: { type: 'string' }, dry: { type: 'boolean' }, concurrency: { type: 'string' }, 'allow-dirty': { type: 'boolean' },
  },
});
const [command, ...rest] = positionals;
if (command === 'validate') validate(values);
else if (command === 'run') await run(values);
else if (command === 'report') report(rest[0] ?? fail('report needs the run directory'));
else if (command === 'preview') await preview(values);
else if (command === 'd7') await (await import('./lib/d7.mjs')).main(values);
else fail('Commands: validate, run, report, preview, d7. See the comment at the top of eval/cli.mjs.');
