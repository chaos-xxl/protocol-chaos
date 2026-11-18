// Importing the memories other assistants keep on this machine, once, so that a new repository
// does not start empty: Claude Code's CLAUDE.md and its memory folders, Codex's AGENTS.md and
// memories, Gemini CLI's GEMINI.md, Hermes's MEMORY.md and USER.md, the steering files Kiro
// includes in every conversation, Cursor's rules and AGENTS.md, DeepSeek Harness's AGENTS.md,
// OpenCode's AGENTS.md, OpenClaw's MEMORY.md, USER.md and newest daily notes, Copilot's
// standing instructions and VS Code Copilot's memories, Pi's context file.
// The files are only read. Parts of them about this repository, our own blocks, and keys,
// tokens and long numbers are left out before anything is sent.
//
// The user is asked first, with what would be read and what it would cost: by `init` in a
// terminal, or, when init could not ask, by the next assistant they talk to, through the tool
// memories_import, which is offered only while an import waits to be offered, runs, or waits to
// be reported. With an organizer (organize.mjs), the import runs in the background with its
// model, one call per part of about 6,000 characters: it lists the matters a part shows, with
// the sentences they rest on, copied exactly; a matter whose sentences are not found in the
// part is left out. Without one, the assistant in the conversation reads the parts itself and
// hands back the same list. Each matter is written with event_note (authorized_external, via
// naming the file) as the actor "importer", parents first, and its fields with
// event_record_expression; words on a matter the repository holds already are added to it,
// and only the facts it lacks are filled in. The report counts what was done and shows the tree
// of open matters, the new ones marked.
//
//   protocol-chaos import [--yes] [--only <agents>] [--data <directory>]   ask, then import in the background
//   protocol-chaos import --status [--data <directory>]                    how far it got; the report when done
//   protocol-chaos import --undo [--data <directory>]                      cancel the matters the import started
//   protocol-chaos import --run [--data <directory>]                       the background run (the server starts it)
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import jsonc from 'jsonc-parser';
import { askModel, IMPORT_ACTOR, jsonObject, lockHeld, readOrganizer, releaseLock, takeLock } from './organize.mjs';
import { Store } from './store.mjs';
import { ProtocolError } from './validate.mjs';

export const IMPORT_KEY = 'dev.protocol-chaos/import';
const ENTRY = fileURLToPath(new URL('./index.mjs', import.meta.url));
const CHUNK_CHARS = 6000;
const HEADER_CHARS = 120;
const FILE_LIMIT = 60_000;
const READ_LIMIT = 2 * 1024 * 1024;
const MAX_MATTERS = 40;
const MAX_QUOTES = 6;
const MAX_OFFER_DAYS = 3;
const DIRECTORY_SHOWN = 150;
const STARTING_GRACE_MS = 60_000;
const OPEN = ['emerging', 'active', 'waiting', 'dormant'];
const SET_STATES = ['active', 'waiting', 'dormant', 'done', 'cancelled'];
const FACT_KEYS = ['goal', 'constraint', 'plan'];
const ACTOR = { kind: 'agent', id: IMPORT_ACTOR };
const AGENT_NAMES = {
  'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', hermes: 'Hermes', kiro: 'Kiro', cursor: 'Cursor', dsh: 'DeepSeek Harness',
  opencode: 'OpenCode', openclaw: 'OpenClaw', copilot: 'GitHub Copilot', pi: 'Pi',
};
// OpenClaw writes a daily note a day; the newest ones are read.
const DAILY_NOTES = 30;
// Pi reads the first of these in its folder in every session (as install.mjs).
const PI_CONTEXT = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

/** What the model is asked to do with one part of the notes. */
export const IMPORT_RULES = [
  "You are importing the user's long-lived matters into their personal repository, from the notes other assistants keep about them (memory files and standing instructions). You are given the open matters the repository holds already, and one part of those notes. List the matters these notes show: what the user would still consider unfinished a month from now (a project, a plan, a commitment, a purchase, a trip, a target, an arrangement) and long-horizon aims, including ones set aside or finished when the notes say so. Not a matter: who the user is, their background, tastes and habits; rules for how an assistant should work, write or code; one-off facts; anything the notes only guess at. An aim, plan or target written among such facts (in a profile, under a heading such as background, career or finances) is a matter all the same. When the notes hold none, the list is empty.",
  "For each matter, quotes: the sentences of the notes about it, copied character for character (they are kept as the record of where the matter came from: never reword, translate, shorten or join them), at most five, each a whole sentence or line. A sentence that only shares a word or a theme with a matter is not about it. existing: the id of the repository's matter it is, when it is one of them, else null. For a new one: title, what it is, and when or which where that tells it apart, in the language of the notes, at most 60 characters; ref, a short handle such as m1. parent: the existing id or the ref of the larger matter it is plainly part of or a step toward, else null; for an existing matter, give it only when the repository shows that matter under no larger one. Group them as the user would: a broad aim with its concrete parts under it, not one matter per sentence; a part that only repeats its parent is not a matter of its own.",
  'Fields of a new matter, only what the notes say, in the language of the notes, each clear on its own, or null: goal (what it is meant to achieve, including what would count as done), constraint (limits, deadlines, budgets, wishes and preferences), plan (the arrangement as decided: when, where, how, which option), progress (where it stands, in one short sentence), state (active, waiting, dormant, done or cancelled; null when unclear). Write relative times as concrete dates when the notes date them; otherwise keep them as written. Never write "the user"; write the facts themselves. For an existing matter, give its quotes, and only the fields the notes add.',
].join('\n\n');

/** For a run in the background: the rules, and the answer as one JSON object. */
export const IMPORT_INSTRUCTIONS = `${IMPORT_RULES}\n\nAnswer with one JSON object and nothing else: {"matters": [{"ref": string, "existing": string or null, "title": string or null, "parent": string or null, "state": string or null, "progress": string or null, "goal": string or null, "constraint": string or null, "plan": string or null, "quotes": [string]}]}. Do not use any tool.`;

/** For a run in a conversation: the same rules, and the answer as the next call of the tool. */
const CONVERSATION_INSTRUCTIONS = `${IMPORT_RULES}\n\nThen call memories_import with action "record", this part's number as part, and matters: that list, as objects with the fields ref, existing, title, parent, state, progress, goal, constraint, plan and quotes (null where there is nothing). Do it for each part as it comes, without asking the user: they agreed to the import. After the last part the tool answers with the report.`;

// ------------------------------------------------------------------------------------ paths

function paths(directory) {
  const home = join(directory, 'import');
  return { home, state: join(home, 'state.json'), lock: join(home, 'run.lock'), log: join(home, 'log.jsonl') };
}

