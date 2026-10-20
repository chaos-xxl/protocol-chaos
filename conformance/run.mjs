#!/usr/bin/env node
/**
 * Protocol Chaos conformance tests, draft 0.2. Runs against any server over MCP.
 *
 *   node conformance/run.mjs --stdio "node my-server.js --data {tmp}"
 *   PC_TOKEN=… node conformance/run.mjs --url https://host.example/mcp --token-env PC_TOKEN --actor laptop
 *
 * Options:
 *   --stdio CMD       start the server with this shell command; {tmp} becomes a fresh, empty directory
 *   --url URL         an MCP streamable HTTP endpoint instead; --token-env NAME names the variable
 *                     that holds its bearer token
 *   --actor NAME      the writer's name; over HTTP, the client name the token was issued for
 *                     (default: conformance)
 *   --levels LIST     comma-separated: core, entities, search, sync, undo, remote. Default: core,
 *                     every optional level whose operations the server lists, and remote with --url
 *   --only PREFIX     run only the tests whose id starts with PREFIX
 *   --assume-empty    do not check that the repository is empty first
 *   --json            print the results as JSON
 *
 * The tests write Events and Entities. Run them only against a repository made for the purpose:
 * unless --assume-empty is given, the run stops when the directory (context_pack) is not empty.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, makeContext, Failure, Skip, ToolError } from './lib.mjs';
import core from './tests/core.mjs';
import entities from './tests/entities.mjs';
import optional from './tests/optional.mjs';
import remote from './tests/remote.mjs';

const LEVELS = ['core', 'entities', 'search', 'sync', 'undo', 'remote'];
const LEVEL_TOOLS = { entities: 'entity_create', search: 'event_search', sync: 'event_words_since', undo: 'event_undo_revision' };

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(name);
const stdio = option('--stdio');
const url = option('--url');
if (!stdio === !url) {
  console.error('Give exactly one of --stdio "<command>" and --url <endpoint>. See the top of this file.');
  process.exit(2);
}
const tokenVariable = option('--token-env');
const token = tokenVariable ? process.env[tokenVariable] : undefined;
if (tokenVariable && !token) {
  console.error(`The variable ${tokenVariable} is empty.`);
  process.exit(2);
}
const actorId = option('--actor') ?? 'conformance';
const only = option('--only');
const runId = Date.now().toString(36);

const temporary = [];
/** A fresh server: with {tmp} in the command, each one gets its own empty directory. */
async function start() {
  if (!stdio) return connect({ url, token });
  let command = stdio;
  if (stdio.includes('{tmp}')) {
    const directory = mkdtempSync(join(tmpdir(), 'protocol-chaos-conformance-'));
    temporary.push(directory);
    command = stdio.replaceAll('{tmp}', directory);
  }
  return connect({ stdio: command });
}
const canStartFresh = Boolean(stdio && stdio.includes('{tmp}'));

const connection = await start();
const listed = new Set(connection.tools.map((tool) => tool.name));
const requested = option('--levels')?.split(',').map((level) => level.trim()).filter(Boolean);
const unknown = (requested ?? []).filter((level) => !LEVELS.includes(level));
if (unknown.length) {
  console.error(`Unknown level: ${unknown.join(', ')}. Levels: ${LEVELS.join(', ')}.`);
  process.exit(2);
}
const levels = requested
  ? ['core', ...requested.filter((level) => level !== 'core')]
  : ['core', ...Object.entries(LEVEL_TOOLS).filter(([, tool]) => listed.has(tool)).map(([level]) => level), ...(url ? ['remote'] : [])];

if (!flag('--assume-empty') && !canStartFresh) {
  let empty = false;
  try {
    const directory = await makeContext(connection, { actorId, runId }).call('context_pack', {});
    empty = Array.isArray(directory.events) && directory.events.length === 0 && !directory.next;
  } catch {
    empty = false;
  }
  if (!empty) {
    console.error('Stopped: the repository is not empty, or its directory (context_pack) could not confirm that it is.');
    console.error('The tests write data. Use a repository made for them, or pass --assume-empty if this one is.');
    await connection.close();
    process.exit(2);
  }
}

const tests = [...core, ...entities, ...optional, ...remote].filter(
  (test) => levels.includes(test.level) && (!only || test.id.startsWith(only)),
);
const results = [];
const context = makeContext(connection, { actorId, runId });
context.levels = new Set(levels);
context.remote = Boolean(url);
context.url = url;
context.fresh = async () => {
  if (!canStartFresh) throw new Skip('needs a fresh repository: run with --stdio and {tmp} in the command');
  const other = await start();
  const otherContext = makeContext(other, { actorId, runId });
  otherContext.close = () => other.close();
  return otherContext;
};

for (const test of tests) {
  const startedAt = Date.now();
  let outcome = 'pass';
  let detail = '';
  try {
    await test.run(context);
  } catch (error) {
    if (error instanceof Skip) {
      outcome = 'skip';
      detail = error.message;
    } else {
      outcome = 'fail';
      detail = error instanceof Failure || error instanceof ToolError ? error.message : `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
    }
  }
  results.push({ id: test.id, level: test.level, ref: test.ref, title: test.title, outcome, detail, ms: Date.now() - startedAt });
  if (!flag('--json')) {
    const mark = outcome === 'pass' ? '✓' : outcome === 'skip' ? '-' : '✗';
    console.log(`${mark} ${test.id.padEnd(34)} ${test.ref.padEnd(7)} ${test.title}${detail ? `\n    ${detail}` : ''}`);
  }
}
await connection.close();
for (const directory of temporary) rmSync(directory, { recursive: true, force: true });

const summary = Object.fromEntries(levels.map((level) => {
  const mine = results.filter((result) => result.level === level);
  return [level, {
    passed: mine.filter((result) => result.outcome === 'pass').length,
    failed: mine.filter((result) => result.outcome === 'fail').length,
    skipped: mine.filter((result) => result.outcome === 'skip').length,
  }];
}));
const server = `${connection.serverInfo.name ?? 'unknown server'} ${connection.serverInfo.version ?? ''}`.trim();
if (flag('--json')) {
  console.log(JSON.stringify({ draft: '0.2', server, levels, summary, results }, null, 2));
} else {
  console.log(`\nProtocol Chaos draft 0.2 · ${server}`);
  for (const [level, counts] of Object.entries(summary)) {
    console.log(`  ${level.padEnd(9)} ${counts.passed} passed, ${counts.failed} failed${counts.skipped ? `, ${counts.skipped} skipped` : ''}`);
  }
}
process.exit(results.some((result) => result.outcome === 'fail') ? 1 : 0);
