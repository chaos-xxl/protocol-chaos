#!/usr/bin/env node
// The experiment's command line.
//
//   node eval/cli.mjs validate [--split dev,formal]
//       Expands every template, generates the background library, and checks that each
//       case's three starting stores hold the same information. Costs nothing.
//   node --env-file=eval/.env.local eval/cli.mjs run --split dev [--models eval/models.local.json]
//       [--model ID ...] [--reps 2] [--arms P,T1,T2] [--cases PREFIX] [--scale] [--out DIR]
//       [--resume DIR] [--dry] [--concurrency N] [--allow-dirty] [--blind] [--reader ID]
//       Runs the cases. --dry plays the model with a stand-in (no network, no cost). --blind
//       is for a pilot: it writes only the blind report (no accuracy by arm), see lib/pilot.mjs.
//       --resume continues a run, repeating the case runs the infrastructure failed.
//       --reader answers every probe with that model of the list instead of the writer's, so
//       that what differs is how the store was written, not how well it is read.
//       --p-directory id lists P's directory by id instead of most recently updated first.
//   node eval/cli.mjs report RUN_DIR [--blind]
//       Writes results.jsonl, summary.json, report.md and the review packet; with --blind,
//       pilot-report.md, pilot.json and the review packet without its key.
//   node eval/cli.mjs audit RUN_DIR
//       Checks every store the sessions left, by rules (lib/audit.mjs): words kept, history
//       kept, attribution, words claimed but not said, matters added, latest number in the
//       current state. Writes audit.json and audit.md.
//   node eval/cli.mjs d7 [--out FILE]
//       The deterministic demonstration of two assistants writing at once.
//   node --env-file=eval/.env.local eval/cli.mjs models --gateway eval/gateway.local.json
//       The models a gateway lists, by provider.
//   node --env-file=eval/.env.local eval/cli.mjs screen --gateway eval/gateway.local.json --candidates a,b,c
//       Four conversations per candidate model: can it take part? Writes eval/runs/screen-*/.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { protocolArm } from './lib/arms/protocol.mjs';
import { ARMS, InfrastructureError, caseMatters, runCase, verifyCase } from './lib/case.mjs';
import { describeLibrary } from './lib/library.mjs';
import { SPLITS, TEMPLATES, material } from './lib/material.mjs';
import { loadPrompts, systemPrompt } from './lib/prompts.mjs';
import { checkModel, createProvider, listModels } from './lib/provider.mjs';
import { rehearsalProvider } from './lib/rehearsal.mjs';
import { auditRun, renderAudit } from './lib/audit.mjs';
import { pilotAnalysis, renderPilot } from './lib/pilot.mjs';
import { analyze, collect, renderReport, reviewPacket } from './lib/report.mjs';
import { modelFromGateway, renderScreen, screen } from './lib/screen.mjs';
import { scaleCases } from './lib/templates.mjs';
import { pause, random, readJson, runLimited, seedOf, sha256, shuffle, writeFileAtomic, writeJson } from './lib/util.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVAL = join(ROOT, 'eval');
// A case run the infrastructure failed is tried again, after a pause that grows; after this many
// tries it is recorded as the infrastructure's. After this many such case runs in a row the run
// stops, to be resumed once the endpoint is back.
const INFRA_ATTEMPTS = 4;
const INFRA_PAUSE_MS = 60_000;
const INFRA_STREAK_STOP = 3;

