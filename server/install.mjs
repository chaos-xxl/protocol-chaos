// `protocol-chaos init | uninstall | doctor`: connect the agents on this machine to one
// repository, take that back, and check it.
//
//   protocol-chaos init [--only <agents>] [--yes] [--dry-run] [--data <directory>]
//   protocol-chaos uninstall [--only <agents>] [--dry-run] [--data <directory>]
//   protocol-chaos doctor [--data <directory>]
//
// init finds the agents installed here, asks which to connect (all of them by default),
// installs this server into <data>/runtime, writes a launcher at <data>/bin/protocol-chaos,
// and gives each agent an MCP server named protocol_chaos that runs the launcher with the
// agent's own name. The agent's model is told how to use the repository by the server's
// instructions; where an agent does not show those to its model as instructions (Codex, Kiro,
// Cursor), init also writes them where the agent keeps standing instructions. Agents read the
// directory themselves and open what they need: nothing is added to a turn before the model
// answers. Every change is recorded in <data>/installed.json, and every file edited is copied
// to <data>/backups first. uninstall undoes the changes and keeps the repository.
//
// Organizing: one connected agent is the organizer (DeepSeek Harness, then Claude Code, then
// Codex, or --organizer). After an assistant records words, the server folds them into their
// matter in the background with one headless call to that agent's model (organize.mjs), and a
// daily sweep at 04:00 folds what was missed; it calls no model when nothing was recorded.
//
// Agents: claude-code, codex, dsh (DeepSeek Harness), hermes, kiro, cursor, opencode, openclaw,
// claude-desktop, copilot (GitHub Copilot in VS Code and Copilot CLI), pi. Hermes reaches the
// server over HTTP, so for it init also runs `launcher --http 127.0.0.1:<port>` at login, issues
// it a token, writes both into Hermes's .env, adds the protocol_chaos MCP server and installs the
// plugin. The others get an MCP entry in their settings and, where their model does not see the
// server's instructions, the instructions where they keep standing ones (each agent's comment
// below says where). JSON settings files keep their comments. An agent that already has an MCP
// server named protocol_chaos is left as it is. Where each agent keeps its settings follows its
// own variables: CLAUDE_CONFIG_DIR, CODEX_HOME, DSH_HOME, HERMES_HOME, XDG_CONFIG_HOME,
// XDG_DATA_HOME, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, OPENCLAW_WORKSPACE_DIR,
// CLAUDE_USER_DATA_DIR, COPILOT_HOME, PI_CODING_AGENT_DIR.
//
// Import: the memories other assistants keep on this machine (memories.mjs) can be imported
// once. init shows what would be read and what it would cost and asks; with --yes, or without
// a terminal, the assistants offer it in their next conversation instead.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import jsonc from 'jsonc-parser';
import { Clients } from './clients.mjs';
import { IMPORT_STATIC, instructions } from './instructions.mjs';
import { declineImport, describePlan, pendImport, planImport, readImport, startImport } from './memories.mjs';
import { ORGANIZER_ACTOR, ORGANIZER_FILE } from './organize.mjs';

const { version } = createRequire(import.meta.url)('../package.json');
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_NAME = 'protocol_chaos';
// read, record and fields: read the directory and matters, record words, and change fields
// when the user asks for it now. The organizer's tools are left out (docs/agent-guide.md).
const TOOLS = 'writer';
const NOTE = 'added by `npx protocol-chaos init`; `npx protocol-chaos uninstall` removes it';
const HELP = `Usage:
  protocol-chaos init [--only <agents>] [--organizer <agent>|none] [--no-schedule] [--no-import] [--yes] [--dry-run] [--data <directory>]
  protocol-chaos uninstall [--only <agents>] [--dry-run] [--data <directory>]
  protocol-chaos doctor [--data <directory>]

Agents: claude-code, codex, dsh (DeepSeek Harness), hermes, kiro, cursor, opencode, openclaw,
claude-desktop, copilot (GitHub Copilot: VS Code and Copilot CLI), pi; comma-separated for --only.
--yes      connect every agent found, without asking; the import of other assistants' memories
           is then offered by the assistants, not started
--organizer  the agent whose model organizes in the background: dsh, claude-code, codex, or none
             (default: the first connected of dsh, claude-code, codex)
--no-schedule  no daily sweep at 04:00 (words are still organized after each note)
--no-import  do not offer to import other assistants' memories (\`protocol-chaos import\` still can)
--dry-run  show what would change and change nothing
--data     where the repository lives; default $PROTOCOL_CHAOS_DATA, then ~/.protocol-chaos
`;

class InstallError extends Error {}