/** The import's state, or undefined when no import was ever planned. */
export function readImport(directory) {
  try {
    return JSON.parse(readFileSync(paths(directory).state, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeImport(directory, state) {
  const { home, state: file } = paths(directory);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function log(directory, entry) {
  try {
    const { home, log: file } = paths(directory);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // a log that cannot be written must not stop the import
  }
}

const today = (now = new Date()) => now.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------- sources

function agentHomes(env) {
  const home = env.HOME || homedir();
  return {
    home,
    'claude-code': env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, '.claude'),
    codex: resolve(env.CODEX_HOME || join(home, '.codex')),
    gemini: join(home, '.gemini'),
    hermes: resolve(env.HERMES_HOME || join(home, '.hermes')),
    kiro: join(home, '.kiro'),
    cursor: join(home, '.cursor'),
    dsh: resolve(env.DSH_HOME || join(home, '.dsh')),
    opencode: join(resolve(tildeOff(env.XDG_CONFIG_HOME, home) || join(home, '.config')), 'opencode'),
    openclaw: openclawWorkspace(env, home),
    copilot: resolve(tildeOff(env.COPILOT_HOME, home) || join(home, '.copilot')),
    vscode: vscodeUserDirs(env, home),
    pi: resolve(tildeOff(env.PI_CODING_AGENT_DIR, home) || join(home, '.pi', 'agent')),
  };
}

const tildeOff = (path, home) => (path && (path === '~' || path.startsWith('~/')) ? join(home, path.slice(1)) : path);

function readJsonc(file) {
  try {
    const value = jsonc.parse(readFileSync(file, 'utf8'), [], { allowTrailingComma: true });
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The default agent's workspace of OpenClaw, as install.mjs finds it. */
function openclawWorkspace(env, home) {
  if (env.OPENCLAW_WORKSPACE_DIR) return resolve(env.OPENCLAW_WORKSPACE_DIR);
  const state = resolve(tildeOff(env.OPENCLAW_STATE_DIR, home) || join(env.OPENCLAW_HOME || home, '.openclaw'));
  const configured = readJsonc(resolve(tildeOff(env.OPENCLAW_CONFIG_PATH, home) || join(state, 'openclaw.json')))?.agents?.defaults?.workspace;
  return typeof configured === 'string' && configured.trim() ? resolve(tildeOff(configured.trim(), home)) : join(state, 'workspace');
}

function vscodeUserDirs(env, home) {
  const base = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : resolve(tildeOff(env.XDG_CONFIG_HOME, home) || join(home, '.config'));
  return ['Code', 'Code - Insiders'].map((name) => join(base, name, 'User'));
}

const list = (folder, test = () => true) => {
  try {
    return readdirSync(folder).filter(test).sort();
  } catch {
    return [];
  }
};

/** Every file that may hold memories, by agent, whether or not it exists. */
function candidates(env) {
  const homes = agentHomes(env);
  const out = [];
  const add = (agent, path, via, kind = 'markdown') => out.push({ agent, path, via, kind });
  const claude = homes['claude-code'];
  add('claude-code', join(claude, 'CLAUDE.md'), 'Claude Code: CLAUDE.md');
  for (const project of list(join(claude, 'projects'))) {
    const folder = join(claude, 'projects', project, 'memory');
    const files = list(folder, (name) => name.endsWith('.md'));
    // MEMORY.md is the index of the other files there: their names and one line each.
    for (const name of files.length > 1 ? files.filter((file) => file !== 'MEMORY.md') : files) add('claude-code', join(folder, name), `Claude Code memory: ${name}`);
  }
  add('codex', join(homes.codex, 'AGENTS.md'), 'Codex: AGENTS.md');
  for (const name of list(join(homes.codex, 'memories'), (file) => file.endsWith('.md'))) add('codex', join(homes.codex, 'memories', name), `Codex memory: ${name}`);
  add('gemini', join(homes.gemini, 'GEMINI.md'), 'Gemini CLI: GEMINI.md');
  const hermesHomes = [[homes.hermes, ''], ...list(join(homes.hermes, 'profiles')).map((name) => [join(homes.hermes, 'profiles', name), name])];
  for (const [base, profile] of hermesHomes) {
    for (const name of ['MEMORY.md', 'USER.md']) add('hermes', join(base, 'memories', name), `Hermes memory${profile ? ` (${profile})` : ''}: ${name}`, 'hermes');
  }
  for (const name of list(join(homes.kiro, 'steering'), (file) => file.endsWith('.md'))) add('kiro', join(homes.kiro, 'steering', name), `Kiro steering: ${name}`, 'kiro');
  add('cursor', join(homes.cursor, 'AGENTS.md'), 'Cursor: AGENTS.md');
  for (const name of list(join(homes.cursor, 'rules'), (file) => /\.mdc?$/.test(file))) add('cursor', join(homes.cursor, 'rules', name), `Cursor rules: ${name}`, 'front-matter');
  add('dsh', join(homes.dsh, 'AGENTS.md'), 'DeepSeek Harness: AGENTS.md');
  add('opencode', join(homes.opencode, 'AGENTS.md'), 'OpenCode: AGENTS.md');
  add('openclaw', join(homes.openclaw, 'MEMORY.md'), 'OpenClaw memory: MEMORY.md');
  add('openclaw', join(homes.openclaw, 'USER.md'), 'OpenClaw: USER.md');
  const daily = join(homes.openclaw, 'memory');
  const notes = list(daily, (name) => name.endsWith('.md')).reverse();
  for (const name of notes.slice(0, DAILY_NOTES)) add('openclaw', join(daily, name), `OpenClaw daily note: ${name}`);
  if (notes.length > DAILY_NOTES) {
    out.push({ agent: 'openclaw', path: daily, via: 'OpenClaw daily notes', kind: 'folder', why: `${notes.length - DAILY_NOTES} older daily notes; the newest ${DAILY_NOTES} are read` });
  }
  add('copilot', join(homes.copilot, 'copilot-instructions.md'), 'GitHub Copilot: copilot-instructions.md');
  for (const dir of homes.vscode) {
    const memories = join(dir, 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories');
    for (const name of list(memories, (file) => file.endsWith('.md'))) add('copilot', join(memories, name), `VS Code Copilot memory: ${name}`);
  }
  const context = PI_CONTEXT.find((name) => existsSync(join(homes.pi, name)));
  if (context) add('pi', join(homes.pi, context), `Pi: ${context}`);
  return out;
}

/** The text without the blocks init writes into other files. */
function withoutOurBlocks(text) {
  return text.replace(/^.*protocol-chaos:begin[\s\S]*?protocol-chaos:end.*$\n?/gm, '');
}

/** Splits off YAML front matter: { front, body }. */
function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? { front: match[1], body: text.slice(match[0].length) } : { front: undefined, body: text };
}

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bpc_[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|密码|口令|密钥)\s*[:=：]\s*)[^\s,，;；]+/gi,
  /\b\d{17}[\dXx]\b/g,
  /\b\d{15,19}\b/g,
];

/** Hides keys, tokens, passwords, ID and card numbers; returns { text, count }. */
export function redact(text) {
  let count = 0;
  let out = text;
  for (const pattern of SECRETS) {
    out = out.replace(pattern, (match, prefix) => {
      count += 1;
      return typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[hidden]` : '[hidden]';
    });
  }
  return { text: out, count };
}

/**
 * The files to read, and the ones left out with the reason: about this repository, included by
 * Kiro only when asked, too long. Empty and missing files are not mentioned.
 */
export function findSources(env = process.env) {
  const files = [];
  const skipped = [];
  for (const candidate of candidates(env)) {
    if (candidate.why) {
      skipped.push(candidate);
      continue;
    }
    let info;
    try {
      info = statSync(candidate.path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > READ_LIMIT) {
      skipped.push({ ...candidate, why: `too long (${Math.round(info.size / 1024)} KB)` });
      continue;
    }
    let text = withoutOurBlocks(readFileSync(candidate.path, 'utf8'));
    if (candidate.kind === 'kiro' || candidate.kind === 'front-matter') {
      const { front, body } = frontMatter(text);
      const inclusion = /^\s*inclusion\s*:\s*['"]?([A-Za-z]+)/m.exec(front ?? '')?.[1];
      if (candidate.kind === 'kiro' && inclusion && inclusion !== 'always') {
        skipped.push({ ...candidate, why: `Kiro includes it only in some conversations, by inclusion: ${inclusion}` });
        continue;
      }
      text = body;
    }
    text = text.trim();
    if (!text) continue;
    // Rules for using this repository (a working agreement, our own steering file or skill)
    // name the server or its tools; a note about a project of that name does not.
    if (/\bprotocol_chaos\b|\b(?:context_pack|event_note|event_record_expression)\b/.test(text)) {
      skipped.push({ ...candidate, why: 'rules for using this repository, not memories' });
      continue;
    }
    if (text.length > FILE_LIMIT) {
      skipped.push({ ...candidate, why: `too long (${text.length.toLocaleString('en-US')} characters)` });
      continue;
    }
    const hidden = redact(text);
    files.push({ ...candidate, id: candidate.agent, text: hidden.text, hidden: hidden.count, chars: hidden.text.length, mtime: info.mtime.toISOString() });
  }
  return { files, skipped };
}

// ---------------------------------------------------------------------------------- chunks

function hardSplit(text, limit) {
  const out = [];
  let current = '';
  for (const line of text.split('\n')) {
    for (let start = 0; start < Math.max(line.length, 1); start += limit) {
      const piece = line.slice(start, start + limit);
      if (current && current.length + 1 + piece.length > limit) {
        out.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

/** A file's text in pieces of at most `limit` characters, along paragraphs (Hermes: entries). */
function segments(file, limit = CHUNK_CHARS) {
  const paragraphs = file.kind === 'hermes' ? file.text.split(/\n§\n/) : file.text.split(/\n[ \t]*\n/);
  const out = [];
  let current = '';
  for (const paragraph of paragraphs.map((part) => part.trim()).filter(Boolean)) {
    if (paragraph.length > limit) {
      if (current) out.push(current);
      current = '';
      out.push(...hardSplit(paragraph, limit));
    } else if (current && current.length + 2 + paragraph.length > limit) {
      out.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) out.push(current);
  return out;
}

/** The parts sent to the model, each at most about CHUNK_CHARS: whole files where they fit. */
export function makeChunks(files, limit = CHUNK_CHARS) {
  const chunks = [];
  let parts = [];
  let size = 0;
  const flush = () => {
    if (!parts.length) return;
    const text = parts.map((part) => `=== ${part.via} (last changed ${part.mtime.slice(0, 10)}) ===\n${part.text}`).join('\n\n');
    chunks.push({ parts, text });
    parts = [];
    size = 0;
  };
  for (const file of files) {
    for (const segment of segments(file, limit - HEADER_CHARS)) {
      const cost = segment.length + HEADER_CHARS;
      if (size && size + cost > limit) flush();
      const last = parts[parts.length - 1];
      if (last && last.path === file.path) last.text += `\n\n${segment}`;
      else parts.push({ via: file.via, path: file.path, mtime: file.mtime, text: segment });
      size += cost;
    }
  }
  flush();
  return chunks;
}

// ------------------------------------------------------------------------------ estimates

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g;

/** About how many tokens a text is: CJK characters count more than Latin ones. */
export function tokensOf(text) {
  const cjk = (String(text).match(CJK) ?? []).length;
  return Math.ceil(cjk * 0.75 + (String(text).length - cjk) / 3.6);
}

const CALL_OVERHEAD = 600;

/** Tokens and seconds for the parts, by where they run. */
function estimate(chunks, openCount, mode, agent) {
  const rules = tokensOf(IMPORT_INSTRUCTIONS) + CALL_OVERHEAD;
  let input = 0;
  let output = 0;
  let seconds = 0;
  let matters = openCount;
  for (const chunk of chunks) {
    const notes = tokensOf(chunk.text);
    const directory = 25 * Math.min(DIRECTORY_SHOWN, matters);
    const answer = Math.min(2500, 150 + Math.round(notes * 0.35));
    input += rules + directory + notes + 60;
    output += answer;
    seconds += 8 + answer / 50 + (rules + directory + notes) / 3000;
    matters += 4;
  }
  if (mode === 'conversation') seconds *= 1.5;
  if (agent === 'codex') seconds *= 2;
  return { parts: chunks.length, input, output, tokens: input + output, seconds: Math.round(seconds), minutes: Math.max(1, Math.round(seconds / 60)) };
}

const number = (value) => Number(value ?? 0).toLocaleString('en-US');

/** Where the text goes, said precisely: it is the part of the import that leaves this computer. */
function whereItGoes(plan) {
  const start = 'The memory files are only read, never changed. They and the repository stay on this computer';
  const end = 'Protocol Chaos itself has no server and sends nothing anywhere else.';
  if (plan.mode === 'conversation') {
    return `${start}; the notes go to the model of the assistant you are talking to, as part of this conversation, as everything you say to it does. ${end}`;
  }
  const config = plan.organizer;
  const via = config.agent === 'dsh'
    ? `the model DeepSeek Harness runs here (${config.model ?? 'deepseek-flash'}, through ${!config.provider || config.provider === 'deepseek-official' ? "DeepSeek's API" : `the provider ${config.provider}`})`
    : config.agent === 'claude-code'
      ? `the model Claude Code runs here (${config.model ?? 'haiku'}, through the provider Claude Code is set up with)`
      : `the model ${AGENT_NAMES[config.agent] ?? config.agent} runs here (through the provider it is set up with)`;
  return `${start}; to organize them, the notes are sent in ${plan.estimate.parts} part${plan.estimate.parts === 1 ? '' : 's'} to ${via}, as when you use ${AGENT_NAMES[config.agent] ?? config.agent} yourself. ${end}`;
}

function openCount(directory) {
  // Planning changes nothing: no repository folder is made for it.
  if (!existsSync(join(directory, 'repository.json'))) return 0;
  try {
    return new Store(directory).read((repo) => repo.contextPack({ state: 'open' }).events.length);
  } catch {
    return 0;
  }
}

/** What an import would read, leave out and cost; `only` narrows it to some agents. */
export function planImport(env, directory, only) {
  const { files: all, skipped } = findSources(env);
  const files = only?.length ? all.filter((file) => only.includes(file.agent)) : all;
  const organizer = readOrganizer(directory);
  const mode = organizer ? 'background' : 'conversation';
  const chunks = makeChunks(files);
  const plan = { files, skipped, chunks, organizer, mode, hidden: files.reduce((sum, file) => sum + file.hidden, 0) };
  plan.estimate = estimate(chunks, openCount(directory), mode, organizer?.agent);
  plan.where = whereItGoes(plan);
  return plan;
}

/** The files read, by agent: [{ id, assistant, files, characters, paths }]. */
function byAgent(files, home) {
  const groups = new Map();
  for (const file of files) {
    const group = groups.get(file.agent) ?? { id: file.agent, assistant: AGENT_NAMES[file.agent], files: 0, characters: 0, paths: [] };
    group.files += 1;
    group.characters += file.chars;
    group.paths.push(tilde(file.path, home));
    groups.set(file.agent, group);
  }
  return [...groups.values()];
}

const tilde = (path, home) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** The plan as the tool hands it to an assistant's model. */
function planForModel(plan, env) {
  const home = env.HOME || homedir();
  return {
    read: byAgent(plan.files, home),
    leftOut: plan.skipped.map((file) => ({ path: tilde(file.path, home), why: file.why })),
    hidden: plan.hidden ? `${plan.hidden} key${plan.hidden === 1 ? '' : 's'}, token${plan.hidden === 1 ? '' : 's'} or long number${plan.hidden === 1 ? '' : 's'} hidden before anything is sent` : undefined,
    estimate: {
      parts: plan.estimate.parts,
      tokens: plan.estimate.tokens,
      input: plan.estimate.input,
      output: plan.estimate.output,
      minutes: plan.estimate.minutes,
      note: plan.mode === 'conversation'
        ? 'An estimate; the model counts the real tokens. Each part is one more turn of this conversation, so the conversation so far is sent again with it.'
        : 'An estimate; the provider counts the real tokens.',
    },
    runs: plan.mode === 'background'
      ? `in the background, with the model of ${AGENT_NAMES[plan.organizer.agent] ?? plan.organizer.agent}; the user can keep talking meanwhile`
      : 'in this conversation, with your own model: no assistant here can run in the background',
    where: plan.where,
  };
}

/** The plan as the installer and `protocol-chaos import` print it. */
export function describePlan(plan, env = process.env) {
  const home = env.HOME || homedir();
  const lines = ["Memories other assistants keep on this machine:"];
  for (const group of byAgent(plan.files, home)) lines.push(`  ${group.assistant.padEnd(18)} ${group.files} file${group.files === 1 ? '' : 's'}, ${number(group.characters)} characters`);
  for (const file of plan.skipped) lines.push(`  left out: ${tilde(file.path, home)} (${file.why})`);
  if (plan.hidden) lines.push(`  ${plan.hidden} key${plan.hidden === 1 ? '' : 's'}, token${plan.hidden === 1 ? '' : 's'} or long number${plan.hidden === 1 ? '' : 's'} hidden before anything is sent`);
  const { parts, tokens, input, output, minutes } = plan.estimate;
  lines.push(`Importing them: ${parts} part${parts === 1 ? '' : 's'}, about ${number(tokens)} tokens (${number(input)} in, ${number(output)} out; an estimate) and about ${minutes} minute${minutes === 1 ? '' : 's'},`);
  lines.push(plan.mode === 'background'
    ? `  in the background, with the model of ${AGENT_NAMES[plan.organizer.agent] ?? plan.organizer.agent}.`
    : '  in a conversation with one of your assistants, with its model: none of them can run in the background here.');
  lines.push(...wrap(plan.where, 96).map((line) => `  ${line}`));
  return lines;
}

function wrap(text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ----------------------------------------------------------------------- the model's input

const clip = (text, limit) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};

/** What the model is shown for one part: the date, the open matters, and the part. */
export function partInput(chunk, index, of, entries, now = new Date()) {
  const open = entries.filter((entry) => OPEN.includes(entry.state)).slice(0, DIRECTORY_SHOWN);
  const lines = [`Today is ${today(now)}.`, '', "The repository's open matters (id: title, state; the larger matter it is part of):"];
  if (!open.length) lines.push('(none yet)');
  for (const entry of open) lines.push(`- ${entry.id}: ${clip(entry.title ?? '(untitled)', 70)} (${entry.state}${entry.parents?.length ? `; part of ${entry.parents.join(', ')}` : ''})`);
  lines.push('', `The notes, part ${index + 1} of ${of}:`, '', chunk.text);
  return lines.join('\n');
}

// ------------------------------------------------------------------------------- writing

const normalize = (text) => String(text).replace(/[*`#>]+/g, '').replace(/\s+/g, ' ').trim();
const text = (value, limit) => (typeof value === 'string' && value.trim() ? clip(value, limit) : undefined);

/**
 * One character as quotes are matched on it. Models retype what they copy: they drop markdown
 * marks and spaces, swap dashes, quote marks and full-width forms, and add a full stop. None of
 * that is in the matching, so a quote is found where the notes say the same thing.
 */
function looseChar(char) {
  if (/[\s*`#>]/u.test(char)) return '';
  const form = char.normalize('NFKC');
  // Dashes, and the tildes that write a range such as 35~40.
  if (/^[~\u2010-\u2015\u2212\u2E3A\u2E3B\u301C\uFE58\uFE63]$/u.test(form)) return '-';
  if (/^["\u201C-\u201F\u2033\u00AB\u00BB\u300C-\u300F]$/u.test(form)) return '"';
  if (/^['\u2018-\u201B\u2032]$/u.test(form)) return "'";
  return form.toLowerCase();
}

/** The text as matched, with where each of its characters came from in the text. */
function loosen(original) {
  let loose = '';
  const starts = [];
  const ends = [];
  let index = 0;
  for (const char of original) {
    for (const piece of looseChar(char)) {
      loose += piece;
      for (let unit = 0; unit < piece.length; unit += 1) {
        starts.push(index);
        ends.push(index + char.length);
      }
    }
    index += char.length;
  }
  return { text: original, loose, starts, ends };
}

const END_MARKS = /[。.,、;:!?]+$/u;

/** Where the notes say what the quote says: those words of the notes, as written there, or undefined. */
function inNotes(notes, quote) {
  const whole = loosen(quote).loose;
  const core = whole.replace(END_MARKS, '');
  if (core.length < 4 || core.length > 1500) return undefined;
  const at = notes.loose.indexOf(core);
  if (at < 0) return undefined;
  let start = notes.starts[at];
  let end = notes.ends[at + core.length - 1];
  // A **bold** or `code` mark the words open or close without the other one is taken in from
  // beside them; then the end marks the quote has where the notes have them too.
  for (const mark of ['**', '`']) {
    if ((notes.text.slice(start, end).split(mark).length - 1) % 2 === 0) continue;
    if (notes.text.slice(start - mark.length, start) === mark) start -= mark.length;
    else if (notes.text.slice(end, end + mark.length) === mark) end += mark.length;
  }
  for (const mark of whole.slice(core.length)) {
    if (end >= notes.text.length || looseChar(notes.text[end]) !== mark) break;
    end += 1;
  }
  return notes.text.slice(start, end).trim();
}

/** The quotes that are in the part, as the notes word them, grouped by the file they are in: [{ via, mtime, text }]. */
function groundedQuotes(chunk, quotes) {
  if (!Array.isArray(quotes)) return [];
  const parts = chunk.parts.map((part) => ({ part, notes: loosen(part.text), quotes: [] }));
  const seen = new Set();
  let kept = 0;
  for (const quote of quotes) {
    if (typeof quote !== 'string' || kept >= MAX_QUOTES) continue;
    for (const candidate of parts) {
      const words = inNotes(candidate.notes, quote);
      if (!words) continue;
      if (!seen.has(words)) {
        seen.add(words);
        candidate.quotes.push(words);
        kept += 1;
      }
      break;
    }
  }
  return parts.filter((candidate) => candidate.quotes.length).map(({ part, quotes: found }) => ({ via: part.via, mtime: part.mtime, text: found.join('\n') }));
}

/**
 * Writes what the model listed for one part: new matters (parents first) with their fields,
 * words on matters the repository holds, and a larger matter for one this import started under
 * none. A matter none of whose quotes is in the part, or a new one without a title, is left out.
 * Returns { created, noted, linked, dropped, why }: why counts the left out by reason, without words.
 */
export async function applyExtraction(store, chunk, answer, { runId, now = new Date() } = {}) {
  const out = { created: [], noted: [], linked: [], dropped: 0, why: { quote: 0, title: 0, refused: 0 } };
  const listed = Array.isArray(answer?.matters) ? answer.matters.slice(0, MAX_MATTERS) : [];
  const entries = store.read((repo) => repo.contextPack({}).events);
  const known = new Map(entries.map((entry) => [entry.id, entry]));
  const byTitle = new Map(entries.filter((entry) => OPEN.includes(entry.state) && entry.title).map((entry) => [normalize(entry.title).toLowerCase(), entry.id]));
  const items = [];
  listed.forEach((raw, index) => {
    const groups = raw && typeof raw === 'object' ? groundedQuotes(chunk, raw.quotes) : [];
    const title = text(raw?.title, 80);
    let existing = typeof raw?.existing === 'string' && known.has(raw.existing) ? raw.existing : undefined;
    if (!existing && title && byTitle.has(normalize(title).toLowerCase())) existing = byTitle.get(normalize(title).toLowerCase());
    if (!groups.length || (!existing && !title)) {
      out.dropped += 1;
      out.why[groups.length ? 'title' : 'quote'] += 1;
      return;
    }
    const facts = {};
    for (const key of FACT_KEYS) {
      const value = text(raw[key], 4000);
      if (value) facts[key] = value;
    }
    const state = typeof raw.state === 'string' && SET_STATES.includes(raw.state.trim()) ? raw.state.trim() : undefined;
    items.push({ ref: text(raw.ref, 40) ?? `m${index + 1}`, existing, title, parent: text(raw.parent, 80), state, progress: text(raw.progress, 300), facts, groups });
  });
  // A matter whose parent is another of the list comes after it; a cycle loses its link.
  const refs = new Map(items.map((item) => [item.ref, item]));
  const ordered = [];
  const placed = new Set();
  const visiting = new Set();
  const visit = (item) => {
    if (placed.has(item)) return;
    visiting.add(item);
    const parent = refs.get(item.parent);
    if (parent && (parent === item || visiting.has(parent))) item.parent = undefined;
    else if (parent) visit(parent);
    visiting.delete(item);
    placed.add(item);
    ordered.push(item);
  };
  items.forEach(visit);
  const idOf = new Map();
  for (const item of ordered) {
    try {
      // Two of the list with one title, or one an earlier part started: the same matter.
      const same = item.existing ?? byTitle.get(normalize(item.title).toLowerCase());
      if (same) {
        idOf.set(item.ref, same);
        if (await addWords(store, same, item)) out.noted.push(same);
        const parentId = item.parent && known.has(item.parent) ? item.parent : idOf.get(item.parent);
        if (parentId && parentId !== same && await linkStarted(store, same, parentId, item, runId)) out.linked.push(same);
        continue;
      }
      const parentId = item.parent && known.has(item.parent) ? item.parent : idOf.get(item.parent);
      const [first, ...more] = item.groups;
      const receipt = await store.write((repo) => repo.eventNote({
        actor: ACTOR, text: first.text, accountSource: 'authorized_external', via: first.via, title: item.title,
        ...(parentId ? { parentEventId: parentId } : {}),
      }));
      idOf.set(item.ref, receipt.eventId);
      byTitle.set(normalize(item.title).toLowerCase(), receipt.eventId);
      const set = { metadata: { [IMPORT_KEY]: { run: runId, from: first.via, at: now.toISOString() } } };
      if (item.state) set.state = item.state;
      if (item.progress) set.progress = { text: item.progress, timestamp: first.mtime };
      if (Object.keys(item.facts).length) set.facts = item.facts;
      await store.write((repo) => repo.recordExpression({
        eventId: receipt.eventId, actor: ACTOR, text: first.text, accountSource: 'authorized_external', via: first.via,
        accountId: receipt.accountId, expectedVersion: receipt.version, set,
      }));
      for (const group of more) {
        await store.write((repo) => repo.eventNote({ actor: ACTOR, eventId: receipt.eventId, text: group.text, accountSource: 'authorized_external', via: group.via }));
      }
      out.created.push(receipt.eventId);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      out.dropped += 1;
      out.why.refused += 1;
    }
  }
  return out;
}

/**
 * Puts a matter this import started, under no larger matter yet, under the one a later part of
 * the notes names, grounded on the words of the notes about it. Matters the repository held
 * before are left where they are. Returns whether it linked them.
 */
async function linkStarted(store, eventId, parentId, item, runId) {
  const current = store.read((repo) => repo.getProtocol({ eventId, accounts: 'all' }));
  if (current.event.parents?.length || current.event.metadata?.[IMPORT_KEY]?.run !== runId) return false;
  const texts = new Set(item.groups.map((group) => group.text));
  const sources = current.accounts.filter((account) => texts.has(account.text)).map((account) => account.id);
  if (!sources.length) return false;
  try {
    await store.write((repo) => repo.addParent({ childEventId: eventId, parentEventId: parentId, actor: ACTOR, sourceAccountIds: sources }));
    return true;
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error; // a cycle, say: it stays where it is
    return false;
  }
}

/** Adds the words to a matter that has not got them yet, and fills in the facts it lacks. */
async function addWords(store, eventId, item) {
  const current = store.read((repo) => repo.getProtocol({ eventId, accounts: 'all' }));
  const said = new Set(current.accounts.map((account) => account.text));
  let receipt;
  let words;
  for (const group of item.groups) {
    if (said.has(group.text)) continue;
    receipt = await store.write((repo) => repo.eventNote({ actor: ACTOR, eventId, text: group.text, accountSource: 'authorized_external', via: group.via }));
    words = group;
  }
  if (!receipt) return false;
  const missing = Object.fromEntries(Object.entries(item.facts).filter(([key]) => !current.event.facts?.[key]));
  if (Object.keys(missing).length) {
    try {
      await store.write((repo) => repo.recordExpression({
        eventId, actor: ACTOR, text: words.text, accountId: receipt.accountId, expectedVersion: receipt.version, set: { facts: missing },
      }));
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error; // someone wrote meanwhile: the words are there
    }
  }
  return true;
}

// -------------------------------------------------------------------------------- reports

/** The open matters as a tree, larger ones first with their parts under them; `marked` get a +. */
export function renderTree(entries, marked = new Set(), limit = 80) {
  const open = entries.filter((entry) => OPEN.includes(entry.state));
  const ids = new Set(open.map((entry) => entry.id));
  const parts = new Map();
  const roots = [];
  for (const entry of open) {
    const parents = (entry.parents ?? []).filter((id) => ids.has(id));
    if (!parents.length) roots.push(entry);
    for (const id of parents) parts.set(id, [...(parts.get(id) ?? []), entry]);
  }
  const lines = [];
  let more = 0;
  const walk = (entry, depth, above) => {
    if (above.has(entry.id)) return;
    if (lines.length < limit) {
      const note = ['waiting', 'dormant'].includes(entry.state) ? ` (${entry.state})` : '';
      lines.push(`${'  '.repeat(depth)}${marked.has(entry.id) ? '+' : '-'} ${clip(entry.title ?? '(untitled)', 80)}${note}`);
    } else {
      more += 1;
    }
    for (const part of parts.get(entry.id) ?? []) walk(part, depth + 1, new Set([...above, entry.id]));
  };
  roots.forEach((entry) => walk(entry, 0, new Set()));
  if (more) lines.push(`… and ${more} more`);
  return lines.join('\n') || '(no open matters)';
}

function took(from, to) {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The matters the repository held before the import that it added words to: not those it started itself. */
function notedBefore(run) {
  const created = new Set(run?.created ?? []);
  return [...new Set(run?.noted ?? [])].filter((id) => !created.has(id));
}

/** The report of a finished import, with the tree of open matters. */
export function importReport(directory, state) {
  const run = state.run ?? {};
  const entries = new Store(directory).read((repo) => repo.contextPack({}).events);
  const existing = new Set(entries.map((entry) => entry.id));
  const created = (run.created ?? []).filter((id) => existing.has(id));
  return {
    finishedAt: run.finishedAt,
    took: run.startedAt && run.finishedAt ? took(run.startedAt, run.finishedAt) : undefined,
    read: run.read,
    newMatters: created.length,
    wordsAddedToExisting: notedBefore(run).length,
    leftOut: run.dropped ? `${run.dropped} matter${run.dropped === 1 ? '' : 's'} the model named without a sentence of the notes to rest on, or without a title` : undefined,
    tokens: run.usage && (run.usage.input || run.usage.output) ? run.usage : undefined,
    problems: run.errors?.length ? run.errors : undefined,
    tree: renderTree(entries, new Set(created)),
    treeNote: 'The open matters in the repository now: a part is indented under the larger matter it belongs to; + marks the ones this import started.',
    undo: '`npx protocol-chaos import --undo` cancels the matters this import started (words are never deleted).',
  };
}

// ------------------------------------------------------------------------------ the state

/** Whether the import is to be offered, followed or reported: 'pending', 'running', 'done' or undefined. */
export function importOffer(directory, now = new Date()) {
  const state = readImport(directory);
  if (!state) return undefined;
  if (state.status === 'pending' || state.status === 'failed') {
    const offered = state.offered ?? [];
    return offered.length < MAX_OFFER_DAYS || offered.includes(today(now)) ? 'pending' : undefined;
  }
  if (state.status === 'running') return 'running';
  if (state.status === 'done' && !state.reported) return 'done';
  return undefined;
}

/** A run in the background whose process ended before it finished is failed: start resumes it. */
function settle(directory, state, now = new Date()) {
  if (state?.status !== 'running' || state.run?.mode !== 'background') return state;
  if (lockHeld(paths(directory).lock)) return state;
  if (now - Date.parse(state.run.updatedAt ?? state.run.startedAt) < STARTING_GRACE_MS) return state;
  state.status = 'failed';
  state.run.errors = [...(state.run.errors ?? []), `the import stopped after part ${state.run.chunk} of ${state.run.of}`];
  writeImport(directory, state);
  return state;
}

/** Records that init found memories and could not ask: the assistants offer the import. */
export function pendImport(directory, now = new Date()) {
  const state = readImport(directory);
  if (state && state.status !== 'declined' && state.status !== 'empty') return state;
  const next = { status: 'pending', plannedAt: now.toISOString(), offered: [] };
  writeImport(directory, next);
  return next;
}

/** The user said no: the import is not offered again. */
export function declineImport(directory, why, now = new Date()) {
  const state = readImport(directory) ?? {};
  if (state.status === 'running') return state;
  const next = { ...state, status: 'declined', declinedAt: now.toISOString(), why };
  writeImport(directory, next);
  return next;
}

/** Starts an import of the plan: in the background with the organizer, or in the conversation. */
export function startImport(directory, plan, { now = new Date(), entry = ENTRY, spawnWorker = true } = {}) {
  const state = readImport(directory) ?? {};
  const agents = [...new Set(plan.files.map((file) => file.agent))];
  const resume = state.status === 'failed' && state.run?.mode === plan.mode && JSON.stringify(state.run.sources) === JSON.stringify(agents);
  const run = resume ? { ...state.run } : {
    id: `imp_${now.getTime().toString(36)}`,
    mode: plan.mode,
    agent: plan.organizer?.agent,
    sources: agents,
    read: byAgent(plan.files, '').map(({ assistant, files }) => ({ assistant, files })),
    startedAt: now.toISOString(),
    chunk: 0,
    of: plan.chunks.length,
    created: [],
    noted: [],
    dropped: 0,
    usage: { input: 0, output: 0, cached: 0 },
    errors: [],
  };
  run.updatedAt = now.toISOString();
  const repository = join(directory, 'repository.json');
  if (!run.backup && existsSync(repository)) {
    run.backup = join(paths(directory).home, `repository-before-${run.id}.json`);
    mkdirSync(paths(directory).home, { recursive: true, mode: 0o700 });
    copyFileSync(repository, run.backup);
  }
  const next = { ...state, status: 'running', run, reported: false };
  delete next.declinedAt;
  writeImport(directory, next);
  if (plan.mode === 'background' && spawnWorker) {
    const child = spawn(process.execPath, [entry, 'import', '--run', '--data', directory], { detached: true, stdio: 'ignore', cwd: directory, env: process.env });
    child.on('error', () => {});
    child.unref();
  }
  return next;
}

/** Marks the run finished; tells the user when it ran in the background. */
function finishRun(directory, state, env, now = new Date()) {
  state.status = 'done';
  state.reported = false;
  state.run.finishedAt = now.toISOString();
  state.run.updatedAt = state.run.finishedAt;
  state.history = [...(state.history ?? []), { id: state.run.id, finishedAt: state.run.finishedAt, created: state.run.created.length }].slice(-10);
  writeImport(directory, state);
  log(directory, { run: state.run.id, outcome: 'done', created: state.run.created.length, noted: state.run.noted.length, dropped: state.run.dropped });
  if (state.run.mode === 'background') notifyDone(env, state.run);
}

/** A desktop notification when the import is done, on the user's own machine only. */
function notifyDone(env, run) {
  if (env.PROTOCOL_CHAOS_NO_NOTIFY === '1') return;
  if (resolve(env.HOME || homedir()) !== resolve(userInfo().homedir)) return;
  const count = run.created.length;
  const chinese = run.chinese;
  const title = 'Protocol Chaos';
  const message = chinese
    ? `已从其他助手的记忆里整理出 ${count} 件事。打开任意一个助手，它会把结果和整棵事情树给你看。`
    : `${count} matter${count === 1 ? '' : 's'} imported from your assistants' memories. Open any assistant to see them.`;
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], { stdio: 'ignore', timeout: 5000 });
  } else if (process.platform === 'linux') {
    spawnSync('notify-send', [title, message], { stdio: 'ignore', timeout: 5000 });
  }
}

const mostlyChinese = (chunks) => {
  const all = chunks.map((chunk) => chunk.text).join('');
  return all.length > 0 && (all.match(CJK) ?? []).length / all.length > 0.2;
};

// ------------------------------------------------------------------------- the background run

/** The background run: one model call per part, from where an earlier run stopped. */
export async function runImport(directory, { env = process.env, ask = askModel, now = () => new Date() } = {}) {
  const { lock, home } = paths(directory);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!takeLock(lock, 6 * 60 * 60_000)) return 0;
  let state;
  try {
    state = readImport(directory);
    if (state?.status !== 'running' || state.run?.mode !== 'background') return 0;
    const config = readOrganizer(directory);
    if (!config) {
      state.status = 'failed';
      state.run.errors.push('no organizer is set up any more');
      writeImport(directory, state);
      return 1;
    }
    const plan = planImport(env, directory, state.run.sources);
    state.run.of = plan.chunks.length;
    state.run.chinese = mostlyChinese(plan.chunks);
    const store = new Store(directory);
    let failedInARow = 0;
    for (let index = state.run.chunk; index < plan.chunks.length; index += 1) {
      const chunk = plan.chunks[index];
      const entries = store.read((repo) => repo.contextPack({}).events);
      const input = partInput(chunk, index, plan.chunks.length, entries, now());
      let answer;
      let error;
      for (let attempt = 1; attempt <= 2 && !answer; attempt += 1) {
        const reply = await ask(directory, config, IMPORT_INSTRUCTIONS, input);
        for (const key of ['input', 'output', 'cached']) state.run.usage[key] += reply.usage?.[key] ?? 0;
        answer = reply.error ? undefined : jsonObject(reply.text);
        error = reply.error ?? (answer ? undefined : 'the answer held no JSON object');
        log(directory, { run: state.run.id, part: index + 1, attempt, outcome: answer ? 'answered' : 'failed', ms: reply.ms, usage: reply.usage, error });
      }
      if (!answer) {
        state.run.errors.push(`part ${index + 1}: ${error}`);
        failedInARow += 1;
        if (failedInARow >= 2) {
          state.status = 'failed';
          state.run.chunk = index + 1 - failedInARow;
          state.run.updatedAt = now().toISOString();
          writeImport(directory, state);
          return 1;
        }
      } else {
        failedInARow = 0;
        const result = await applyExtraction(store, chunk, answer, { runId: state.run.id, now: now() });
        state.run.created.push(...result.created);
        state.run.noted.push(...result.noted);
        state.run.dropped += result.dropped;
        // Counts only, as everywhere in this log: what was written and why any was left out.
        log(directory, { run: state.run.id, part: index + 1, outcome: 'written', created: result.created.length, noted: result.noted.length, linked: result.linked.length, dropped: result.dropped, why: result.why });
      }
      state.run.chunk = index + 1;
      state.run.updatedAt = now().toISOString();
      writeImport(directory, state);
    }
    finishRun(directory, state, env, now());
    return 0;
  } catch (error) {
    if (state?.run) {
      state.status = 'failed';
      state.run.errors.push(`${error.code ?? error.name}: ${error.message}`);
      writeImport(directory, state);
    }
    return 1;
  } finally {
    releaseLock(lock);
  }
}

// ------------------------------------------------------------------------------- the tool

const TELL_OFFER = 'Tell the user, in their language and briefly: whose memories would be read (read: assistants, files, size), what is left out and why, the estimated tokens and time, how it runs, and where the text goes (where, said as it is). Ask whether to import. If they agree, call memories_import with action start; to import only some assistants, pass sources with their ids from read. If they decline, call it with action decline. Do neither without their answer.';
const TELL_REPORT = 'Tell the user, in their language, that the import finished: the counts, and any problems. Then show the tree exactly as given, one matter per line, indented as it is, and say what + means. Then call memories_import with action finish.';

function check(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ProtocolError('VALIDATION_ERROR', 'memories_import input must be an object.');
  for (const key of Object.keys(input)) {
    if (!['action', 'sources', 'part', 'matters'].includes(key)) throw new ProtocolError('VALIDATION_ERROR', `memories_import input: unknown member ${JSON.stringify(key)}.`);
  }
  if (!['status', 'start', 'decline', 'record', 'finish'].includes(input.action)) {
    throw new ProtocolError('VALIDATION_ERROR', 'memories_import: action must be status, start, decline, record or finish.');
  }
  if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.some((id) => !Object.hasOwn(AGENT_NAMES, id)))) {
    throw new ProtocolError('VALIDATION_ERROR', `memories_import: sources lists assistants by id: ${Object.keys(AGENT_NAMES).join(', ')}.`);
  }
}

/** One part handed to the assistant in the conversation. */
function conversationPart(directory, store, plan, index, extra = {}) {
  const entries = store.read((repo) => repo.contextPack({}).events);
  return {
    status: 'running',
    mode: 'conversation',
    part: index + 1,
    of: plan.chunks.length,
    ...extra,
    instructions: CONVERSATION_INSTRUCTIONS,
    notes: partInput(plan.chunks[index], index, plan.chunks.length, entries),
  };
}

/** The tool memories_import, for an assistant's model; returns what to tell the user and do next. */
export async function memoriesTool(directory, input, { env = process.env, entry = ENTRY, store = new Store(directory), now = new Date(), spawnWorker = true } = {}) {
  check(input);
  let state = settle(directory, readImport(directory), now);
  const status = state?.status;
  const nothing = { status: 'none', tell: 'There is no import to offer or report.' };

  if (input.action === 'status') {
    if (status === 'pending' || status === 'failed') {
      const plan = planImport(env, directory);
      if (!plan.files.length) {
        writeImport(directory, { ...state, status: 'empty' });
        return { status: 'none', tell: 'No memories of other assistants are left to import; say nothing about it.' };
      }
      state.offered = [...new Set([...(state.offered ?? []), today(now)])];
      writeImport(directory, state);
      return {
        status,
        ...(status === 'failed' ? { stopped: state.run?.errors?.at(-1), note: 'An earlier attempt stopped; start resumes it.' } : {}),
        plan: planForModel(plan, env),
        tell: TELL_OFFER,
      };
    }
    if (status === 'running') {
      const { run } = state;
      const left = run.mode === 'background' ? Math.max(1, Math.round(((run.of - run.chunk) * 40) / 60)) : undefined;
      return {
        status, mode: run.mode, part: run.chunk, of: run.of, newMattersSoFar: run.created.length, startedAt: run.startedAt,
        ...(left ? { minutesLeft: left } : {}),
        tell: run.mode === 'background'
          ? 'Tell the user how far it got. When they write again after it should have finished, call status again before answering.'
          : 'This import runs in this conversation: go on with the part you were given, or call start to have it handed to you again.',
      };
    }
    if (status === 'done' && !state.reported) return { status, report: importReport(directory, state), tell: TELL_REPORT };
    return nothing;
  }

  if (input.action === 'start') {
    if (status === 'running') {
      if (state.run.mode !== 'conversation') return { status, tell: 'It is running already: call status for how far it got.' };
      const plan = planImport(env, directory, state.run.sources);
      if (state.run.chunk < plan.chunks.length) return conversationPart(directory, store, plan, state.run.chunk);
    }
    if (status === 'done' && !state.reported) return { status, tell: 'It finished already: call status for the report.' };
    const plan = planImport(env, directory, input.sources);
    if (!plan.files.length) return { status: 'none', tell: 'There is nothing to import: no memories of other assistants were found on this machine.' };
    state = startImport(directory, plan, { now, entry, spawnWorker });
    if (plan.mode === 'background') {
      const ready = new Date(now.getTime() + plan.estimate.seconds * 1000).toISOString();
      return {
        status: 'running', mode: 'background', parts: plan.estimate.parts, minutes: plan.estimate.minutes, readyAround: ready,
        tell: `Tell the user it runs in the background, about ${plan.estimate.minutes} minute${plan.estimate.minutes === 1 ? '' : 's'}, and that a desktop notification says when it is done. When they write again in this conversation after about ${ready.slice(11, 16)} UTC, call memories_import with action status before answering, and report as it says.`,
      };
    }
    return conversationPart(directory, store, plan, 0, { tell: 'The user agreed: read the notes, then call record, part after part, as the instructions say.' });
  }

  if (input.action === 'record') {
    if (status !== 'running' || state.run.mode !== 'conversation') {
      throw new ProtocolError('VALIDATION_ERROR', 'memories_import record: there is no import running in a conversation. Call status.');
    }
    const expected = state.run.chunk + 1;
    if (Number(input.part) !== expected) throw new ProtocolError('VALIDATION_ERROR', `memories_import record: part ${expected} is the next one; pass part: ${expected}.`);
    if (!Array.isArray(input.matters)) throw new ProtocolError('VALIDATION_ERROR', 'memories_import record: matters must be a list (empty when the part shows none).');
    const plan = planImport(env, directory, state.run.sources);
    const chunk = plan.chunks[expected - 1];
    if (chunk) {
      const result = await applyExtraction(store, chunk, { matters: input.matters }, { runId: state.run.id, now });
      state.run.created.push(...result.created);
      state.run.noted.push(...result.noted);
      state.run.dropped += result.dropped;
      state.run.recorded = { created: result.created.length, noted: result.noted.length, linked: result.linked.length, dropped: result.dropped, why: result.why };
    }
    state.run.chunk = expected;
    state.run.of = plan.chunks.length;
    state.run.updatedAt = now.toISOString();
    writeImport(directory, state);
    if (expected < plan.chunks.length) {
      return conversationPart(directory, store, plan, expected, { recorded: state.run.recorded, tell: 'Read the next part and call record again.' });
    }
    finishRun(directory, state, env, now);
    return { status: 'done', report: importReport(directory, state), tell: TELL_REPORT };
  }

  if (input.action === 'decline') {
    if (status === 'running') return { status, tell: 'It is running already; it cannot be declined now.' };
    declineImport(directory, 'declined in a conversation', now);
    return { status: 'declined', tell: 'Tell the user it will not be offered again, and that `npx protocol-chaos import` imports later.' };
  }

  // finish
  if (status === 'done' && !state.reported) {
    writeImport(directory, { ...state, reported: true, reportedAt: now.toISOString() });
    return { status: 'reported', tell: 'Done: it is not offered again.' };
  }
  return nothing;
}

// ---------------------------------------------------------------------------------- undo

/** Cancels the matters the last import started, except those someone else has written on since. */
export async function undoImport(directory, now = new Date()) {
  const state = readImport(directory);
  const created = state?.run?.created ?? [];
  const store = new Store(directory);
  const result = { cancelled: 0, kept: 0, noted: notedBefore(state?.run).length, backup: state?.run?.backup };
  for (const eventId of created) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let current;
      try {
        current = store.read((repo) => repo.getProtocol({ eventId, accounts: 'all' }));
      } catch {
        break;
      }
      if (current.event.state === 'cancelled') break;
      if (current.accounts.some((account) => account.actor?.id !== IMPORT_ACTOR)) {
        result.kept += 1;
        break;
      }
      const first = current.accounts[0];
      try {
        await store.write((repo) => repo.recordExpression({
          eventId, actor: ACTOR, text: first.text, accountId: first.id, expectedVersion: current.event.version,
          set: { state: 'cancelled', progress: { text: `Import undone on ${today(now)}`, timestamp: now.toISOString() } },
        }));
        result.cancelled += 1;
        break;
      } catch (error) {
        if (!(error instanceof ProtocolError) || error.code !== 'VERSION_CONFLICT' || attempt === 2) break;
      }
    }
  }
  if (state?.run) writeImport(directory, { ...state, reported: true, run: { ...state.run, undoneAt: now.toISOString() } });
  return result;
}

// ------------------------------------------------------------------------------- the command

async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim().toLowerCase();
  } finally {
    prompt.close();
  }
}

