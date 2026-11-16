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
// instructions; where an agent does not show those to its model as instructions (Codex),
// init also writes them where the agent keeps standing instructions. Agents read the
// directory themselves and open what they need: nothing is added to a turn before the model
// answers. Every change is recorded in <data>/installed.json, and every file edited is copied
// to <data>/backups first. uninstall undoes the changes and keeps the repository.
//
// Agents: claude-code, codex, dsh (DeepSeek Harness). An agent that already has an MCP server
// named protocol_chaos is left as it is. Where each agent keeps its settings follows its own
// variables: CLAUDE_CONFIG_DIR, CODEX_HOME, DSH_HOME.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { instructions } from './instructions.mjs';

const { version } = createRequire(import.meta.url)('../package.json');
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_NAME = 'protocol_chaos';
// read, record and fields: read the directory and matters, record words, and change fields
// when the user asks for it now. The organizer's tools are left out (docs/agent-guide.md).
const TOOLS = 'writer';
const NOTE = 'added by `npx protocol-chaos init`; `npx protocol-chaos uninstall` removes it';
const HELP = `Usage:
  protocol-chaos init [--only <agents>] [--yes] [--dry-run] [--data <directory>]
  protocol-chaos uninstall [--only <agents>] [--dry-run] [--data <directory>]
  protocol-chaos doctor [--data <directory>]

Agents: claude-code, codex, dsh (DeepSeek Harness), comma-separated for --only.
--yes      connect every agent found, without asking
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
  return target;
}

/** Appends a marked block to a text file, creating it when missing; returns the change. */
function addBlock(ctx, file, block) {
  const existed = existsSync(file);
  const original = existed ? readFileSync(file, 'utf8') : '';
  const separator = original === '' ? '' : original.endsWith('\n') ? '\n' : '\n\n';
  const inserted = `${separator}${block}\n`;
  const saved = existed ? backup(ctx, file) : undefined;
  writeAtomic(file, original + inserted, existed ? modeOf(file) : 0o644);
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

/** The arguments each agent's MCP entry passes to the launcher. */
const serverArgs = (client) => ['--client', client, '--tools', TOOLS];

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

const describeEntry = (entry) => (entry?.url ? `the server at ${entry.url}` : entry?.command ? `\`${[entry.command, ...(entry.args ?? [])].join(' ')}\`` : 'an entry');

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
    const command = which(ctx, 'codex');
    if (command) return { found: true, where: command };
    if (existsSync(codexHome(ctx))) return { found: true, where: codexHome(ctx) };
    return { found: false };
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
    const agents = join(home, 'AGENTS.md');
    if (existsSync(agents) && readFileSync(agents, 'utf8').includes(SERVER_NAME)) {
      steps.push({ say: `leave ${agents} as it is: it already mentions ${SERVER_NAME}`, apply: () => undefined });
    } else {
      const block = [
        `<!-- protocol-chaos:begin (${NOTE}) -->`,
        `## Protocol Chaos (MCP server \`${SERVER_NAME}\`)`,
        '',
        instructions(this.id),
        '<!-- protocol-chaos:end -->',
      ].join('\n');
      steps.push({ say: `add the server's instructions to ${agents}`, apply: () => addBlock(ctx, agents, block) });
    }
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
    if (existsSync(dshHome(ctx))) return { found: true, where: dshHome(ctx) };
    return { found: false };
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

export const AGENTS = [claudeCode, codex, dsh];

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

// ------------------------------------------------------------------------------------- init

async function init(ctx, options) {
  const state = readState(ctx);
  const wanted = options.only ? parseOnly(options.only) : undefined;
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
  const refresh = rows.some((row) => row.ours) && (state.runtime?.version !== version || state.runtime?.entry !== runtimePlan(ctx, options).entry);
  if (!candidates.length && !refresh) {
    ctx.say(rows.some((row) => row.ours) ? 'Nothing to do. `npx protocol-chaos doctor` checks the connections.' : 'No agent to connect.');
    return 0;
  }
  const remote = rows.find((row) => row.existing?.url);
  const chosen = candidates.length ? await choose(ctx, candidates, options) : [];
  if (candidates.length && !chosen.length && !refresh) {
    ctx.say('Nothing was changed.');
    return 0;
  }
  if (chosen.length && remote && !(await confirmSeparate(ctx, remote, options))) {
    ctx.say('Nothing was changed.');
    return 0;
  }
  const runtime = runtimePlan(ctx, options);
  const plans = chosen.map((agent) => ({ agent, steps: agent.plan(ctx) }));
  if (ctx.dryRun) {
    ctx.say('Would do, with --dry-run doing nothing:');
    if (runtime.install) ctx.say(`  copy the server (protocol-chaos ${version}) into ${runtime.dir}`);
    ctx.say(`  write the launcher ${ctx.launcher}`);
    for (const { agent, steps } of plans) for (const step of steps) ctx.say(`  ${agent.name}: ${step.say}`);
    return 0;
  }
  mkdirSync(ctx.data, { recursive: true, mode: 0o700 });
  state.installer = `protocol-chaos ${version}`;
  state.launcher = ctx.launcher;
  state.runtime = ensureLauncher(ctx, state, runtime);
  writeState(ctx, state);
  let failed = 0;
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
  const connected = Object.values(state.agents).map((agent) => agent.name);
  if (connected.length) {
    ctx.say(`Connected: ${connected.join(', ')}. The repository: ${join(ctx.data, 'repository.json')}.`);
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
  if (change.kind === 'command') {
    try {
      run(ctx, change.undo);
      return `ran ${change.undo.map((part) => basename(part) === part ? part : basename(part)).join(' ')}`;
    } catch (error) {
      return `could not undo ${change.label}: ${error.message}`;
    }
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
  for (const id of present) {
    const agent = state.agents[id];
    for (const change of [...agent.changes].reverse()) {
      ctx.say(`  ${agent.name}: ${ctx.dryRun ? `would undo ${change.kind === 'block' ? `the block in ${change.file}` : change.label}` : undo(ctx, change)}`);
    }
    if (!ctx.dryRun) delete state.agents[id];
  }
  if (ctx.dryRun) return 0;
  if (!Object.keys(state.agents).length) {
    if (existsSync(ctx.launcher) && state.runtime?.launcherSha256 === sha256(readFileSync(ctx.launcher, 'utf8'))) rmSync(ctx.launcher);
    if (existsSync(dirname(ctx.launcher)) && !readdirSync(dirname(ctx.launcher)).length) rmSync(dirname(ctx.launcher), { recursive: true });
    if (state.runtime?.dir && existsSync(state.runtime.dir)) rmSync(state.runtime.dir, { recursive: true, force: true });
    rmSync(ctx.stateFile, { force: true });
    ctx.say(`No agent is connected now. The repository is kept at ${ctx.data}; delete that folder to remove it too.`);
  } else {
    writeState(ctx, state);
  }
  return 0;
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
  }
  ctx.say(problems ? `${problems} problem${problems === 1 ? '' : 's'}. Running \`npx protocol-chaos init\` again repairs the launcher and the runtime.` : 'Everything answers. Start a new session in an agent for it to see the server.');
  return problems ? 1 : 0;
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