/** Runs one installer command; returns the exit code. */
export async function runInstaller(command, argv, env = process.env) {
  let options;
  try {
    ({ values: options } = parseArgs({
      args: argv,
      options: {
        only: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        'dry-run': { type: 'boolean' },
        data: { type: 'string' },
        runtime: { type: 'string' },
        organizer: { type: 'string' },
        'no-schedule': { type: 'boolean' },
        'no-import': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (process.platform === 'win32') {
    process.stderr.write('init, uninstall and doctor support macOS and Linux for now. On Windows, connect each assistant by hand: see "Quick start" in the README.\n');
    return 1;
  }
  const ctx = context(options, env);
  try {
    if (command === 'init') return await init(ctx, options);
    if (command === 'uninstall') return uninstall(ctx, options);
    return await doctor(ctx);
  } catch (error) {
    if (!(error instanceof InstallError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------------- context

function context(options, env) {
  const home = env.HOME || homedir();
  const data = resolve(options.data ?? env.PROTOCOL_CHAOS_DATA ?? join(home, '.protocol-chaos'));
  return {
    env,
    home,
    data,
    stateFile: join(data, 'installed.json'),
    launcher: join(data, 'bin', 'protocol-chaos'),
    dryRun: Boolean(options['dry-run']),
    stamp: new Date().toISOString().replace(/[:.]/g, '-'),
    say: (line = '') => process.stdout.write(`${line}\n`),
  };
}

function readState(ctx) {
  if (!existsSync(ctx.stateFile)) return { agents: {} };
  try {
    const state = JSON.parse(readFileSync(ctx.stateFile, 'utf8'));
    return { ...state, agents: state.agents ?? {} };
  } catch (error) {
    throw new InstallError(`${ctx.stateFile} cannot be read (${error.message}). Nothing was changed.`);
  }
}

function writeState(ctx, state) {
  mkdirSync(ctx.data, { recursive: true, mode: 0o700 });
  writeAtomic(ctx.stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

// ------------------------------------------------------------------------------------ files

function writeAtomic(file, text, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: mode ?? 0o644 });
  renameSync(temporary, file);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const modeOf = (file) => statSync(file).mode & 0o777;

function backup(ctx, file) {
  const target = join(ctx.data, 'backups', ctx.stamp, `${basename(dirname(file))}-${basename(file)}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(file, target);
  chmodSync(target, 0o600);
  return target;
}

/** Appends a marked block to a text file, creating it when missing; returns the change. */
function addBlock(ctx, file, block, mode = 0o644) {
  const existed = existsSync(file);
  const original = existed ? readFileSync(file, 'utf8') : '';
  const separator = original === '' ? '' : original.endsWith('\n') ? '\n' : '\n\n';
  const inserted = `${separator}${block}\n`;
  const saved = existed ? backup(ctx, file) : undefined;
  writeAtomic(file, original + inserted, existed ? modeOf(file) : mode);
  return { kind: 'block', file, inserted, created: !existed, backup: saved };
}

/** Takes a block back out; reports what it did. */
function removeBlock(change) {
  if (!existsSync(change.file)) return `${change.file} is gone already`;
  const content = readFileSync(change.file, 'utf8');
  let next;
  const at = content.lastIndexOf(change.inserted);
  if (at >= 0) {
    next = content.slice(0, at) + content.slice(at + change.inserted.length);
  } else {
    // Edited since: take out the marked lines themselves.
    const marked = markedRegion(content);
    if (!marked) return `no protocol-chaos block left in ${change.file}; nothing to remove`;
    next = content.slice(0, marked.start) + content.slice(marked.end);
  }
  if (change.created && next.trim() === '') {
    rmSync(change.file);
    return `removed ${change.file} (it was created by init)`;
  }
  writeAtomic(change.file, next, modeOf(change.file));
  return `removed the protocol-chaos block from ${change.file}`;
}

/** The lines from a protocol-chaos begin marker through its end marker, with the line break before. */
function markedRegion(content) {
  const begin = content.search(/^.*protocol-chaos:begin.*$/m);
  if (begin < 0) return undefined;
  const endMatch = /^.*protocol-chaos:end.*$\n?/m.exec(content.slice(begin));
  if (!endMatch) return undefined;
  let start = begin;
  if (start > 0 && content[start - 1] === '\n') start -= 1;
  if (start > 0 && content[start - 1] === '\n' && content[start - 2] === '\n') start -= 1;
  return { start, end: begin + endMatch.index + endMatch[0].length };
}

const hasMarkedBlock = (file) => existsSync(file) && Boolean(markedRegion(readFileSync(file, 'utf8')));

/** The folders that writing this file would create, outermost first. */
function missingFolders(file) {
  const folders = [];
  for (let folder = dirname(file); !existsSync(folder) && dirname(folder) !== folder; folder = dirname(folder)) folders.unshift(folder);
  return folders;
}

/** Removes the folders a change created, innermost first, as long as they are empty. */
function removeEmptyFolders(folders = []) {
  for (const folder of [...folders].reverse()) {
    if (existsSync(folder) && !readdirSync(folder).length) rmSync(folder, { recursive: true });
  }
}

/** Writes a file that is not there yet; returns the change. */
function createFile(file, text, mode = 0o644) {
  const folders = missingFolders(file);
  writeAtomic(file, text, mode);
  return { kind: 'file', file, sha256: sha256(text), folders };
}

function removeFile(change) {
  if (!existsSync(change.file)) return `${change.file} is gone already`;
  if (sha256(readFileSync(change.file, 'utf8')) !== change.sha256) return `left ${change.file} as it is: it was edited since init wrote it`;
  rmSync(change.file);
  removeEmptyFolders(change.folders);
  return `removed ${change.file}`;
}

// JSON settings files (Kiro, Cursor, OpenCode, Claude Desktop, Copilot, Pi, VS Code) may hold
// comments and trailing commas: they are read and edited with jsonc-parser, which keeps both,
// and every other key, as they are.
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The value at a path of keys, or undefined. */
const at = (value, path) => path.reduce((node, key) => (plainObject(node) ? node[key] : undefined), value);

/** A JSON settings file: { text, value }, with {} for a file that is missing or empty. Throws when it cannot be read. */
function readSettings(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text.trim()) return { text, value: {} };
  const errors = [];
  const value = jsonc.parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !plainObject(value)) {
    const where = errors.length ? ` (${jsonc.printParseErrorCode(errors[0].error)} at character ${errors[0].offset})` : '';
    throw new InstallError(`${file} cannot be read as JSON${where}, so init leaves it alone. Add the entry from server/README.md by hand.`);
  }
  return { text, value };
}

/** A settings file's value for a look, or undefined when it cannot be read. */
function peekSettings(file) {
  try {
    return readSettings(file).value;
  } catch {
    return undefined;
  }
}

/** Throws when a key on the way to `path` holds something other than an object, which init would have to replace. */
function checkSettingsPath(file, value, path) {
  let node = value;
  for (let depth = 0; depth < path.length - 1; depth += 1) {
    node = node[path[depth]];
    if (node === undefined) return;
    if (!plainObject(node)) throw new InstallError(`${file}: "${path.slice(0, depth + 1).join('.')}" is not an object init can add to. Add the entry from server/README.md by hand.`);
  }
}

/** The text with one value set (or, for undefined, removed) at a path, with the file's own indentation. */
function setJsonValue(text, path, value) {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  const formattingOptions = {
    insertSpaces: !indent?.includes('\t'),
    tabSize: indent && !indent.includes('\t') ? indent.length : 2,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
  return jsonc.applyEdits(text, jsonc.modify(text, path, value, { formattingOptions }));
}

/**
 * Sets the protocol_chaos entry at `path` in a JSON settings file, creating the file (from
 * `initial`) when it is missing; returns the change.
 */
function addJsonEntry(ctx, file, path, entry, { initial = {}, mode = 0o600 } = {}) {
  const existed = existsSync(file);
  const { text, value } = readSettings(file);
  checkSettingsPath(file, value, path);
  const next = setJsonValue(text.trim() ? text : `${JSON.stringify(initial, null, 2)}\n`, path, entry);
  const folders = existed ? [] : missingFolders(file);
  const saved = existed ? backup(ctx, file) : undefined;
  writeAtomic(file, next, existed ? modeOf(file) : mode);
  return { kind: 'json', file, path, initial, created: !existed, backup: saved, writtenSha256: sha256(next), folders };
}

/** Whether a settings value holds nothing but what init created the file with, and empty objects. */
function emptyish(value, initial = {}) {
  return plainObject(value) && Object.entries(value).every(([key, item]) => (Object.hasOwn(initial, key) && JSON.stringify(item) === JSON.stringify(initial[key]))
    || (plainObject(item) && emptyish(item)));
}

/** Takes the entry back out: the file as it was when nobody changed it since, otherwise only the entry. */
function removeJsonEntry(change) {
  if (!existsSync(change.file)) return `${change.file} is gone already`;
  const current = readFileSync(change.file, 'utf8');
  if (sha256(current) === change.writtenSha256) {
    if (change.created) {
      rmSync(change.file);
      removeEmptyFolders(change.folders);
      return `removed ${change.file} (it was created by init)`;
    }
    if (change.backup && existsSync(change.backup)) {
      const mode = modeOf(change.file);
      const temporary = `${change.file}.${process.pid}.tmp`;
      copyFileSync(change.backup, temporary);
      chmodSync(temporary, mode);
      renameSync(temporary, change.file);
      return `put ${change.file} back as it was`;
    }
  }
  // Recorded by 0.2.5, before changes kept their path: the entry under mcpServers.
  const path = change.path ?? ['mcpServers', SERVER_NAME];
  let value;
  try {
    ({ value } = readSettings(change.file));
  } catch {
    return `${change.file} can no longer be read as JSON; remove its ${SERVER_NAME} entry by hand`;
  }
  if (at(value, path) === undefined) return `no ${SERVER_NAME} entry left in ${change.file}; nothing to remove`;
  const next = setJsonValue(current, path, undefined);
  if (change.created && emptyish(jsonc.parse(next, [], { allowTrailingComma: true }), change.initial)) {
    rmSync(change.file);
    removeEmptyFolders(change.folders);
    return `removed ${change.file} (it was created by init)`;
  }
  writeAtomic(change.file, next, modeOf(change.file));
  return `removed the ${SERVER_NAME} entry from ${change.file}`;
}

// --------------------------------------------------------------------------------- commands

/** The absolute path of a command on PATH, or undefined. */
function which(ctx, name) {
  for (const folder of String(ctx.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(folder, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

function run(ctx, argv, { timeout = 60_000 } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { env: ctx.env, encoding: 'utf8', timeout });
  if (result.error) throw new InstallError(`${argv.join(' ')} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n').slice(-5).join('\n');
    throw new InstallError(`${argv.join(' ')} failed (exit ${result.status})${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const tomlString = (value) => JSON.stringify(String(value));
const yamlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

// ----------------------------------------------------------------------------------- agents

/**
 * Whether an agent's own folder says the agent is installed. `npx skills add` makes a skills
 * folder for many agents at once, whether or not they are installed, so a folder that holds
 * nothing but that (and what `also` names) is no sign of the agent. An empty folder still is.
 */
function agentFolder(dir, also = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.length === 0 || entries.some((name) => !['skills', '.DS_Store', ...also].includes(name));
}

/** find() for an agent known by its commands and its own folder. */
function findBy(ctx, commands, folder, also) {
  for (const name of commands) {
    const command = which(ctx, name);
    if (command) return { found: true, where: command };
  }
  if (agentFolder(folder, also)) return { found: true, where: folder };
  if (existsSync(folder)) return { found: false, note: `${folder} holds only skills, which \`npx skills add\` makes for many agents` };
  return { found: false };
}

/** The arguments each agent's MCP entry passes to the launcher. */
const serverArgs = (client) => ['--client', client, '--tools', TOOLS];

/** What init writes where an agent keeps standing instructions: the server's, and the import line. */
export const standingInstructions = (client) => `${instructions(client)}\n\n${IMPORT_STATIC}`;

const claudeConfigFile = (ctx) => (ctx.env.CLAUDE_CONFIG_DIR
  ? join(resolve(ctx.env.CLAUDE_CONFIG_DIR), '.claude.json')
  : join(ctx.home, '.claude.json'));

function readJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const describeEntry = (entry) => {
  if (entry?.url) return `the server at ${entry.url}`;
  if (!entry?.command) return 'an entry';
  return `\`${(Array.isArray(entry.command) ? entry.command : [entry.command, ...(entry.args ?? [])]).join(' ')}\``;
};

const claudeCode = {
  id: 'claude-code',
  name: 'Claude Code',
  find(ctx) {
    const command = which(ctx, 'claude');
    if (command) return { found: true, where: command };
    if (existsSync(join(ctx.home, '.claude'))) return { found: false, note: 'its settings folder is here, but the claude command is not on PATH' };
    return { found: false };
  },
  existing(ctx) {
    const entry = readJson(claudeConfigFile(ctx))?.mcpServers?.[SERVER_NAME];
    return entry ? { text: describeEntry(entry), url: entry.url } : undefined;
  },
  plan(ctx) {
    const command = which(ctx, 'claude') ?? 'claude';
    const argv = [command, 'mcp', 'add', '--scope', 'user', SERVER_NAME, '--', ctx.launcher, ...serverArgs(this.id)];
    return [{
      say: `claude mcp add --scope user ${SERVER_NAME} -- ${ctx.launcher} ${serverArgs(this.id).join(' ')}`,
      apply: () => {
        run(ctx, argv);
        return { kind: 'command', label: `claude mcp add ${SERVER_NAME}`, undo: [command, 'mcp', 'remove', '--scope', 'user', SERVER_NAME] };
      },
    }];
  },
  verify(ctx) {
    const entry = readJson(claudeConfigFile(ctx))?.mcpServers?.[SERVER_NAME];
    if (!entry) return { ok: false, text: `no ${SERVER_NAME} server in ${claudeConfigFile(ctx)}` };
    return entry.command === ctx.launcher
      ? { ok: true, text: `${SERVER_NAME} runs the launcher (${claudeConfigFile(ctx)})` }
      : { ok: false, text: `${SERVER_NAME} runs ${describeEntry(entry)}, not the launcher` };
  },
};

const codexHome = (ctx) => resolve(ctx.env.CODEX_HOME || join(ctx.home, '.codex'));
// [mcp_servers.protocol_chaos], or a dotted key under it. [ \t] rather than \s, so that a
// match starts on the line itself and not at a blank line before it.
const CODEX_TABLE = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*["']?protocol_chaos["']?[ \t]*\]|^[ \t]*mcp_servers[ \t]*\.[ \t]*["']?protocol_chaos["']?[ \t]*\./m;

const codex = {
  id: 'codex',
  name: 'Codex',
  find(ctx) {
    return findBy(ctx, ['codex'], codexHome(ctx));
  },
  existing(ctx) {
    const file = join(codexHome(ctx), 'config.toml');
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8');
    const match = CODEX_TABLE.exec(text);
    if (!match) return undefined;
    const table = text.slice(match.index + match[0].length).split(/\n[ \t]*\[/)[0];
    const url = /^[ \t]*url[ \t]*=[ \t]*"([^"]*)"/m.exec(table)?.[1];
    return { text: url ? `the server at ${url}` : `an entry in ${file}`, url };
  },
  plan(ctx) {
    const home = codexHome(ctx);
    const config = join(home, 'config.toml');
    if (existsSync(config) && /^[ \t]*mcp_servers[ \t]*=/m.test(readFileSync(config, 'utf8'))) {
      throw new InstallError(`${config} writes mcp_servers as one inline table, so a [mcp_servers.${SERVER_NAME}] table cannot be added after it. Add the entry by hand (see server/README.md).`);
    }
    const table = [
      `# protocol-chaos:begin (${NOTE})`,
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(ctx.launcher)}`,
      `args = [${serverArgs(this.id).map(tomlString).join(', ')}]`,
      'startup_timeout_sec = 30',
      '# protocol-chaos:end',
    ].join('\n');
    const steps = [{
      say: `add [mcp_servers.${SERVER_NAME}] to ${config}`,
      apply: () => addBlock(ctx, config, table),
    }];
    // Codex shows a server's instructions to its model only as the description of the
    // server's tools (openai/codex#29097), so the rules also go where it keeps standing ones.
    steps.push(standingBlockStep(ctx, this.id, join(home, 'AGENTS.md')));
    return steps;
  },
  verify(ctx) {
    const config = join(codexHome(ctx), 'config.toml');
    if (!hasMarkedBlock(config)) return { ok: false, text: `no protocol-chaos block in ${config}` };
    return readFileSync(config, 'utf8').includes(tomlString(ctx.launcher))
      ? { ok: true, text: `[mcp_servers.${SERVER_NAME}] runs the launcher (${config})` }
      : { ok: false, text: `[mcp_servers.${SERVER_NAME}] in ${config} does not run the launcher` };
  },
};

const dshHome = (ctx) => resolve(ctx.env.DSH_HOME || join(ctx.home, '.dsh'));
const DSH_APP = '/Applications/DeepSeek Harness.app';
const DSH_SERVER = /serverName\s*:\s*["']?protocol_chaos["']?/;

/** The patch files DSH applies: one for every profile, one per profile. */
function dshPatchFiles(ctx) {
  const home = dshHome(ctx);
  const files = [join(home, 'cordis.patch.yml')];
  const profiles = join(home, 'profiles');
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) files.push(join(profiles, name, 'cordis.patch.yml'));
  }
  return files.filter((file) => existsSync(file));
}

/** DSH's command-line entry point, when one is installed. */
function dshCommand(ctx) {
  return which(ctx, 'dsh') ?? [join(DSH_APP, 'Contents/Resources/runtime/cli/bin/dsh'), join(ctx.home, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')].find((file) => existsSync(file));
}

const dsh = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  find(ctx) {
    const command = dshCommand(ctx);
    if (command) return { found: true, where: command };
    return findBy(ctx, [], dshHome(ctx));
  },
  existing(ctx) {
    const file = dshPatchFiles(ctx).find((candidate) => DSH_SERVER.test(readFileSync(candidate, 'utf8')));
    return file ? { text: `an entry in ${file}` } : undefined;
  },
  plan(ctx) {
    const file = join(dshHome(ctx), 'cordis.patch.yml');
    if (existsSync(file)) {
      // A patch file is a top-level YAML list; the entry is one more block-style item.
      const content = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
      if (content.length && !content[0].startsWith('- ')) {
        throw new InstallError(`${file} is not a block-style YAML list, so init cannot add an item to it. Add the entry from server/README.md by hand.`);
      }
    }
    const block = [
      `# protocol-chaos:begin (${NOTE})`,
      '- insert:',
      '    - id: protocol-chaos-mcp',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      `        serverName: ${SERVER_NAME}`,
      '        transport: stdio',
      `        command: ${yamlString(ctx.launcher)}`,
      `        args: [${serverArgs(this.id).map(yamlString).join(', ')}]`,
      '# protocol-chaos:end',
    ].join('\n');
    return [{ say: `add the ${SERVER_NAME} MCP client to ${file} (every DSH profile)`, apply: () => addBlock(ctx, file, block) }];
  },
  verify(ctx) {
    const file = join(dshHome(ctx), 'cordis.patch.yml');
    if (!hasMarkedBlock(file)) return { ok: false, text: `no protocol-chaos block in ${file}` };
    return readFileSync(file, 'utf8').includes(yamlString(ctx.launcher))
      ? { ok: true, text: `the ${SERVER_NAME} MCP client runs the launcher (${file})` }
      : { ok: false, text: `the ${SERVER_NAME} entry in ${file} does not run the launcher` };
  },
};

const hermesHome = (ctx) => resolve(ctx.env.HERMES_HOME || join(ctx.home, '.hermes'));
const HERMES_PLUGIN = 'chaos-xxl/protocol-chaos#integrations/hermes/protocol-chaos';
const HTTP_LABEL = 'io.github.chaos-xxl.protocol-chaos.http';
const HTTP_PORTS = [8721, 8722, 8723, 8724, 8725];

/** One variable of a .env file, or undefined. */
function envValue(file, key) {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match && match[1] === key) return match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

const loopback = (url) => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?\//.test(String(url));

/** Whether nothing listens on this port on 127.0.0.1. */
function portFree(port) {
  const probe = spawnSync(process.execPath, ['-e', `const s=require('node:net').createServer();s.once('error',()=>process.exit(1));s.listen(${port},'127.0.0.1',()=>s.close(()=>process.exit(0)))`], { timeout: 5000 });
  return probe.status === 0;
}

/**
 * Starts `launcher --http 127.0.0.1:<port>` at login and keeps it running: a launchd agent on
 * macOS, a systemd user service on Linux. Only for the real home folder, as with the sweep.
 */
function startHttpService(ctx, port) {
  if (resolve(ctx.home) !== resolve(userInfo().homedir)) return { skipped: 'HOME is not your home folder' };
  const args = [ctx.launcher, '--http', `127.0.0.1:${port}`];
  if (process.platform === 'darwin') {
    const plist = join(ctx.home, 'Library', 'LaunchAgents', `${HTTP_LABEL}.plist`);
    const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `  <key>Label</key><string>${HTTP_LABEL}</string>`,
      `  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>`,
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      `  <key>StandardErrorPath</key><string>${xml(join(ctx.data, 'server.log'))}</string>`,
      '</dict></plist>',
      '',
    ].join('\n');
    writeAtomic(plist, text, 0o644);
    const domain = `gui/${userInfo().uid}`;
    spawnSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' });
    run(ctx, ['launchctl', 'bootstrap', domain, plist]);
    return { kind: 'service', platform: 'launchd', files: [plist], undo: [['launchctl', 'bootout', domain, plist]] };
  }
  if (process.platform === 'linux' && which(ctx, 'systemctl')) {
    const unit = join(ctx.home, '.config', 'systemd', 'user', 'protocol-chaos-http.service');
    writeAtomic(unit, `[Unit]\nDescription=Protocol Chaos server for Hermes (written by protocol-chaos init)\n\n[Service]\nExecStart=${args.join(' ')}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`, 0o644);
    run(ctx, ['systemctl', '--user', 'daemon-reload']);
    run(ctx, ['systemctl', '--user', 'enable', '--now', 'protocol-chaos-http.service']);
    return { kind: 'service', platform: 'systemd', files: [unit], undo: [['systemctl', '--user', 'disable', '--now', 'protocol-chaos-http.service']] };
  }
  return { skipped: 'no user service manager (launchd or systemd) here' };
}

const hermes = {
  id: 'hermes',
  name: 'Hermes',
  find(ctx) {
    const command = which(ctx, 'hermes');
    if (command) return { found: true, where: command };
    if (existsSync(hermesHome(ctx))) return { found: false, note: 'its folder is here, but the hermes command is not on PATH' };
    return { found: false };
  },
  existing(ctx) {
    const url = envValue(join(hermesHome(ctx), '.env'), 'PROTOCOL_CHAOS_URL');
    if (!url) return undefined;
    return { text: `the server at ${url}`, url: loopback(url) ? undefined : url };
  },
  plan(ctx) {
    const command = which(ctx, 'hermes') ?? 'hermes';
    const env = join(hermesHome(ctx), '.env');
    const port = HTTP_PORTS.find(portFree);
    if (!port) throw new InstallError(`Ports ${HTTP_PORTS.join(', ')} on 127.0.0.1 are all in use, so the server for Hermes has nowhere to listen.`);
    const url = `http://127.0.0.1:${port}/mcp`;
    let token;
    return [
      {
        say: 'issue Hermes its own token (clients add hermes)',
        apply: () => {
          const clients = new Clients(ctx.data);
          if (clients.list().some((client) => client.name === 'hermes')) clients.remove('hermes');
          token = clients.add('hermes');
          return { kind: 'client', name: 'hermes' };
        },
      },
      {
        say: `run the server for Hermes at ${url}, started at login`,
        apply: () => {
          const service = startHttpService(ctx, port);
          if (service.kind) return service;
          ctx.say(`  Hermes: the server was not set to start at login (${service.skipped}). Start it with: ${ctx.launcher} --http 127.0.0.1:${port}`);
          return undefined;
        },
      },
      {
        say: `add PROTOCOL_CHAOS_URL and PROTOCOL_CHAOS_TOKEN to ${env}`,
        apply: () => addBlock(ctx, env, [`# protocol-chaos:begin (${NOTE})`, `PROTOCOL_CHAOS_URL=${url}`, `PROTOCOL_CHAOS_TOKEN=${token}`, '# protocol-chaos:end'].join('\n'), 0o600),
      },
      {
        // The model opens matters itself (the plugin's related setting is off), and the organizer
        // skill uses the same server: both through an MCP server named protocol_chaos.
        say: 'add the protocol_chaos MCP server to Hermes (hermes config set)',
        apply: () => {
          run(ctx, [command, 'config', 'set', 'mcp_servers.protocol_chaos.url', '${PROTOCOL_CHAOS_URL}']);
          run(ctx, [command, 'config', 'set', 'mcp_servers.protocol_chaos.headers.Authorization', 'Bearer ${PROTOCOL_CHAOS_TOKEN}']);
          return { kind: 'command', label: 'hermes config set mcp_servers.protocol_chaos', undo: [command, 'config', 'unset', 'mcp_servers.protocol_chaos'] };
        },
      },
      {
        say: `install the plugin (hermes plugins install ${HERMES_PLUGIN} --enable)`,
        apply: () => {
          // Hermes may ask its own questions about installing a plugin: they go to this terminal.
          const result = spawnSync(command, ['plugins', 'install', HERMES_PLUGIN, '--enable'], { env: ctx.env, stdio: process.stdin.isTTY ? 'inherit' : 'pipe', encoding: 'utf8', timeout: 300_000 });
          if (result.status !== 0) throw new InstallError(`hermes plugins install failed (exit ${result.status ?? result.error?.message}).${result.stderr ? ` ${String(result.stderr).trim().split('\n').slice(-3).join(' ')}` : ''}`);
          return { kind: 'command', label: 'hermes plugins install protocol-chaos', undo: [command, 'plugins', 'remove', 'protocol-chaos'] };
        },
      },
    ];
  },
  verify(ctx) {
    const env = join(hermesHome(ctx), '.env');
    if (!hasMarkedBlock(env)) return { ok: false, text: `no protocol-chaos block in ${env}` };
    return { ok: true, text: `${env} points the plugin at ${envValue(env, 'PROTOCOL_CHAOS_URL')}`, url: envValue(env, 'PROTOCOL_CHAOS_URL'), token: envValue(env, 'PROTOCOL_CHAOS_TOKEN') };
  },
};

const MCP_SERVERS = ['mcpServers', SERVER_NAME];

/** The protocol_chaos entry at `path` of an agent's JSON settings file, as `existing` reports it. */
function jsonEntry(file, path = MCP_SERVERS) {
  const entry = at(peekSettings(file), path);
  return entry ? { text: describeEntry(entry), url: entry.url } : undefined;
}

/** Whether an entry runs the launcher: its command, or the first word of a command list (OpenCode). */
const runsLauncher = (ctx, entry) => (Array.isArray(entry?.command) ? entry.command[0] : entry?.command) === ctx.launcher;

function verifyJson(ctx, file, path = MCP_SERVERS) {
  const entry = at(peekSettings(file), path);
  if (!entry) return { ok: false, text: `no ${SERVER_NAME} server in ${file}` };
  return runsLauncher(ctx, entry)
    ? { ok: true, text: `${SERVER_NAME} runs the launcher (${file})` }
    : { ok: false, text: `${SERVER_NAME} in ${file} runs ${describeEntry(entry)}, not the launcher` };
}

/**
 * The step that adds the server's instructions as a marked block to a file of standing
 * instructions, unless that file already mentions the server.
 */
function standingBlockStep(ctx, client, file) {
  if (existsSync(file) && readFileSync(file, 'utf8').includes(SERVER_NAME)) {
    return { say: `leave ${file} as it is: it already mentions ${SERVER_NAME}`, apply: () => undefined };
  }
  const block = [
    `<!-- protocol-chaos:begin (${NOTE}) -->`,
    `## Protocol Chaos (MCP server \`${SERVER_NAME}\`)`,
    '',
    standingInstructions(client),
    '<!-- protocol-chaos:end -->',
  ].join('\n');
  return { say: `add the server's instructions to ${file}`, apply: () => addBlock(ctx, file, block) };
}

/** The Markdown files in a folder that already mention protocol_chaos, if any. */
function mentioning(folder, depth = 0) {
  if (!existsSync(folder)) return undefined;
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory() && depth < 2) {
      const found = mentioning(path, depth + 1);
      if (found) return found;
    } else if (info.isFile() && name.endsWith('.md') && readFileSync(path, 'utf8').includes(SERVER_NAME)) {
      return path;
    }
  }
  return undefined;
}

const WRITTEN_BY = `<!-- Written by \`npx protocol-chaos init\`; \`npx protocol-chaos uninstall\` removes it unless you edit it. -->`;
const kiroHome = (ctx) => join(ctx.home, '.kiro');

// Kiro keeps MCP servers in ~/.kiro/settings/mcp.json (the IDE and Kiro CLI both read it) and
// does not show a server's instructions to its model, so the rules go into a global steering
// file: one without front matter is included in every conversation.
const kiro = {
  id: 'kiro',
  name: 'Kiro',
  find(ctx) {
    return findBy(ctx, ['kiro', 'kiro-cli'], kiroHome(ctx));
  },
  existing(ctx) {
    return jsonEntry(join(kiroHome(ctx), 'settings', 'mcp.json'));
  },
  plan(ctx) {
    const settings = join(kiroHome(ctx), 'settings', 'mcp.json');
    readSettings(settings);
    const steps = [{
      say: `add ${SERVER_NAME} to mcpServers in ${settings}`,
      apply: () => addJsonEntry(ctx, settings, MCP_SERVERS, { command: ctx.launcher, args: serverArgs(this.id) }),
    }];
    const steering = join(kiroHome(ctx), 'steering', 'protocol-chaos.md');
    const mentions = mentioning(dirname(steering));
    if (mentions) {
      steps.push({ say: `leave the steering files as they are: ${mentions} already mentions ${SERVER_NAME}`, apply: () => undefined });
    } else if (existsSync(steering)) {
      steps.push({ say: `leave ${steering} as it is: a file of that name is there already, so Kiro is not given the server's instructions`, apply: () => undefined });
    } else {
      const text = [WRITTEN_BY, `# Protocol Chaos (MCP server \`${SERVER_NAME}\`)`, '', standingInstructions(this.id), ''].join('\n');
      steps.push({ say: `write the server's instructions to ${steering} (a steering file Kiro includes in every conversation)`, apply: () => createFile(steering, text) });
    }
    return steps;
  },
  verify(ctx) {
    return verifyJson(ctx, join(kiroHome(ctx), 'settings', 'mcp.json'));
  },
};

const cursorHome = (ctx) => join(ctx.home, '.cursor');
const CURSOR_SKILL_DESCRIPTION = "The user's long-lived matters (trips, plans, purchases, commitments, ambitions) live in the protocol_chaos MCP server, shared by all their assistants. Use this skill whenever the user talks about their own plans or commitments, refers to something they said before, or states a plan, purchase, trip, target or arrangement: read the directory (context_pack) before answering about their matters, and after answering record their words with event_note. Also when the server offers memories_import: call it with action status in your first reply.";

// Cursor keeps MCP servers in ~/.cursor/mcp.json and does not show a server's instructions to
// its model; it has no global rules file either (User Rules live in its settings), so the rules
// go into a skill, whose description the model always sees.
const cursor = {
  id: 'cursor',
  name: 'Cursor',
  find(ctx) {
    return findBy(ctx, ['cursor', 'cursor-agent'], cursorHome(ctx));
  },
  existing(ctx) {
    return jsonEntry(join(cursorHome(ctx), 'mcp.json'));
  },
  plan(ctx) {
    const settings = join(cursorHome(ctx), 'mcp.json');
    readSettings(settings);
    const steps = [{
      say: `add ${SERVER_NAME} to mcpServers in ${settings}`,
      apply: () => addJsonEntry(ctx, settings, MCP_SERVERS, { command: ctx.launcher, args: serverArgs(this.id) }),
    }];
    const skill = join(cursorHome(ctx), 'skills', 'protocol-chaos', 'SKILL.md');
    const mentions = mentioning(join(cursorHome(ctx), 'skills'));
    if (mentions) {
      steps.push({ say: `leave the skills as they are: ${mentions} already mentions ${SERVER_NAME}`, apply: () => undefined });
    } else if (existsSync(dirname(skill))) {
      steps.push({ say: `leave ${dirname(skill)} as it is: a skill of that name is there already, so Cursor is not given the server's instructions`, apply: () => undefined });
    } else {
      const text = ['---', 'name: protocol-chaos', `description: ${JSON.stringify(CURSOR_SKILL_DESCRIPTION)}`, '---', '', WRITTEN_BY,
        `# Protocol Chaos (MCP server \`${SERVER_NAME}\`)`, '', standingInstructions(this.id), ''].join('\n');
      steps.push({ say: `write the server's instructions as the skill ${skill}`, apply: () => createFile(skill, text) });
    }
    return steps;
  },
  verify(ctx) {
    return verifyJson(ctx, join(cursorHome(ctx), 'mcp.json'));
  },
};

// ------------------------------------------------- OpenCode, OpenClaw, Claude Desktop, Copilot, Pi

/** A folder named by an XDG variable, or its default under the home folder. */
const xdg = (ctx, variable, fallback) => resolve(ctx.env[variable] || join(ctx.home, fallback));
const expandHome = (ctx, path) => (path === '~' || path.startsWith('~/') ? join(ctx.home, path.slice(1)) : path);
const holdsAny = (dir, names) => names.some((name) => existsSync(join(dir, name)));

/** The version a command prints for --version, as [major, minor, patch], or undefined. */
function versionOf(ctx, command) {
  const result = spawnSync(command, ['--version'], { env: ctx.env, encoding: 'utf8', timeout: 10_000 });
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(result.stdout ?? ''));
  return result.status === 0 && match ? match.slice(1).map(Number) : undefined;
}

const older = (version, than) => Boolean(version) && (version[0] - than[0] || version[1] - than[1] || version[2] - than[2]) < 0;

/** The real file a command on PATH is, following links (npm puts links to packages on PATH). */
function realCommand(command) {
  try {
    return realpathSync(command);
  } catch {
    return command;
  }
}

const opencodeConfigDir = (ctx) => join(xdg(ctx, 'XDG_CONFIG_HOME', '.config'), 'opencode');
const opencodeDataDir = (ctx) => join(xdg(ctx, 'XDG_DATA_HOME', join('.local', 'share')), 'opencode');
// Global settings files, the last winning: opencode.jsonc over opencode.json (1.x also reads config.json first).
const OPENCODE_FILES = ['config.json', 'opencode.json', 'opencode.jsonc'];
const OPENCODE_OWN = [...OPENCODE_FILES, 'tui.json', 'cli.json', 'service.json'];

/** The file init edits: opencode.jsonc when there is one, otherwise opencode.json. */
function opencodeSettings(ctx) {
  const jsoncFile = join(opencodeConfigDir(ctx), 'opencode.jsonc');
  return existsSync(jsoncFile) ? jsoncFile : join(opencodeConfigDir(ctx), 'opencode.json');
}

/** OpenCode 2's own shape keeps servers under mcp.servers; the 1.x shape, which 2.x also reads, under mcp. */
const opencodePath = (value) => (plainObject(at(value, ['mcp', 'servers'])) ? ['mcp', 'servers', SERVER_NAME] : ['mcp', SERVER_NAME]);

function opencodeEntry(ctx) {
  for (const name of [...OPENCODE_FILES].reverse()) {
    const file = join(opencodeConfigDir(ctx), name);
    const value = peekSettings(file);
    const entry = at(value, ['mcp', 'servers', SERVER_NAME]) ?? at(value, ['mcp', SERVER_NAME]);
    if (entry) return { file, entry };
  }
  return undefined;
}

// OpenCode shows a server's instructions to its model (1.17.10 and later, and every 2.x), so
// only the MCP entry is written. OpenCode's own settings files often hold comments.
const opencode = {
  id: 'opencode',
  name: 'OpenCode',
  restart: 'OpenCode 1.x reads its settings when it starts',
  find(ctx) {
    for (const name of ['opencode', 'opencode2']) {
      const command = which(ctx, name);
      if (command) return { found: true, where: command };
    }
    for (const place of [join(ctx.home, '.opencode', 'bin', 'opencode'), opencodeDataDir(ctx)]) {
      if (existsSync(place)) return { found: true, where: place };
    }
    const dir = opencodeConfigDir(ctx);
    if (holdsAny(dir, OPENCODE_OWN)) return { found: true, where: dir };
    if (existsSync(dir)) return { found: false, note: `${dir} holds none of OpenCode's own settings files` };
    return { found: false };
  },
  existing(ctx) {
    const found = opencodeEntry(ctx);
    return found ? { text: describeEntry(found.entry), url: found.entry.url } : undefined;
  },
  plan(ctx) {
    const file = opencodeSettings(ctx);
    const path = opencodePath(readSettings(file).value);
    const command = [ctx.launcher, ...serverArgs(this.id)];
    const entry = path.length === 3 ? { type: 'local', command, disabled: false } : { type: 'local', command, enabled: true };
    const steps = [{
      say: `add ${SERVER_NAME} to ${path.slice(0, -1).join('.')} in ${file}`,
      // 1.x adds $schema to a settings file that has none; a new file gets it from the start.
      apply: () => addJsonEntry(ctx, file, path, entry, { initial: { $schema: 'https://opencode.ai/config.json' } }),
    }];
    const installed = which(ctx, 'opencode');
    const current = installed ? versionOf(ctx, installed) : undefined;
    if (current?.[0] === 1 && older(current, [1, 17, 10])) {
      steps.push({ say: `note: OpenCode ${current.join('.')} does not show the server's instructions to its model; 1.17.10 and later do`, apply: () => undefined });
    }
    return steps;
  },
  verify(ctx) {
    const found = opencodeEntry(ctx);
    if (!found) return { ok: false, text: `no ${SERVER_NAME} server in ${opencodeSettings(ctx)}` };
    return runsLauncher(ctx, found.entry)
      ? { ok: true, text: `${SERVER_NAME} runs the launcher (${found.file})` }
      : { ok: false, text: `${SERVER_NAME} in ${found.file} runs ${describeEntry(found.entry)}, not the launcher` };
  },
};

const openclawState = (ctx) => resolve(expandHome(ctx, ctx.env.OPENCLAW_STATE_DIR || join(ctx.env.OPENCLAW_HOME || ctx.home, '.openclaw')));
const openclawConfig = (ctx) => resolve(expandHome(ctx, ctx.env.OPENCLAW_CONFIG_PATH || join(openclawState(ctx), 'openclaw.json')));

/** The default agent's workspace, whose AGENTS.md OpenClaw puts in every session's system prompt. */
export function openclawWorkspace(ctx) {
  if (ctx.env.OPENCLAW_WORKSPACE_DIR) return resolve(ctx.env.OPENCLAW_WORKSPACE_DIR);
  const configured = at(peekSettings(openclawConfig(ctx)), ['agents', 'defaults', 'workspace']);
  if (typeof configured === 'string' && configured.trim()) return resolve(expandHome(ctx, configured.trim()));
  return join(openclawState(ctx), 'workspace');
}

// OpenClaw reads MCP servers from mcp.servers in openclaw.json (JSON5, reloaded while it runs);
// its own command writes the entry, through the Gateway when one runs. Its tools sit behind
// OpenClaw's tool search, so the server's instructions are not in the system prompt up front:
// they go into the workspace's AGENTS.md, which is.
const openclaw = {
  id: 'openclaw',
  name: 'OpenClaw',
  find(ctx) {
    const command = which(ctx, 'openclaw');
    if (command) return { found: true, where: command };
    if (existsSync(openclawConfig(ctx))) return { found: false, note: 'its settings are here, but the openclaw command is not on PATH' };
    return { found: false };
  },
  existing(ctx) {
    return jsonEntry(openclawConfig(ctx), ['mcp', 'servers', SERVER_NAME]);
  },
  plan(ctx) {
    const command = which(ctx, 'openclaw') ?? 'openclaw';
    // A file init cannot read might hold an entry `openclaw mcp set` would replace unseen.
    readSettings(openclawConfig(ctx));
    const entry = JSON.stringify({ command: ctx.launcher, args: serverArgs(this.id) });
    return [
      {
        say: `openclaw mcp set ${SERVER_NAME} '${entry}'`,
        apply: () => {
          run(ctx, [command, 'mcp', 'set', SERVER_NAME, entry]);
          return { kind: 'command', label: `openclaw mcp set ${SERVER_NAME}`, undo: [command, 'mcp', 'unset', SERVER_NAME] };
        },
      },
      standingBlockStep(ctx, this.id, join(openclawWorkspace(ctx), 'AGENTS.md')),
    ];
  },
  verify(ctx) {
    return verifyJson(ctx, openclawConfig(ctx), ['mcp', 'servers', SERVER_NAME]);
  },
};

function claudeDesktopDir(ctx) {
  if (ctx.env.CLAUDE_USER_DATA_DIR) return resolve(ctx.env.CLAUDE_USER_DATA_DIR);
  return process.platform === 'darwin'
    ? join(ctx.home, 'Library', 'Application Support', 'Claude')
    : join(xdg(ctx, 'XDG_CONFIG_HOME', '.config'), 'Claude');
}
const claudeDesktopConfig = (ctx) => join(claudeDesktopDir(ctx), 'claude_desktop_config.json');

/** Whether Claude Desktop is running. Asked only for the real home folder, as with the scheduler. */
function claudeDesktopRunning(ctx) {
  if (resolve(ctx.home) !== resolve(userInfo().homedir)) return false;
  const names = process.platform === 'darwin' ? ['Claude'] : ['claude-desktop', 'Claude'];
  return names.some((name) => spawnSync('pgrep', ['-x', name], { stdio: 'ignore' }).status === 0);
}

const CLAUDE_DESKTOP_OPEN = 'Claude Desktop is open. It keeps its settings file in memory and writes all of it back when it saves a setting, which would undo the change. Quit it (Claude > Quit Claude), then run this again.';

// Claude Desktop reads mcpServers from claude_desktop_config.json when it starts. Its chat does
// not show a server's instructions to the model and has no local file of standing instructions,
// so the server is started with --instructions-in-tools: the instructions open the description
// of its context_pack tool, which the model does see.
const claudeDesktop = {
  id: 'claude-desktop',
  name: 'Claude Desktop',
  restart: 'quit it completely and open it again',
  find(ctx) {
    const dir = claudeDesktopDir(ctx);
    return existsSync(dir) ? { found: true, where: dir } : { found: false };
  },
  existing(ctx) {
    return jsonEntry(claudeDesktopConfig(ctx));
  },
  plan(ctx) {
    const file = claudeDesktopConfig(ctx);
    readSettings(file);
    return [{
      say: `add ${SERVER_NAME} to mcpServers in ${file}, with the server's instructions in the description of context_pack (--instructions-in-tools)`,
      apply: () => {
        if (claudeDesktopRunning(ctx)) throw new InstallError(CLAUDE_DESKTOP_OPEN);
        return addJsonEntry(ctx, file, MCP_SERVERS, { command: ctx.launcher, args: [...serverArgs(this.id), '--instructions-in-tools'] });
      },
    }];
  },
  /** Why the change cannot be taken back now, if it cannot. */
  blocked(ctx) {
    return claudeDesktopRunning(ctx) ? CLAUDE_DESKTOP_OPEN : undefined;
  },
  verify(ctx) {
    return verifyJson(ctx, claudeDesktopConfig(ctx));
  },
};

const copilotHome = (ctx) => resolve(expandHome(ctx, ctx.env.COPILOT_HOME || join(ctx.home, '.copilot')));
// Files Copilot itself writes in its folder; skills/ and ide/ are made by other tools.
const COPILOT_OWN = ['config.json', 'settings.json', 'logs', 'session-state', 'command-history-state', 'session-store.db', 'permissions-config.json', 'mcp-config.json', 'copilot-instructions.md'];

/** VS Code's user folders, stable and Insiders, that are here. */
function vscodeUserDirs(ctx) {
  const base = process.platform === 'darwin' ? join(ctx.home, 'Library', 'Application Support') : xdg(ctx, 'XDG_CONFIG_HOME', '.config');
  return ['Code', 'Code - Insiders'].map((name) => join(base, name, 'User')).filter((dir) => existsSync(dir));
}

/** Copilot CLI's command, not the shim VS Code puts on the PATH of its terminals. */
function copilotCommand(ctx) {
  const command = which(ctx, 'copilot');
  return command && !/copilot-shim|copilotCli/.test(realCommand(command)) ? command : undefined;
}

// GitHub Copilot: Copilot CLI, and VS Code's Copilot agent from 1.143 on, read MCP servers from
// ~/.copilot/mcp-config.json and standing instructions from ~/.copilot/copilot-instructions.md,
// and show only allowlisted servers' instructions to the model. VS Code's local chat (older
// versions, or chosen) reads servers from the user mcp.json and does show the instructions.
const copilot = {
  id: 'copilot',
  name: 'GitHub Copilot',
  restart: 'VS Code and Copilot CLI start MCP servers with a new session',
  find(ctx) {
    const command = copilotCommand(ctx);
    if (command) return { found: true, where: command };
    if (holdsAny(copilotHome(ctx), COPILOT_OWN)) return { found: true, where: copilotHome(ctx) };
    const [vscode] = vscodeUserDirs(ctx);
    if (vscode) return { found: true, where: vscode };
    if (existsSync(copilotHome(ctx))) return { found: false, note: `${copilotHome(ctx)} holds none of Copilot's own files` };
    return { found: false };
  },
  existing(ctx) {
    return jsonEntry(join(copilotHome(ctx), 'mcp-config.json'))
      ?? vscodeUserDirs(ctx).map((dir) => jsonEntry(join(dir, 'mcp.json'), ['servers', SERVER_NAME])).find(Boolean);
  },
  plan(ctx) {
    const config = join(copilotHome(ctx), 'mcp-config.json');
    readSettings(config);
    const steps = [
      {
        say: `add ${SERVER_NAME} to mcpServers in ${config} (Copilot CLI, and VS Code's Copilot agent)`,
        apply: () => addJsonEntry(ctx, config, MCP_SERVERS, { type: 'local', command: ctx.launcher, args: serverArgs(this.id), tools: ['*'] }),
      },
      standingBlockStep(ctx, this.id, join(copilotHome(ctx), 'copilot-instructions.md')),
    ];
    for (const dir of vscodeUserDirs(ctx)) {
      const file = join(dir, 'mcp.json');
      readSettings(file);
      steps.push({
        say: `add ${SERVER_NAME} to servers in ${file} (VS Code's local chat)`,
        apply: () => addJsonEntry(ctx, file, ['servers', SERVER_NAME], { type: 'stdio', command: ctx.launcher, args: serverArgs(this.id) }),
      });
    }
    return steps;
  },
  verify(ctx) {
    return verifyJson(ctx, join(copilotHome(ctx), 'mcp-config.json'));
  },
};

const piHome = (ctx) => resolve(expandHome(ctx, ctx.env.PI_CODING_AGENT_DIR || join(ctx.home, '.pi', 'agent')));
// Files Pi itself writes in its folder; skills/ and extensions/ are also made by other tools.
const PI_OWN = ['auth.json', 'settings.json', 'sessions', 'models-store.json', 'trust.json', 'mcp.json'];
// Pi reads the first of these in its folder in every session.
export const PI_CONTEXT = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

/** Pi's command: a `pi` on PATH that is Pi's package (another program may be called pi). */
function piCommand(ctx) {
  const command = which(ctx, 'pi');
  return command && /pi-coding-agent/.test(realCommand(command)) ? command : undefined;
}

// Pi (0.99 and later) reads MCP servers from ~/.pi/agent/mcp.json; "exposure": "direct" declares
// the tools to the model like its own. It does not show a server's instructions to the model,
// so they go into the context file Pi reads in every session.
const pi = {
  id: 'pi',
  name: 'Pi',
  restart: 'a running session loads MCP servers again with /reload',
  find(ctx) {
    const command = piCommand(ctx);
    if (command) return { found: true, where: command };
    if (holdsAny(piHome(ctx), PI_OWN)) return { found: true, where: piHome(ctx) };
    if (existsSync(piHome(ctx))) return { found: false, note: `${piHome(ctx)} holds none of Pi's own files` };
    return { found: false };
  },
  existing(ctx) {
    const config = join(piHome(ctx), 'mcp.json');
    // Pi treats protocol-chaos and protocol_chaos as one name.
    return jsonEntry(config) ?? jsonEntry(config, ['mcpServers', 'protocol-chaos']);
  },
  plan(ctx) {
    const command = piCommand(ctx);
    const current = command ? versionOf(ctx, command) : undefined;
    if (older(current, [0, 99, 0])) throw new InstallError(`Pi ${current.join('.')} has no MCP support; Pi 0.99 and later have. Update Pi, then run this again.`);
    const config = join(piHome(ctx), 'mcp.json');
    readSettings(config);
    const context = PI_CONTEXT.map((name) => join(piHome(ctx), name)).find((file) => existsSync(file)) ?? join(piHome(ctx), 'AGENTS.md');
    return [
      {
        say: `add ${SERVER_NAME} to mcpServers in ${config}, its tools declared to the model (exposure: direct)`,
        apply: () => addJsonEntry(ctx, config, MCP_SERVERS, { command: ctx.launcher, args: serverArgs(this.id), exposure: 'direct' }),
      },
      standingBlockStep(ctx, this.id, context),
    ];
  },
  verify(ctx) {
    return verifyJson(ctx, join(piHome(ctx), 'mcp.json'));
  },
};

export const AGENTS = [claudeCode, codex, dsh, hermes, kiro, cursor, opencode, openclaw, claudeDesktop, copilot, pi];

// ---------------------------------------------------------------------- runtime and launcher

/** Where the server to run is: --runtime, or a copy installed into <data>/runtime. */
function runtimePlan(ctx, options) {
  const given = options.runtime ?? ctx.env.PROTOCOL_CHAOS_RUNTIME;
  if (given) {
    const entry = join(resolve(given), 'server', 'index.mjs');
    if (!existsSync(entry)) throw new InstallError(`--runtime ${given}: there is no server/index.mjs there.`);
    return { entry, dir: undefined, install: undefined };
  }
  const dir = join(ctx.data, 'runtime', version);
  const entry = join(dir, 'node_modules', 'protocol-chaos', 'server', 'index.mjs');
  if (existsSync(entry)) return { entry, dir, install: undefined };
  return { entry, dir, install: () => copyRuntime(dir, entry) };
}

/**
 * Copies this package and the dependencies it runs with into <dir>/node_modules: the same
 * files npx just fetched, so nothing is downloaded again and the versions are the ones init
 * was tested with. Run from a clone, the clone's server files go with its dependencies.
 */
function copyRuntime(dir, entry) {
  const resolved = createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/server/index.js');
  const marker = `${sep}node_modules${sep}@modelcontextprotocol${sep}`;
  const tree = resolved.slice(0, resolved.lastIndexOf(marker) + `${sep}node_modules`.length);
  const target = join(dir, 'node_modules');
  const partial = `${dir}.${process.pid}.tmp`;
  rmSync(partial, { recursive: true, force: true });
  cpSync(tree, join(partial, 'node_modules'), { recursive: true, filter: (source) => basename(source) !== '.bin' });
  const own = join(partial, 'node_modules', 'protocol-chaos');
  if (!existsSync(join(own, 'server', 'index.mjs'))) {
    mkdirSync(join(own, 'server'), { recursive: true });
    for (const file of readdirSync(join(PACKAGE_ROOT, 'server')).filter((name) => name.endsWith('.mjs'))) {
      copyFileSync(join(PACKAGE_ROOT, 'server', file), join(own, 'server', file));
    }
    copyFileSync(join(PACKAGE_ROOT, 'package.json'), join(own, 'package.json'));
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  renameSync(partial, dir);
  if (!existsSync(entry) || !existsSync(join(target, '@modelcontextprotocol', 'sdk'))) throw new InstallError(`The server could not be copied into ${dir}.`);
}

function launcherText(ctx, entry) {
  return [
    '#!/bin/sh',
    '# Starts the Protocol Chaos server for one agent on this machine.',
    `# Written by \`protocol-chaos init\` ${version}; \`npx protocol-chaos uninstall\` removes it.`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(entry)} --data ${shellQuote(ctx.data)} "$@"`,
    '',
  ].join('\n');
}

/** Puts the runtime and the launcher in place; returns the state's runtime record. */
/**
 * Whether the launcher must be written again: another version or Node.js runs init now, or the
 * Node.js, the server or the launcher it wrote is gone or changed (Node.js upgraded, say).
 */
function runtimeStale(ctx, state, options) {
  const runtime = state.runtime;
  if (!runtime || runtime.version !== version || runtime.node !== process.execPath) return true;
  if (runtime.entry !== runtimePlan(ctx, options).entry || !existsSync(runtime.entry) || !existsSync(runtime.node)) return true;
  return !existsSync(ctx.launcher) || sha256(readFileSync(ctx.launcher, 'utf8')) !== runtime.launcherSha256;
}

function ensureLauncher(ctx, state, runtime) {
  if (runtime.install) runtime.install();
  const text = launcherText(ctx, runtime.entry);
  if (!existsSync(ctx.launcher) || readFileSync(ctx.launcher, 'utf8') !== text) {
    writeAtomic(ctx.launcher, text, 0o755);
  }
  // A runtime of an earlier version that this launcher no longer runs is removed.
  const previous = state.runtime?.dir;
  if (previous && previous !== runtime.dir && existsSync(previous) && previous.startsWith(join(ctx.data, 'runtime'))) {
    rmSync(previous, { recursive: true, force: true });
  }
  return { entry: runtime.entry, dir: runtime.dir, node: process.execPath, launcherSha256: sha256(text), version };
}

// -------------------------------------------------------------------------------- organizer

const ORGANIZER_ORDER = ['dsh', 'claude-code', 'codex'];
const ORGANIZER_RUN = { dsh: 'dsh --profile headless', 'claude-code': 'claude -p', codex: 'codex exec' };
const SWEEP_LABEL = 'io.github.chaos-xxl.protocol-chaos.sweep';

function organizerCommand(ctx, id) {
  if (id === 'dsh') return dshCommand(ctx);
  if (id === 'claude-code') return which(ctx, 'claude');
  if (id === 'codex') return which(ctx, 'codex');
  return undefined;
}

/** Schedules the daily sweep where the platform has a user scheduler; returns the change, or undefined. */
function scheduleSweep(ctx) {
  // Only for the real home folder: a scheduler is per user, not per HOME variable.
  if (resolve(ctx.home) !== resolve(userInfo().homedir)) return { skipped: 'HOME is not your home folder' };
  if (process.platform === 'darwin') {
    const plist = join(ctx.home, 'Library', 'LaunchAgents', `${SWEEP_LABEL}.plist`);
    const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `  <key>Label</key><string>${SWEEP_LABEL}</string>`,
      `  <key>ProgramArguments</key><array><string>${xml(ctx.launcher)}</string><string>organize</string><string>--sweep</string></array>`,
      '  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>',
      `  <key>StandardErrorPath</key><string>${xml(join(ctx.data, 'organizer', 'sweep.err'))}</string>`,
      '</dict></plist>',
      '',
    ].join('\n');
    writeAtomic(plist, text, 0o644);
    const domain = `gui/${userInfo().uid}`;
    spawnSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' });
    run(ctx, ['launchctl', 'bootstrap', domain, plist]);
    return { kind: 'schedule', platform: 'launchd', files: [plist], sha256: sha256(text), undo: [['launchctl', 'bootout', domain, plist]] };
  }
  if (process.platform === 'linux' && which(ctx, 'systemctl')) {
    const folder = join(ctx.home, '.config', 'systemd', 'user');
    const service = join(folder, 'protocol-chaos-sweep.service');
    const timer = join(folder, 'protocol-chaos-sweep.timer');
    writeAtomic(service, `[Unit]\nDescription=Protocol Chaos: fold the words nobody folded (written by protocol-chaos init)\n\n[Service]\nType=oneshot\nExecStart=${ctx.launcher} organize --sweep\n`, 0o644);
    writeAtomic(timer, '[Unit]\nDescription=Protocol Chaos daily sweep\n\n[Timer]\nOnCalendar=*-*-* 04:00:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n', 0o644);
    run(ctx, ['systemctl', '--user', 'daemon-reload']);
    run(ctx, ['systemctl', '--user', 'enable', '--now', 'protocol-chaos-sweep.timer']);
    return { kind: 'schedule', platform: 'systemd', files: [service, timer], undo: [['systemctl', '--user', 'disable', '--now', 'protocol-chaos-sweep.timer']] };
  }
  return { skipped: 'no user scheduler (launchd or systemd) here' };
}

function unschedule(ctx, change) {
  for (const argv of change.undo ?? []) spawnSync(argv[0], argv.slice(1), { stdio: 'ignore' });
  for (const file of change.files ?? []) rmSync(file, { force: true });
  if (change.platform === 'systemd') spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
}

function removeOrganizer(ctx, state) {
  const record = state.organizer;
  if (!record) return;
  if (record.schedule) unschedule(ctx, record.schedule);
  const file = join(ctx.data, ORGANIZER_FILE);
  if (existsSync(file) && sha256(readFileSync(file, 'utf8')) === record.sha256) rmSync(file);
  delete state.organizer;
}

/**
 * Picks the organizer among the connected agents and writes organizer.json; schedules the
 * daily sweep. Keeps the one already chosen unless --organizer names another.
 */
async function setupOrganizer(ctx, state, options) {
  const connected = Object.keys(state.agents);
  const asked = options.organizer;
  if (asked === 'none') {
    if (state.organizer) removeOrganizer(ctx, state);
    state.organizer = { declined: true };
    ctx.say('Organizing in the background: off.');
    return;
  }
  const current = state.organizer;
  if (!asked && current?.agent && connected.includes(current.agent) && existsSync(join(ctx.data, ORGANIZER_FILE))) return;
  if (!asked && current?.declined) return;
  const choices = ORGANIZER_ORDER.filter((id) => connected.includes(id) && organizerCommand(ctx, id));
  if (asked && !choices.includes(asked)) {
    throw new InstallError(`--organizer ${asked}: it is not connected here, or its command is not found. Choices: ${choices.join(', ') || 'none'}.`);
  }
  const pick = asked ?? choices[0];
  if (!pick) {
    const others = connected.filter((id) => id !== 'hermes').length;
    if (connected.includes('hermes')) ctx.say(`Organizing: Hermes folds the words it records itself (its plugin)${others ? '; none of the other agents can run headless here, so each of them brings a matter\'s fields up to date itself after recording words (the server reminds it)' : ''}.`);
    else if (connected.length) ctx.say('Organizing in the background: none of the connected agents can run headless here, so each assistant brings a matter\'s fields up to date itself after recording words (the server reminds it).');
    return;
  }
  const name = AGENTS.find((agent) => agent.id === pick).name;
  ctx.say(`Organizing in the background: ${name} (${ORGANIZER_RUN[pick]}). After an assistant records your words, one call to its model folds them`);
  ctx.say('into their matter: it is sent that matter and its recent words. A daily sweep at 04:00 folds what was missed, calling no model when nothing was recorded.');
  if (!asked && !options.yes && process.stdin.isTTY && !['', 'y', 'yes'].includes(await ask('Organize with it? [Y/n] '))) {
    state.organizer = { declined: true };
    ctx.say('Organizing in the background: off. `npx protocol-chaos init --organizer <agent>` turns it on.');
    return;
  }
  if (current?.agent) removeOrganizer(ctx, state);
  const config = { agent: pick, command: organizerCommand(ctx, pick), actor: ORGANIZER_ACTOR, enabled: true };
  // Hermes's plugin folds the words it records itself; the daily sweep catches any it missed.
  if (connected.includes('hermes')) config.selfOrganizing = ['hermes'];
  if (pick === 'claude-code') Object.assign(config, { model: 'haiku', budgetUsd: 0.2 });
  if (pick === 'dsh') Object.assign(config, { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' });
  const text = `${JSON.stringify(config, null, 2)}\n`;
  writeAtomic(join(ctx.data, ORGANIZER_FILE), text, 0o600);
  // Words recorded before now are not organized: the sweep starts from here.
  const organizerState = join(ctx.data, 'organizer', 'state.json');
  if (!existsSync(organizerState)) writeAtomic(organizerState, `${JSON.stringify({ sweepCheckpoint: new Date().toISOString(), done: {} }, null, 2)}\n`, 0o600);
  const record = { agent: pick, sha256: sha256(text), at: new Date().toISOString() };
  if (!options['no-schedule']) {
    const schedule = scheduleSweep(ctx);
    if (schedule.kind) record.schedule = schedule;
    else ctx.say(`The daily sweep was not scheduled: ${schedule.skipped}. \`npx protocol-chaos organize --sweep\` runs it by hand.`);
  }
  state.organizer = record;
}

// ----------------------------------------------------------------------------------- import

/**
 * Offers to import the memories other assistants keep here, once: in a terminal init asks;
 * otherwise (--yes, no terminal, or no agent that can run in the background) the next
 * assistant the user talks to offers it, and asks.
 */
async function offerImport(ctx, state, options) {
  if (!Object.keys(state.agents).length || options['no-import'] || readImport(ctx.data)) return;
  const plan = planImport(ctx.env, ctx.data);
  if (!plan.files.length) return;
  describePlan(plan, ctx.env).forEach((line) => ctx.say(line));
  if (plan.mode === 'conversation') {
    pendImport(ctx.data);
    ctx.say('None of the connected agents can run in the background here, so the import runs in a conversation:');
    ctx.say('the next assistant you talk to offers it, and asks you first.');
  } else if (options.yes || !process.stdin.isTTY) {
    pendImport(ctx.data);
    ctx.say('Not started: the next assistant you talk to offers it, and asks you first. `npx protocol-chaos import` starts it here.');
  } else if (['', 'y', 'yes'].includes(await ask('Import them now, in the background? [Y/n] '))) {
    startImport(ctx.data, plan, { entry: state.runtime.entry });
    ctx.say(`Importing in the background, about ${plan.estimate.minutes} minute${plan.estimate.minutes === 1 ? '' : 's'}. A notification says when it is done; then any assistant shows you the report.`);
  } else {
    declineImport(ctx.data, 'declined in init');
    ctx.say('Not imported, and not offered again. `npx protocol-chaos import` imports later.');
  }
  ctx.say('');
}

// ------------------------------------------------------------------------------------- init

async function init(ctx, options) {
  const state = readState(ctx);
  const wanted = options.only ? parseOnly(options.only) : undefined;
  if (options['no-import'] && !ctx.dryRun && ['pending', 'failed'].includes(readImport(ctx.data)?.status)) declineImport(ctx.data, 'init --no-import');
  ctx.say(`Protocol Chaos ${version}: one repository for the agents on this machine, at ${ctx.data}`);
  ctx.say('');
  const rows = [];
  for (const agent of AGENTS) {
    if (wanted && !wanted.includes(agent.id)) continue;
    const found = agent.find(ctx);
    const ours = state.agents[agent.id];
    const existing = found.found || ours ? agent.existing(ctx) : undefined;
    rows.push({ agent, found, ours, existing });
  }
  for (const { agent, found, ours, existing } of rows) {
    const status = ours ? `connected by init (${ours.at.slice(0, 10)})`
      : existing ? `already connected to ${existing.text}; left as it is`
        : found.found ? 'found'
          : `not found${found.note ? `: ${found.note}` : ''}`;
    ctx.say(`  ${agent.name.padEnd(18)} ${status}`);
  }
  ctx.say('');
  const candidates = rows.filter((row) => row.found.found && !row.ours && !row.existing).map((row) => row.agent);
  const refresh = rows.some((row) => row.ours) && runtimeStale(ctx, state, options);
  // An organizer is still to be chosen: one of the connected agents can organize, and none was chosen or declined.
  const canOrganize = ORGANIZER_ORDER.some((id) => state.agents[id] && organizerCommand(ctx, id));
  const organizerWanted = Object.keys(state.agents).length > 0
    && (options.organizer !== undefined || (canOrganize && !state.organizer?.agent && !state.organizer?.declined));
  if (!candidates.length && !refresh && !organizerWanted) {
    ctx.say(rows.some((row) => row.ours) ? 'Nothing to do. `npx protocol-chaos doctor` checks the connections.' : 'No agent to connect.');
    return 0;
  }
  const remote = rows.find((row) => row.existing?.url);
  const chosen = candidates.length ? await choose(ctx, candidates, options) : [];
  if (candidates.length && !chosen.length && !refresh && !organizerWanted) {
    ctx.say('Nothing was changed.');
    return 0;
  }
  if (chosen.length && remote && !(await confirmSeparate(ctx, remote, options))) {
    ctx.say('Nothing was changed.');
    return 0;
  }
  const runtime = runtimePlan(ctx, options);
  // An agent whose settings init cannot add to is left out, with the reason; the others go on.
  let failed = 0;
  const plans = [];
  for (const agent of chosen) {
    try {
      plans.push({ agent, steps: agent.plan(ctx) });
    } catch (error) {
      if (!(error instanceof InstallError)) throw error;
      failed += 1;
      ctx.say(`  ${agent.name}: not connected. ${error.message}`);
    }
  }
  if (!plans.length && !refresh && !organizerWanted) {
    ctx.say('Nothing was changed.');
    return failed ? 1 : 0;
  }
  if (ctx.dryRun) {
    ctx.say('Would do, with --dry-run doing nothing:');
    if (runtime.install) ctx.say(`  copy the server (protocol-chaos ${version}) into ${runtime.dir}`);
    ctx.say(`  write the launcher ${ctx.launcher}`);
    for (const { agent, steps } of plans) for (const step of steps) ctx.say(`  ${agent.name}: ${step.say}`);
    const connectedIds = [...Object.keys(state.agents), ...chosen.map((agent) => agent.id)];
    const organizer = options.organizer ?? ORGANIZER_ORDER.find((id) => connectedIds.includes(id) && organizerCommand(ctx, id));
    if (organizer && organizer !== 'none') ctx.say(`  organize in the background with ${organizer}, and schedule a daily sweep at 04:00${options['no-schedule'] ? ' (not with --no-schedule)' : ''}`);
    if (!options['no-import'] && !readImport(ctx.data)) {
      const found = planImport(ctx.env, ctx.data).files;
      if (found.length) ctx.say(`  offer to import the memories of other assistants found here (${found.length} file${found.length === 1 ? '' : 's'}), showing what it reads and costs first`);
    }
    return 0;
  }
  mkdirSync(ctx.data, { recursive: true, mode: 0o700 });
  state.installer = `protocol-chaos ${version}`;
  state.launcher = ctx.launcher;
  const stale = Object.keys(state.agents).length > 0 && runtimeStale(ctx, state, options);
  state.runtime = ensureLauncher(ctx, state, runtime);
  if (stale) ctx.say(`  launcher: runs protocol-chaos ${version} with ${process.execPath}`);
  writeState(ctx, state);
  for (const { agent, steps } of plans) {
    const changes = [];
    try {
      for (const step of steps) {
        const change = step.apply();
        if (change) changes.push(change);
        ctx.say(`  ${agent.name}: ${step.say}`);
      }
      state.agents[agent.id] = { name: agent.name, at: new Date().toISOString(), changes };
    } catch (error) {
      failed += 1;
      // Take back what this agent's earlier steps changed, so no agent is left half connected.
      for (const change of changes.reverse()) undo(ctx, change);
      ctx.say(`  ${agent.name}: not connected. ${error.message}`);
      if (!(error instanceof InstallError)) throw error;
    }
    writeState(ctx, state);
  }
  ctx.say('');
  if (Object.keys(state.agents).length) {
    try {
      await setupOrganizer(ctx, state, options);
    } catch (error) {
      if (!(error instanceof InstallError)) throw error;
      failed += 1;
      ctx.say(error.message);
    }
    writeState(ctx, state);
    ctx.say('');
    await offerImport(ctx, state, options);
  }
  const connected = Object.values(state.agents).map((agent) => agent.name);
  if (connected.length) {
    ctx.say(`Connected: ${connected.join(', ')}. The repository: ${join(ctx.data, 'repository.json')}.`);
    const restarts = plans.filter(({ agent }) => agent.restart && state.agents[agent.id]).map(({ agent }) => `${agent.name}: ${agent.restart}`);
    if (restarts.length) ctx.say(`If they are open, start them again so they load the server. ${restarts.join('. ')}.`);
    ctx.say(connected.length > 1
      ? 'Start a new session in one of them and tell it about a plan; then ask another one where that plan stands.'
      : 'Start a new session and tell it about a plan; in a later session, ask where that plan stands.');
    ctx.say('Check: npx protocol-chaos doctor    Undo: npx protocol-chaos uninstall');
  }
  return failed ? 1 : 0;
}

function parseOnly(list) {
  const ids = String(list).split(',').map((part) => part.trim()).filter(Boolean);
  const known = AGENTS.map((agent) => agent.id);
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length || !ids.length) throw new InstallError(`--only takes ${known.join(', ')}; got "${list}".`);
  return ids;
}

async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim().toLowerCase();
  } finally {
    prompt.close();
  }
}

async function choose(ctx, candidates, options) {
  if (options.yes || options.only || ctx.dryRun) return candidates;
  if (!process.stdin.isTTY) throw new InstallError('No terminal to ask in. Run `npx protocol-chaos init --yes` to connect every agent found, or --only to pick.');
  candidates.forEach((agent, index) => ctx.say(`  ${index + 1}. ${agent.name}`));
  const answer = await ask(`Connect which? Numbers separated by commas, or Enter for all: `);
  if (answer === '' || answer === 'all' || answer === 'y' || answer === 'yes') return candidates;
  if (answer === 'n' || answer === 'no' || answer === 'none') return [];
  const picked = answer.split(/[\s,]+/).map(Number);
  if (picked.some((number) => !Number.isInteger(number) || number < 1 || number > candidates.length)) throw new InstallError(`"${answer}" is not a list of the numbers above. Nothing was changed.`);
  return [...new Set(picked)].map((number) => candidates[number - 1]);
}

/** An agent here already uses a server elsewhere: the ones connected now would have another repository. */
async function confirmSeparate(ctx, remote, options) {
  ctx.say(`${remote.agent.name} already uses ${remote.existing.text}.`);
  ctx.say(`The agents connected now would use a separate repository at ${ctx.data}, not that one.`);
  ctx.say('To share that server instead, connect them to it as in server/README.md (Remote).');
  if (ctx.dryRun) return true;
  if (options.yes) throw new InstallError('Not connecting them with --yes, since they would not share it. Run without --yes to choose.');
  if (!process.stdin.isTTY) return false;
  return ['y', 'yes'].includes(await ask('Connect them to a separate repository anyway? [y/N] '));
}

// -------------------------------------------------------------------------------- uninstall

function undo(ctx, change) {
  if (change.kind === 'block') return removeBlock(change);
  if (change.kind === 'json') return removeJsonEntry(change);
  if (change.kind === 'file') return removeFile(change);
  if (change.kind === 'command') {
    try {
      run(ctx, change.undo);
      return `ran ${change.undo.map((part) => basename(part) === part ? part : basename(part)).join(' ')}`;
    } catch (error) {
      return `could not undo ${change.label}: ${error.message}`;
    }
  }
  if (change.kind === 'client') {
    return new Clients(ctx.data).remove(change.name) ? `revoked the token of the client "${change.name}"` : `the client "${change.name}" is gone already`;
  }
  if (change.kind === 'service' || change.kind === 'schedule') {
    unschedule(ctx, change);
    return `stopped and removed ${change.files.map((file) => basename(file)).join(', ')}`;
  }
  return `unknown change ${change.kind}; left as it is`;
}

function uninstall(ctx, options) {
  const state = readState(ctx);
  const ids = options.only ? parseOnly(options.only) : Object.keys(state.agents);
  const present = ids.filter((id) => state.agents[id]);
  if (!present.length) {
    ctx.say(Object.keys(state.agents).length ? 'None of those agents were connected by init.' : `Nothing to undo: no agent was connected by init with the repository at ${ctx.data}.`);
    return 0;
  }
  let held = 0;
  for (const id of present) {
    const agent = state.agents[id];
    const blocked = AGENTS.find((candidate) => candidate.id === id)?.blocked?.(ctx);
    if (blocked && !ctx.dryRun) {
      held += 1;
      ctx.say(`  ${agent.name}: left connected for now. ${blocked}`);
      continue;
    }
    for (const change of [...agent.changes].reverse()) {
      const what = { block: `the block in ${change.file}`, json: `the ${SERVER_NAME} entry in ${change.file}`, file: `the file ${change.file}` }[change.kind] ?? change.label;
      ctx.say(`  ${agent.name}: ${ctx.dryRun ? `would undo ${what}` : undo(ctx, change)}`);
    }
    if (!ctx.dryRun) delete state.agents[id];
  }
  if (ctx.dryRun) return 0;
  if (state.organizer?.agent && !state.agents[state.organizer.agent]) {
    removeOrganizer(ctx, state);
    ctx.say(Object.keys(state.agents).length
      ? 'Organizing in the background: off, since its agent was disconnected. `npx protocol-chaos init --organizer <agent>` picks another.'
      : '  organizing in the background: off');
  }
  if (!Object.keys(state.agents).length) {
    if (state.organizer) removeOrganizer(ctx, state);
    rmSync(join(ctx.data, 'organizer'), { recursive: true, force: true });
    if (existsSync(ctx.launcher) && state.runtime?.launcherSha256 === sha256(readFileSync(ctx.launcher, 'utf8'))) rmSync(ctx.launcher);
    if (existsSync(dirname(ctx.launcher)) && !readdirSync(dirname(ctx.launcher)).length) rmSync(dirname(ctx.launcher), { recursive: true });
    if (state.runtime?.dir && existsSync(state.runtime.dir)) rmSync(state.runtime.dir, { recursive: true, force: true });
    const runtimes = join(ctx.data, 'runtime');
    if (existsSync(runtimes) && !readdirSync(runtimes).length) rmSync(runtimes, { recursive: true });
    rmSync(ctx.stateFile, { force: true });
    ctx.say(`No agent is connected now. The repository is kept at ${ctx.data}; delete that folder to remove it too.`);
  } else {
    writeState(ctx, state);
  }
  return held ? 1 : 0;
}

// ----------------------------------------------------------------------------------- doctor

async function doctor(ctx) {
  const state = readState(ctx);
  const ids = Object.keys(state.agents);
  if (!ids.length) {
    ctx.say(`No agent was connected by init with the repository at ${ctx.data}. Run \`npx protocol-chaos init\`.`);
    return 1;
  }
  let problems = 0;
  const report = (ok, text) => {
    if (!ok) problems += 1;
    ctx.say(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  };
  report(existsSync(state.runtime?.node ?? ''), `node ${state.runtime?.node}`);
  report(existsSync(state.runtime?.entry ?? ''), `server ${state.runtime?.entry}`);
  const launcherOk = existsSync(ctx.launcher) && sha256(readFileSync(ctx.launcher, 'utf8')) === state.runtime?.launcherSha256;
  report(launcherOk, `launcher ${ctx.launcher}${launcherOk || !existsSync(ctx.launcher) ? '' : ' (changed since init wrote it)'}`);
  if (launcherOk) {
    const answer = await probe(ctx);
    report(answer.ok, answer.text);
  }
  for (const id of ids) {
    const agent = AGENTS.find((candidate) => candidate.id === id);
    if (!agent) {
      report(false, `${state.agents[id].name}: this version of the installer does not know it`);
      continue;
    }
    const result = agent.verify(ctx);
    report(result.ok, `${agent.name}: ${result.text}`);
    if (result.ok && result.url) {
      const answer = await probeHttp(result.url, result.token);
      report(answer.ok, `${agent.name}: ${answer.text}`);
    }
  }
  if (state.organizer?.agent) {
    const config = readJson(join(ctx.data, ORGANIZER_FILE));
    let runnable = false;
    try {
      accessSync(config?.command ?? '', constants.X_OK);
      runnable = true;
    } catch {
      // reported below
    }
    report(Boolean(config) && runnable, `organizer: ${state.organizer.agent} (${config?.command ?? 'no organizer.json'})${state.organizer.schedule ? ', daily sweep scheduled' : ''}`);
    const lines = existsSync(join(ctx.data, 'organizer', 'log.jsonl')) ? readFileSync(join(ctx.data, 'organizer', 'log.jsonl'), 'utf8').trim().split('\n') : [];
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) : undefined;
    if (last) ctx.say(`       last run ${last.at}: ${last.run} ${last.outcome}${last.error ? `: ${last.error}` : ''}`);
  }
  const imported = readImport(ctx.data);
  if (imported) {
    const run = imported.run;
    ctx.say(`       import of other assistants' memories: ${imported.status}${run ? ` (part ${run.chunk} of ${run.of}, ${run.created.length} new matters${run.errors?.length ? `, last problem: ${run.errors.at(-1)}` : ''})` : ''}`);
  }
  ctx.say(problems ? `${problems} problem${problems === 1 ? '' : 's'}. Running \`npx protocol-chaos init\` again repairs the launcher and the runtime.` : 'Everything answers. Start a new session in an agent for it to see the server.');
  return problems ? 1 : 0;
}

/** Asks the HTTP server, as Hermes would, for its directory. */
async function probeHttp(url, token) {
  try {
    const call = (body, auth) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const refused = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    if (refused.status !== 401) return { ok: false, text: `${url} answered ${refused.status} without a token, not 401: is it this server?` };
    const answer = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context_pack', arguments: {} } }, token);
    if (!answer.ok) return { ok: false, text: `${url} refused Hermes's token (${answer.status})` };
    return { ok: true, text: `the server at ${url} answers Hermes's token` };
  } catch (error) {
    return { ok: false, text: `nothing answers at ${url} (${error.cause?.code ?? error.name})` };
  }
}

/** Starts the server through the launcher, as an agent would, and reads the directory. */
async function probe(ctx) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'protocol-chaos-doctor', version });
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('no answer within 20 seconds')), 20_000).unref());
  try {
    await Promise.race([client.connect(new StdioClientTransport({ command: ctx.launcher, args: ['--client', 'doctor', '--tools', 'read'], env: ctx.env, stderr: 'ignore' })), timer]);
    const result = await Promise.race([client.callTool({ name: 'context_pack', arguments: {} }), timer]);
    const body = JSON.parse(result.content?.[0]?.text ?? '{}');
    if (result.isError) return { ok: false, text: `the server answered with an error: ${body.code} ${body.message}` };
    const count = Array.isArray(body.events) ? body.events.length : 0;
    return { ok: true, text: `the server answers through the launcher; ${count} open matter${count === 1 ? '' : 's'} in the directory` };
  } catch (error) {
    return { ok: false, text: `the server did not answer through the launcher: ${error.message}` };
  } finally {
    await client.close().catch(() => {});
  }
}