/** Prints the report, as the terminal shows it. */
function printReport(say, report) {
  say(`Imported ${report.finishedAt ? `on ${report.finishedAt.slice(0, 10)}` : ''}${report.took ? ` in ${report.took}` : ''}: ${report.newMatters} new matter${report.newMatters === 1 ? '' : 's'}, words added to ${report.wordsAddedToExisting} the repository held already.`);
  if (report.tokens) say(`Tokens: ${number(report.tokens.input)} in${report.tokens.cached ? ` (${number(report.tokens.cached)} more read from cache)` : ''}, ${number(report.tokens.output)} out.`);
  if (report.leftOut) say(`Left out: ${report.leftOut}.`);
  for (const problem of report.problems ?? []) say(`Problem: ${problem}`);
  say('');
  say(report.treeNote);
  say(report.tree);
  say('');
  say(report.undo);
}

/** `protocol-chaos import …`; returns the exit code. */
export async function runImportCommand(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { yes: { type: 'boolean', short: 'y' }, only: { type: 'string' }, status: { type: 'boolean' }, undo: { type: 'boolean' }, run: { type: 'boolean' }, data: { type: 'string' } },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\nUsage: protocol-chaos import [--yes] [--only <agents>] | --status | --undo [--data <directory>]\n`);
    return 2;
  }
  const directory = resolve(values.data ?? env.PROTOCOL_CHAOS_DATA ?? join(env.HOME || homedir(), '.protocol-chaos'));
  const say = (line = '') => process.stdout.write(`${line}\n`);
  if (values.run) return runImport(directory, { env });
  const state = settle(directory, readImport(directory));

  if (values.status) {
    if (!state) say('No import yet. `npx protocol-chaos import` shows what it would read and asks.');
    else if (state.status === 'running') say(`Importing: part ${state.run.chunk} of ${state.run.of} done, ${state.run.created.length} new matters so far (${state.run.mode === 'background' ? 'in the background' : 'in a conversation'}).`);
    else if (state.status === 'done' || state.status === 'failed') {
      if (state.status === 'failed') say(`The import stopped: ${state.run?.errors?.at(-1) ?? 'unknown'}. \`npx protocol-chaos import\` resumes it.`);
      if (state.run?.finishedAt) {
        printReport(say, importReport(directory, state));
        if (!state.reported) writeImport(directory, { ...state, reported: true, reportedAt: new Date().toISOString() });
      }
    } else say(`Import: ${state.status}${state.declinedAt ? ` on ${state.declinedAt.slice(0, 10)}` : ''}.`);
    return 0;
  }

  if (values.undo) {
    if (!state?.run?.created?.length) {
      say('No matters were started by an import; nothing to undo.');
      return 0;
    }
    const result = await undoImport(directory);
    say(`Cancelled ${result.cancelled} matter${result.cancelled === 1 ? '' : 's'} the import started${result.kept ? `; kept ${result.kept} that someone has written on since` : ''}.`);
    if (result.noted) say(`The words it added to ${result.noted} matter${result.noted === 1 ? '' : 's'} the repository held already stay: words are never deleted.`);
    if (result.backup && existsSync(result.backup)) say(`The repository as it was before the import: ${result.backup}`);
    return 0;
  }

  if (state?.status === 'running') {
    say('An import is running already. `npx protocol-chaos import --status` shows how far it got.');
    return 0;
  }
  const only = values.only ? values.only.split(',').map((id) => id.trim()).filter(Boolean) : undefined;
  if (only?.some((id) => !Object.hasOwn(AGENT_NAMES, id))) {
    process.stderr.write(`--only takes ${Object.keys(AGENT_NAMES).join(', ')}; got "${values.only}".\n`);
    return 2;
  }
  const plan = planImport(env, directory, only);
  if (!plan.files.length) {
    say('No memories of other assistants were found on this machine.');
    for (const file of plan.skipped) say(`  left out: ${tilde(file.path, env.HOME || homedir())} (${file.why})`);
    return 0;
  }
  if (state?.status === 'done') say(`An import ran on ${state.run?.finishedAt?.slice(0, 10)}; words recorded then are not recorded twice.`);
  describePlan(plan, env).forEach((line) => say(line));
  say('');
  if (plan.mode === 'conversation') {
    pendImport(directory);
    const next = readImport(directory);
    writeImport(directory, { ...next, status: 'pending', offered: [] });
    say('None of the connected assistants can run in the background here, so the import runs in a conversation:');
    say('start a new session in one of them; it offers the import and asks you first.');
    return 0;
  }
  if (!values.yes) {
    if (!process.stdin.isTTY) {
      say('Run `npx protocol-chaos import --yes` to start it.');
      return 1;
    }
    if (!['', 'y', 'yes'].includes(await ask('Import them now, in the background? [Y/n] '))) {
      say('Nothing was imported.');
      return 0;
    }
  }
  startImport(directory, plan);
  say(`Importing in the background, about ${plan.estimate.minutes} minute${plan.estimate.minutes === 1 ? '' : 's'}. A notification says when it is done;`);
  say('then any assistant shows you the report. `npx protocol-chaos import --status` shows how far it got.');
  return 0;
}
