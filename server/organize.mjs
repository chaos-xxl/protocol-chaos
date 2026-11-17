// Organizing in the background, as the Hermes plugin does after each answer: when an assistant
// records the user's words with event_note, the server queues them, and a detached process folds
// them into that matter's fields (title, state, progress, goal, constraint, plan, refs) with one
// model call. The model is that of the agent chosen as the organizer, run headless:
// `claude -p` (Claude Code), `dsh --profile headless` (DeepSeek Harness) or `codex exec` (Codex).
// <data>/organizer.json, written by `init`, says which; without it nothing is queued. DeepSeek
// Harness runs with an overlay (dshOverlay): the keys saved in the app, no tools, no session
// history, one small model with thinking off.
//
//   protocol-chaos organize --pending [--data <directory>]   fold what is queued (the server starts it)
//   protocol-chaos organize --sweep [--data <directory>]     fold the words nobody folded since the last sweep
//   protocol-chaos organize --status [--data <directory>]    the organizer, and its last runs
//
// The sweep is for words recorded while organizing was off, or whose fold failed; when nothing
// was recorded since the last sweep it ends without calling a model. The log keeps ids, times,
// changed fields and token counts, never words.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from './store.mjs';

export const ORGANIZER_FILE = 'organizer.json';
export const ORGANIZER_ACTOR = 'organizer';
// Who writes an import of other assistants' memories (memories.mjs). It sets the fields of the
// matters it starts itself, so the sweep does not fold its words again.
export const IMPORT_ACTOR = 'importer';
const FACT_KEYS = ['goal', 'constraint', 'plan'];
const STATES = ['emerging', 'active', 'waiting', 'dormant', 'done', 'cancelled'];
const OPEN_STATES = ['emerging', 'active', 'waiting', 'dormant'];
const NOT_A_REF = new Set(['me', 'i', 'myself', 'user', 'the user', '我', '我自己', '自己', '用户', '本人']);
const EARLIER_WORDS = 6;
const FACT_LIMIT = 4000;
const MAX_NEW_REFS = 5;
const PARTS_SHOWN = 8;
// Words said in a row are folded together once the assistant has finished its turn.
const SETTLE_MS = 15_000;
const LOCK_STALE_MS = 15 * 60_000;
const MODEL_TIMEOUT_MS = 180_000;
const DONE_KEPT = 2000;
const MAX_TRIES = 3;

/** The rules for one fold, from the Hermes plugin's structure update (integrations/hermes). */
export const FOLD_INSTRUCTIONS = [
  "You keep one of the user's long-lived matters up to date in their personal repository. You are given the matter as it stands, its earlier words, and the new words just said about it. Decide what the new words establish beyond what the matter already says, and answer with only those changes, leaving every other field null; if they establish nothing new, answer change: false. A question, a hypothetical or a request establishes nothing about the matter: answer change: false.",
  'goal: what the matter is meant to achieve, including what would count as done. constraint: conditions it must meet: limits, deadlines, budgets, wishes and preferences, even a wish about a place or a time. plan: the arrangement as currently decided: when, where, how, which option. A wish moves from constraint into plan once it is decided; never put the same thing in both: when you add a decision to plan, rewrite constraint without the wish it settles, and when nothing of a fact still holds, answer that fact as the string "(remove)". A value you give replaces the stored one, so write its complete new content: everything that still holds plus the change, as natural language in the language of the user\'s words, clear on its own, never an object or a list.',
  'progress: where the matter stands now, in one short sentence, only when the words say how far it got. state, only when the words make it clear: active (being pursued), waiting (on something or someone), dormant (set aside), done (achieved), cancelled (given up). involves: people, places or things the new words themselves name that the matter does not list yet, each a short description in the user\'s terms such as \'my wife\' or \'Lisbon\'; never the user themself. title: only when the matter has none: what it is, and when or which where that tells it apart.',
  'A long-lived matter holds only what is true of it as a whole. When this matter is a long-lived one and the new words are about one episode of it (one breakdown, one trip, one visit), leave out of it whatever holds only for that episode: the episode\'s own progress, a passing condition such as being away from home for now, a temporary setting; when the new words are only about such an episode, answer change: false. When this matter is itself the episode (it is part of a larger matter, and the words are about it), its own progress and passing conditions belong here.',
  "Write relative times as concrete dates, counted from the day the new words were said. Never write 'the user'; write the facts themselves. Words marked as a note by an assistant are that assistant's own sentence: either a record of what it did or found, which you fold as fact, naming the basis where it helps, or an inference, which the note marks as one and you keep marked as one; never write either over the user's own words. Older details are things the user said before: when you write the aspect they belong to, fold in what still holds.",
  'Answer with one JSON object and nothing else: {"change": true or false, "title": string or null, "state": string or null, "progress": string or null, "goal": string or null, "constraint": string or null, "plan": string or null, "involves": array of strings or null}. Do not use any tool.',
].join('\n\n');