const say = (text) => process.stderr.write(`${text}\n`);
function fail(message) {
  say(message);
  process.exit(1);
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
  const pDirectory = values['p-directory'] ?? 'recent';
  if (!['recent', 'id'].includes(pDirectory)) fail('--p-directory is recent or id');
  const pArm = protocolArm({ order: pDirectory });
  const reps = Number(values.reps ?? 2);
  if (!Number.isInteger(reps) || reps < 1 || reps > 10) fail('--reps must be 1 to 10');

  const { cases: base, library } = material([split]);
  let cases = base;
  if (values.scale ?? split === 'formal') cases = [...cases, ...scaleCases(base)];
  if (values.cases) cases = cases.filter((c) => values.cases.split(',').some((prefix) => c.id.startsWith(prefix)));
  if (cases.length === 0) fail('No cases to run.');

  let models;
  let reader = null;
  if (values.dry) {
    models = [{ id: 'rehearsal', model: 'rehearsal', endpoint: 'http://127.0.0.1/', concurrency: Number(values.concurrency ?? 4) }];
  } else {
    const file = resolve(values.models ?? join(EVAL, 'models.local.json'));
    if (!existsSync(file)) fail(`No model list at ${file}. Copy eval/models.example.json to eval/models.local.json and fill it in.`);
    const listed = readJson(file).models.map(checkModel);
    models = values.model?.length ? listed.filter((m) => values.model.includes(m.id)) : listed;
    if (models.length === 0) fail('No model selected.');
    if (values.reader) reader = listed.find((m) => m.id === values.reader) ?? fail(`No model ${values.reader} in ${file}.`);
  }

  const out = resolve(values.resume ?? values.out ?? join(EVAL, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${split}`));
  const prompts = loadPrompts();
  const manifestFile = join(out, 'manifest.json');
  const manifest = {
    startedAt: new Date().toISOString(),
    split, reps, arms, pDirectory, dry: Boolean(values.dry), git, node: process.version,
    models: models.map(({ id, model, endpoint, body, passback, concurrency }) => ({ id, model, endpoint: endpoint ? new URL(endpoint).origin : null, body: body ?? {}, passback: passback ?? [], concurrency })),
    reader: reader ? { id: reader.id, model: reader.model, endpoint: new URL(reader.endpoint).origin, body: reader.body ?? {}, passback: reader.passback ?? [] } : null,
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

  const readerProvider = reader ? createProvider(reader) : undefined;
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
    let streak = 0;
    let stopped = false;
    const started = Date.now();
    await runLimited(jobs.map((job) => async () => {
      const resultFile = join(job.directory, 'result.json');
      if (existsSync(resultFile) && !readJson(resultFile).infrastructure) {
        done += 1;
        return;
      }
      if (stopped) return;
      // The endpoint or a local server failing is retried with the whole case run, after a pause; a case run that
      // keeps failing that way is recorded as such and left out of the analysis. Any other error is a harness bug:
      // it is recorded and counted as failed, so it cannot hide.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await runCase({ ...job, armImpl: job.arm === 'P' ? pArm : undefined, model, provider, readerProvider, reader: reader?.id, library, prompts, runTag: basename(out) });
          streak = 0;
          break;
        } catch (error) {
          const infrastructure = error instanceof InfrastructureError;
          if (infrastructure && attempt < INFRA_ATTEMPTS && !stopped) {
            say(`${model.id}: ${job.caseDef.id} ${job.arm} rep ${job.rep}: ${error.message.slice(0, 160)}; trying the case again (${attempt + 1}/${INFRA_ATTEMPTS})`);
            await pause(INFRA_PAUSE_MS * attempt);
            continue;
          }
          writeJson(join(job.directory, 'result.json'), {
            case: job.caseDef.id, arm: job.arm, model: model.id, rep: job.rep, error: error.message, infrastructure, conversations: [],
            rows: job.caseDef.probes.map((probe) => ({
              model: model.id, rep: job.rep, template: job.caseDef.template, case: job.caseDef.id, probe: probe.id, category: job.caseDef.category,
              arm: job.arm, library: job.caseDef.library, scale: Boolean(job.caseDef.scale), author: job.caseDef.author, question: probe.question,
              gold: probe.answer, outcome: 'failed', infrastructure, value: null, normalized: null,
              method: `${infrastructure ? 'infrastructure' : 'harness'}: ${error.message}`, reply: null,
            })),
          });
          if (infrastructure) {
            streak += 1;
            if (streak >= INFRA_STREAK_STOP && !stopped) {
              stopped = true;
              say(`${model.id}: ${streak} case runs in a row failed on the infrastructure; stopping. Resume with --resume ${out}`);
            }
          } else {
            say(`${model.id}: ${job.caseDef.id} ${job.arm} rep ${job.rep}: a harness error: ${error.message.slice(0, 300)}`);
          }
          break;
        }
      }
      done += 1;
      if (done % 10 === 0 || done === jobs.length) say(`${model.id}: ${done}/${jobs.length} case runs, ${Math.round((Date.now() - started) / 1000)} s`);
    }), concurrency);
    if (stopped) {
      (values.blind ? pilot : report)(out);
      fail(`Stopped: the infrastructure kept failing. Resume with: --resume ${out}`);
    }
  }
  (values.blind ? pilot : report)(out);
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

/** The blind report of a pilot: nothing that shows how the arms compare (lib/pilot.mjs). */
function pilot(runDir) {
  const dir = resolve(runDir);
  const records = collect(dir);
  if (records.length === 0) fail(`No results under ${dir}`);
  const manifest = existsSync(join(dir, 'manifest.json')) ? readJson(join(dir, 'manifest.json')) : {};
  const analysis = pilotAnalysis(records);
  writeJson(join(dir, 'pilot.json'), { manifest, ...analysis });
  writeFileAtomic(join(dir, 'pilot-report.md'), renderPilot(analysis, manifest));
  // The entries carry no arm; the key that maps them back is not written until the pilot is over.
  const packet = reviewPacket(records.filter((r) => !r.infrastructure));
  writeJson(join(dir, 'review-packet.json'), packet.entries);
  say(`Pilot report: ${join(dir, 'pilot-report.md')} (${records.length} case runs, ${packet.entries.length} answers to review)`);
}

/** The store audit of a run (lib/audit.mjs). */
function audit(runDir) {
  const dir = resolve(runDir);
  const rows = auditRun(dir);
  if (rows.length === 0) fail(`No stores under ${dir}`);
  const manifest = existsSync(join(dir, 'manifest.json')) ? readJson(join(dir, 'manifest.json')) : {};
  writeJson(join(dir, 'audit.json'), rows);
  writeFileAtomic(join(dir, 'audit.md'), renderAudit(rows, manifest));
  say(`Audit: ${join(dir, 'audit.md')} (${rows.length} stores)`);
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

// ---- gateways: listing and screening models ----

function gatewayOf(values) {
  const file = resolve(values.gateway ?? join(EVAL, 'gateway.local.json'));
  if (!existsSync(file)) fail(`No gateway description at ${file}.`);
  const gateway = readJson(file);
  if (!gateway.apiKeyEnv || !process.env[gateway.apiKeyEnv]) fail(`The environment variable ${gateway.apiKeyEnv ?? '(apiKeyEnv)'} is not set; run with --env-file.`);
  return gateway;
}

async function models(values) {
  const gateway = gatewayOf(values);
  const list = await listModels({ base: gateway.modelsBase, key: process.env[gateway.apiKeyEnv] });
  // A gateway that serves one model through several providers names the provider in owned_by;
  // the name to call is then <owned_by>/<id>.
  const nameOf = (m) => (gateway.nameByOwner && m.owned_by ? `${m.owned_by}/${m.id}` : m.id);
  const byProvider = new Map();
  for (const m of list) {
    if (m.model_type && m.model_type !== 'llm') continue;
    const name = nameOf(m);
    const provider = name.includes('/') ? name.slice(0, name.indexOf('/')) : '(none)';
    byProvider.set(provider, [...new Set([...(byProvider.get(provider) ?? []), name])]);
  }
  const lines = [...byProvider].sort().map(([provider, names]) => `${provider} (${names.length}):\n  ${names.sort().join('\n  ')}`);
  process.stdout.write(`${list.length} models listed; language models by provider:\n${lines.join('\n')}\n`);
  if (values.out) writeJson(resolve(values.out), list);
}

async function screenCommand(values) {
  const gateway = gatewayOf(values);
  const names = (values.candidates ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) fail('--candidates takes the gateway names of the models to screen, separated by commas.');
  const list = names.map((name) => checkModel(modelFromGateway(gateway, name)));
  const { cases, library } = material(SPLITS);
  const out = resolve(values.out ?? join(EVAL, 'runs', `screen-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  const records = await screen(list, { library, cases, out, concurrency: Number(values.concurrency ?? 4) });
  writeJson(join(out, 'screen.json'), records);
  writeFileAtomic(join(out, 'screen.md'), renderScreen(records));
  process.stdout.write(renderScreen(records));
  say(`Conversations: ${join(out, 'conversations')}`);
}

// ---- main ----

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    split: { type: 'string' }, models: { type: 'string' }, model: { type: 'string', multiple: true }, reps: { type: 'string' },
    arms: { type: 'string' }, cases: { type: 'string' }, case: { type: 'string' }, scale: { type: 'boolean' }, out: { type: 'string' },
    resume: { type: 'string' }, dry: { type: 'boolean' }, concurrency: { type: 'string' }, 'allow-dirty': { type: 'boolean' },
    gateway: { type: 'string' }, candidates: { type: 'string' }, blind: { type: 'boolean' }, reader: { type: 'string' }, 'p-directory': { type: 'string' },
  },
});
const [command, ...rest] = positionals;
if (command === 'validate') validate(values);
else if (command === 'run') await run(values);
else if (command === 'report') (values.blind ? pilot : report)(rest[0] ?? fail('report needs the run directory'));
else if (command === 'audit') audit(rest[0] ?? fail('audit needs the run directory'));
else if (command === 'preview') await preview(values);
else if (command === 'd7') await (await import('./lib/d7.mjs')).main(values);
else if (command === 'models') await models(values);
else if (command === 'screen') await screenCommand(values);
else fail('Commands: validate, run, report, audit, preview, d7, models, screen. See the comment at the top of eval/cli.mjs.');