// ------------------------------------------------------------------------------------ paths

function paths(directory) {
  const home = join(directory, 'organizer');
  return {
    config: join(directory, ORGANIZER_FILE),
    home,
    queue: join(home, 'queue'),
    lock: join(home, 'run.lock'),
    state: join(home, 'state.json'),
    log: join(home, 'log.jsonl'),
    overlay: join(home, 'dsh-overlay.yml'),
  };
}

/** The organizer chosen by init, or undefined when organizing is off. */
export function readOrganizer(directory) {
  try {
    const config = JSON.parse(readFileSync(paths(directory).config, 'utf8'));
    return config && typeof config.agent === 'string' && config.enabled !== false ? config : undefined;
  } catch {
    return undefined;
  }
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function log(directory, entry) {
  try {
    const { home, log: file } = paths(directory);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // a log that cannot be written must not stop organizing
  }
}

// ------------------------------------------------------------------------- queue, from the server

/**
 * Called by the server after an event_note: queues the words and starts the organizer in the
 * background, detached, so that the tool call returns at once. Never throws. Words the organizer
 * itself wrote are not queued again.
 */
export function queueFold({ directory, eventId, accountId, client, entry }) {
  try {
    // Words written by the organizer, or during one of its runs, are not organized again.
    if (process.env.PROTOCOL_CHAOS_ORGANIZING === '1') return false;
    const config = readOrganizer(directory);
    if (!config || !eventId || !accountId || client === (config.actor ?? ORGANIZER_ACTOR)) return false;
    if (Array.isArray(config.selfOrganizing) && config.selfOrganizing.includes(client)) return false;
    const { queue } = paths(directory);
    mkdirSync(queue, { recursive: true, mode: 0o700 });
    writeFileSync(join(queue, `${Date.now()}-${accountId}.json`), JSON.stringify({ eventId, accountId }), { mode: 0o600 });
    const child = spawn(process.execPath, [entry, 'organize', '--pending', '--data', directory], {
      detached: true, stdio: 'ignore', cwd: directory, env: process.env,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------ locks

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** One organizer at a time, per repository. A lock of a dead process, or an old one, is taken over. */
export function takeLock(file, staleMs = LOCK_STALE_MS) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, `${process.pid} ${Date.now()}`);
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const [pid, at] = String(readFileSync(file, 'utf8')).split(' ').map(Number);
      if (pidAlive(pid) && Date.now() - at < staleMs) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

export const releaseLock = (file) => rmSync(file, { force: true });

/** Whether a lock file names a process that is still running. */
export function lockHeld(file) {
  try {
    const [pid] = String(readFileSync(file, 'utf8')).split(' ').map(Number);
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// --------------------------------------------------------------------------------- the fold

const clip = (text, limit) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};

function noteOf(account) {
  if (account.source === 'user') return '';
  const name = clip(account.actor?.id ?? '', 40);
  if (account.source === 'authorized_external') return ` (relayed${name ? ` by ${name}` : ''} from another application)`;
  return name ? ` (a note by ${name})` : " (an assistant's note)";
}

/** What the model is shown: the matter now, where it sits, its earlier words and the new ones. */
export function foldInput(result, account, entries = []) {
  const event = result.event ?? {};
  const names = new Map((result.entities ?? []).map((entity) => [entity.id, entity.name]));
  const facts = event.facts ?? {};
  const clipped = new Set(FACT_KEYS.filter((key) => String(facts[key] ?? '').length > FACT_LIMIT));
  const lines = [
    `The new words were said on ${String(account.createdAt ?? '').slice(0, 10)} (UTC).`, '', 'The matter now:',
    `title: ${event.title || '(none)'}`, `state: ${event.state}`,
    event.progress?.text ? `progress: ${event.progress.text} (${String(event.progress.timestamp ?? '').slice(0, 10)})` : 'progress: (none)',
  ];
  for (const key of FACT_KEYS) lines.push(clipped.has(key) ? `${key}: (too long to show here; leave it null)` : `${key}: ${facts[key] || '(none)'}`);
  const involves = (event.refs ?? []).map((ref) => ref.criteria || names.get(ref.ref) || '').filter(Boolean);
  lines.push(`involves: ${involves.join('; ') || '(none)'}`);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const larger = (event.parents ?? []).map((parent) => byId.get(parent)?.title).filter(Boolean);
  if (larger.length) lines.push(`part of: ${larger.map((title) => clip(title, 80)).join('; ')} (this matter is one part of it: what the new words say about this part belongs here)`);
  const parts = entries.filter((entry) => (entry.parents ?? []).includes(event.id) && OPEN_STATES.includes(entry.state));
  if (parts.length) lines.push(`parts: ${parts.slice(0, PARTS_SHOWN).map((entry) => clip(entry.title || '(untitled)', 60)).join('; ')} (what holds only for one of them belongs on that part, not here)`);
  const legacy = event.metadata?.['dev.protocol-chaos/legacy-0.1'];
  if (legacy) lines.push(`older details: ${clip(JSON.stringify(legacy), 1200)}`);
  const accounts = result.accounts ?? [];
  const at = accounts.findIndex((item) => item.id === account.id);
  const earlier = accounts.slice(0, at < 0 ? accounts.length : at).slice(-EARLIER_WORDS);
  if (earlier.length) {
    lines.push('', 'Earlier words, oldest first:');
    for (const item of earlier) lines.push(`- ${String(item.createdAt ?? '').slice(0, 10)}${noteOf(item)}: ${clip(item.text, 300)}`);
  }
  lines.push('', `The new words${noteOf(account)}:`, String(account.text ?? ''));
  return { text: lines.join('\n'), clipped };
}

/** A valid `set` holding only what the answer changes, each field whole (§5.3). */
export function foldPatch(event, answer, account, clipped, known = []) {
  if (!answer || typeof answer !== 'object' || answer.change !== true) return {};
  const patch = {};
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  if (!event.title && text(answer.title)) patch.title = clip(answer.title, 80);
  const state = text(answer.state);
  if (state && STATES.includes(state) && state !== event.state) patch.state = state;
  const progress = text(answer.progress);
  if (progress && clip(progress, 300) !== event.progress?.text) patch.progress = { text: clip(progress, 300), timestamp: account.createdAt };
  const facts = {};
  for (const key of FACT_KEYS) {
    const value = text(answer[key]);
    if (clipped.has(key) || !value || value === event.facts?.[key]) continue;
    if (value === '(remove)') {
      if (event.facts?.[key]) facts[key] = null;
    } else {
      facts[key] = value;
    }
  }
  if (Object.keys(facts).length) patch.facts = facts;
  if (Array.isArray(answer.involves)) {
    const refs = (event.refs ?? []).map((ref) => ({ ...ref }));
    const seen = new Set([...refs.map((ref) => String(ref.criteria ?? '').trim().toLowerCase()), ...known.map((name) => String(name).trim().toLowerCase())]);
    const added = [];
    for (const item of answer.involves) {
      if (typeof item !== 'string' || !item.trim() || added.length >= MAX_NEW_REFS) continue;
      const criteria = clip(item, 80);
      const key = criteria.toLowerCase();
      if (seen.has(key) || NOT_A_REF.has(key)) continue;
      seen.add(key);
      added.push({ criteria });
    }
    if (added.length) patch.refs = [...refs, ...added];
  }
  return patch;
}

/** The part of a patch whose fields nobody else changed between `base` and `current`. */
function unchangedSince(patch, base, current) {
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out = {};
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'facts') {
      const kept = Object.fromEntries(Object.entries(value).filter(([key]) => same(base.facts?.[key], current.facts?.[key])));
      if (Object.keys(kept).length) out.facts = kept;
    } else if (same(base[field], current[field])) {
      out[field] = value;
    }
  }
  return out;
}

/** The first JSON object in a model's answer, or undefined. */
export function jsonObject(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Whether a field of the Event changed on these words after they were recorded: then they were
 * folded. The note that recorded them may itself have set a title or a parent, in the same commit.
 */
function alreadyFolded(repo, eventId, account) {
  const { revisions } = repo.getRevisions({ eventId });
  return revisions.some((revision) => revision.type === 'field.changed' && revision.sourceAccountIds.includes(account.id)
    && revision.occurredAt > account.createdAt);
}

/** Folds one Account into its Event; returns what happened, for the log. */
export async function foldOne(directory, config, eventId, accountId, ask = askModel) {
  const store = new Store(directory);
  const read = () => store.read((repo) => {
    const result = repo.getProtocol({ eventId, accounts: 'all' });
    const account = result.accounts.find((item) => item.id === accountId);
    return { result, entries: repo.contextPack({}).events, folded: Boolean(account) && alreadyFolded(repo, eventId, account) };
  });
  let { result, entries, folded } = read();
  const account = (result.accounts ?? []).find((item) => item.id === accountId);
  if (!account) return { outcome: 'missing' };
  if (folded) return { outcome: 'already' };
  const { text, clipped } = foldInput(result, account, entries);
  const reply = await ask(directory, config, FOLD_INSTRUCTIONS, text);
  if (reply.error) return { outcome: 'failed', error: reply.error, ms: reply.ms };
  const answer = jsonObject(reply.text);
  if (!answer) return { outcome: 'failed', error: 'the answer held no JSON object', ms: reply.ms, usage: reply.usage, cost: reply.cost };
  const known = (result.entities ?? []).map((entity) => entity.name).filter(Boolean);
  const base = result.event;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let patch = foldPatch(result.event, answer, account, clipped, known);
    if (attempt === 2) patch = unchangedSince(patch, base, result.event);
    if (!Object.keys(patch).length) return { outcome: 'unchanged', ms: reply.ms, usage: reply.usage, cost: reply.cost };
    try {
      const receipt = await store.write((repo) => repo.recordExpression({
        eventId,
        actor: { kind: 'agent', id: config.actor ?? ORGANIZER_ACTOR },
        text: account.text,
        accountSource: account.source,
        accountId,
        expectedVersion: result.event.version,
        set: patch,
      }));
      return { outcome: 'changed', changed: receipt.changed, ms: reply.ms, usage: reply.usage, cost: reply.cost };
    } catch (error) {
      if (error.code !== 'VERSION_CONFLICT' || attempt === 2) return { outcome: 'failed', error: `${error.code ?? 'ERROR'}: ${error.message}`, ms: reply.ms };
      ({ result, entries, folded } = read());
      if (folded) return { outcome: 'already', ms: reply.ms };
    }
  }
  return { outcome: 'failed', error: 'unreachable' };
}

// ------------------------------------------------------------------------------- the models

// DeepSeek Harness plugins the organizer's run leaves out: every tool (it answers in JSON and
// nothing else), the session title (one more model call), the upload of the session log to
// DeepSeek, workspace instructions, and the session history on disk (nothing of a run is kept).
const DSH_LEFT_OUT = ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill', 'skill-filesystem',
  'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-todo', 'tool-goal', 'tool-web',
  'web-search-deepseek', 'plan-mode', 'agent-instructions', 'session-title-llm', 'session-log-deepseek',
  'session-persistence-jsonl', 'session-checkpoint-policy'];

/** Whether DeepSeek Harness has this repository's MCP server (init's entry), which the organizer's run turns off. */
function dshHasOurEntry() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return [join(home, 'cordis.patch.yml'), join(home, 'profiles', 'headless', 'cordis.patch.yml')]
    .some((file) => existsSync(file) && /id:\s*['"]?protocol-chaos-mcp['"]?/.test(readFileSync(file, 'utf8')));
}

const yamlQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * The overlay on DeepSeek Harness's headless profile for one organizer run. The headless profile
 * ignores the keys saved in the app; these rows restore them, as its README describes.
 */
export function dshOverlay(config, hasOurEntry = dshHasOurEntry()) {
  const lines = ['# Written by protocol-chaos for its organizer: how DeepSeek Harness runs for one answer.'];
  for (const id of ['credentials', 'authorization', 'deepseek-account']) lines.push(`- id: ${id}`, '  disabled: false');
  for (const id of [...DSH_LEFT_OUT, ...(hasOurEntry ? ['protocol-chaos-mcp'] : [])]) lines.push(`- id: ${id}`, '  disabled: true');
  lines.push('- id: agent-default-model', '  config:', `    provider: ${yamlQuote(config.provider ?? 'deepseek-official')}`,
    `    model: ${yamlQuote(config.model ?? 'deepseek-flash')}`, `    reasoningEffort: ${yamlQuote(config.effort ?? 'off')}`);
  return `${lines.join('\n')}\n`;
}

/** The answer and the tokens of a DeepSeek Harness run, from its --json event stream. */
export function readDshEvents(stdout) {
  let text;
  let reason;
  let failure;
  let tools = 0;
  const usage = { input: 0, output: 0, cached: 0 };
  for (const line of String(stdout).split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'final') {
      text = event.text;
      reason = event.reason?.kind;
    } else if (event.type === 'error') {
      failure = event.message ?? event.code ?? 'error';
    } else if (event.type === 'tool_call') {
      tools += 1;
    } else if (event.type === 'status' && event.usage) {
      usage.input += event.usage.inputTokens ?? 0;
      usage.output += event.usage.outputTokens ?? 0;
      usage.cached += event.usage.cacheReadTokens ?? 0;
    }
  }
  if (failure) throw new Error(`dsh: ${clip(failure, 200)}`);
  // It has no tools; should one appear anyway, what came after it is not trusted.
  if (tools) throw new Error(`dsh: the run called ${tools} tool${tools === 1 ? '' : 's'}, so its answer is not used`);
  if (reason !== 'completed') throw new Error(`dsh: the run ended ${reason ?? 'without a final answer'}`);
  return { text, usage };
}

/**
 * How each agent is run headless for one answer: no tools, no MCP servers of its own (so that
 * the organizer cannot record words and start itself again), and a budget where it has one.
 */
function invocation(directory, config, instructions, input) {
  const command = config.command;
  if (config.agent === 'claude-code') {
    return {
      command,
      args: ['-p', '--model', config.model ?? 'haiku', '--system-prompt', instructions, '--tools', '', '--strict-mcp-config',
        '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--output-format', 'json',
        '--max-budget-usd', String(config.budgetUsd ?? 0.2), '--settings', '{"disableAllHooks":true}'],
      input,
      read: (stdout) => {
        const body = JSON.parse(stdout);
        if (body.is_error) throw new Error(`claude: ${clip(body.result ?? body.subtype ?? 'error', 200)}`);
        return { text: body.result, cost: body.total_cost_usd, usage: body.usage && { input: body.usage.input_tokens, cached: body.usage.cache_read_input_tokens, output: body.usage.output_tokens } };
      },
    };
  }
  if (config.agent === 'dsh') {
    const { overlay } = paths(directory);
    writeFileSync(overlay, dshOverlay(config), { mode: 0o600 });
    return {
      command,
      // read-only and never: anything that would need someone's approval is refused.
      args: ['--profile', config.profile ?? 'headless', '--patch', overlay, '--permission-mode', 'read-only', '--approval-policy', 'never', '--json', '-'],
      input: `${instructions}\n\n----\n\n${input}`,
      read: readDshEvents,
    };
  }
  if (config.agent === 'codex') {
    // One file per run: an import and a fold may run at the same time.
    const last = join(paths(directory).home, `codex-answer-${process.pid}-${Date.now()}.txt`);
    rmSync(last, { force: true });
    return {
      command,
      args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', last,
        '-c', 'mcp_servers.protocol_chaos.enabled=false',
        ...(config.model ? ['--model', config.model] : []), '-'],
      input: `${instructions}\n\n----\n\n${input}`,
      read: () => {
        try {
          return { text: readFileSync(last, 'utf8') };
        } finally {
          rmSync(last, { force: true });
        }
      },
    };
  }
  throw new Error(`unknown organizer agent "${config.agent}"`);
}

/** Runs the organizer's agent once; resolves with its text, or with an error. Never rejects. */
export function askModel(directory, config, instructions, input) {
  const started = Date.now();
  return new Promise((done) => {
    let call;
    try {
      mkdirSync(paths(directory).home, { recursive: true, mode: 0o700 });
      call = invocation(directory, config, instructions, input);
    } catch (error) {
      done({ error: error.message, ms: 0 });
      return;
    }
    const child = spawn(call.command, call.args, { cwd: paths(directory).home, env: { ...process.env, PROTOCOL_CHAOS_ORGANIZING: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), MODEL_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ error: `${call.command} could not run: ${error.message}`, ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code !== 0) {
        const detail = clip(`${stderr} ${stdout}`.replace(/(sk-|pc_|Bearer )[A-Za-z0-9._-]+/g, '$1…'), 300);
        done({ error: `${config.agent} exited ${signal ?? code}${detail ? `: ${detail}` : ''}`, ms });
        return;
      }
      try {
        done({ ...call.read(stdout), ms });
      } catch (error) {
        done({ error: error.message, ms });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(call.input);
  });
}

// ---------------------------------------------------------------------------- the commands

function readState(directory) {
  return readJsonFile(paths(directory).state, { done: {} });
}

function writeState(directory, state) {
  const { home, state: file } = paths(directory);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const entries = Object.entries(state.done ?? {});
  const done = Object.fromEntries(entries.slice(Math.max(0, entries.length - DONE_KEPT)));
  writeFileSync(file, `${JSON.stringify({ ...state, done }, null, 2)}\n`, { mode: 0o600 });
}

async function foldAndLog(directory, config, state, eventId, accountId, why, ask) {
  let report;
  try {
    report = await foldOne(directory, config, eventId, accountId, ask);
  } catch (error) {
    report = { outcome: 'failed', error: `${error.code ?? error.name}: ${error.message}` };
  }
  if (report.outcome !== 'failed') {
    state.done[accountId] = report.outcome;
    if (state.failures) delete state.failures[accountId];
  } else {
    // Words whose fold keeps failing are given up after three tries, so that a daily sweep does
    // not pay for them every day.
    state.failures = state.failures ?? {};
    state.failures[accountId] = (state.failures[accountId] ?? 0) + 1;
    if (state.failures[accountId] >= MAX_TRIES) {
      state.done[accountId] = 'gave up';
      delete state.failures[accountId];
    }
  }
  log(directory, { run: why, agent: config.agent, eventId, accountId, ...report });
  return report;
}

/** Folds the queued words, oldest first, once the assistant that recorded them has had time to finish. */
export async function runPending(directory, { ask = askModel } = {}) {
  const config = readOrganizer(directory);
  const settleMs = Number.isFinite(config?.settleMs) ? config.settleMs : SETTLE_MS;
  const { queue, lock } = paths(directory);
  if (!config || !existsSync(queue)) return 0;
  mkdirSync(paths(directory).home, { recursive: true, mode: 0o700 });
  for (;;) {
    if (!takeLock(lock)) return 0; // another organizer is running; it reads the queue again before it stops
    try {
      for (;;) {
        const files = readdirSync(queue).filter((name) => name.endsWith('.json')).sort();
        if (!files.length) break;
        const newest = Math.max(...files.map((name) => statSync(join(queue, name)).mtimeMs));
        const wait = newest + settleMs - Date.now();
        if (wait > 0) {
          await sleep(Math.min(wait, settleMs));
          continue;
        }
        const state = readState(directory);
        for (const name of files) {
          const job = readJsonFile(join(queue, name), undefined);
          if (job?.eventId && job?.accountId && !state.done[job.accountId]) {
            await foldAndLog(directory, config, state, job.eventId, job.accountId, 'pending', ask);
            writeState(directory, state);
          }
          rmSync(join(queue, name), { force: true });
        }
      }
    } finally {
      releaseLock(lock);
    }
    // Words queued while the lock was being let go would otherwise wait for the next note.
    if (!readdirSync(queue).some((name) => name.endsWith('.json'))) return 0;
  }
}

/** The repository file's identity: when it is unchanged, nothing was recorded. */
function mark(directory) {
  try {
    const info = statSync(join(directory, 'repository.json'));
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return 'none';
  }
}

/** Folds the words nobody folded since the last sweep. No change since then: no model call. */
export async function runSweep(directory, { ask = askModel } = {}) {
  const config = readOrganizer(directory);
  if (!config) return 0;
  const { lock } = paths(directory);
  mkdirSync(paths(directory).home, { recursive: true, mode: 0o700 });
  const state = readState(directory);
  if (state.sweptMark && state.sweptMark === mark(directory)) {
    log(directory, { run: 'sweep', outcome: 'no change' });
    return 0;
  }
  if (!takeLock(lock)) return 0;
  let folded = 0;
  try {
    const store = new Store(directory);
    let since = state.sweepCheckpoint ?? new Date().toISOString();
    for (;;) {
      const batch = store.read((repo) => repo.wordsSince({ since, limit: 20 }));
      for (const event of batch.events) {
        for (const word of event.words) {
          if (state.done[word.id] || [config.actor ?? ORGANIZER_ACTOR, IMPORT_ACTOR].includes(word.actor?.id)) continue;
          await foldAndLog(directory, config, state, event.id, word.id, 'sweep', ask);
          folded += 1;
          writeState(directory, state);
        }
      }
      since = batch.checkpoint;
      if (!batch.remaining) break;
    }
    state.sweepCheckpoint = since;
  } finally {
    state.sweptMark = mark(directory);
    writeState(directory, state);
    releaseLock(lock);
  }
  log(directory, { run: 'sweep', outcome: 'done', folded });
  return 0;
}

function status(directory) {
  const config = readOrganizer(directory);
  const say = (line) => process.stdout.write(`${line}\n`);
  if (!config) {
    say(`No organizer for the repository at ${directory}. \`npx protocol-chaos init\` picks one.`);
    return 0;
  }
  say(`Organizer: ${config.agent} (${config.command}${config.model ? `, model ${config.model}` : ''}), writing as "${config.actor ?? ORGANIZER_ACTOR}".`);
  const { log: file, queue } = paths(directory);
  const queued = existsSync(queue) ? readdirSync(queue).filter((name) => name.endsWith('.json')).length : 0;
  say(`Queued: ${queued}.`);
  const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-10) : [];
  say(lines.length ? 'Last runs:' : 'No runs yet.');
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const tokens = entry.usage ? `, ${entry.usage.input ?? '?'} in / ${entry.usage.output ?? '?'} out` : '';
    say(`  ${entry.at} ${entry.run} ${entry.outcome}${entry.eventId ? ` ${entry.eventId}` : ''}${entry.changed ? ` (${entry.changed.join(', ')})` : ''}${entry.ms ? `, ${(entry.ms / 1000).toFixed(1)}s` : ''}${tokens}${entry.error ? `: ${entry.error}` : ''}`);
  }
  return 0;
}

/** `protocol-chaos organize …`; returns the exit code. */
export async function runOrganize(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { pending: { type: 'boolean' }, sweep: { type: 'boolean' }, status: { type: 'boolean' }, data: { type: 'string' } }, strict: true }));
  } catch (error) {
    process.stderr.write(`${error.message}\nUsage: protocol-chaos organize --pending | --sweep | --status [--data <directory>]\n`);
    return 2;
  }
  const directory = resolve(values.data ?? env.PROTOCOL_CHAOS_DATA ?? join(env.HOME || homedir(), '.protocol-chaos'));
  if (values.pending) return runPending(directory);
  if (values.sweep) return runSweep(directory);
  return status(directory);
}
