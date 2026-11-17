// `protocol-chaos init | uninstall | doctor` in a throwaway home folder: what each agent's
// settings look like afterwards, that the launcher starts a server an agent can use, that a
// second run changes nothing, that entries made by someone else are left alone, and that
// uninstall puts every file back byte for byte.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { instructions } from '../instructions.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = join(ROOT, 'server', 'index.mjs');
const homes = [];
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

// A stand-in for the claude command: keeps user-scope MCP servers in .claude.json as the
// real one does, and logs how it was called.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(join(process.env.HOME, 'claude-calls.log'), args.join(' ') + '\\n');
const file = join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, '.claude.json');
const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
config.mcpServers ??= {};
if (args[0] === 'mcp' && args[1] === 'add') {
  const at = args.indexOf('--');
  const scoped = args.slice(2, at);
  const server = scoped[scoped.length - 1];
  if (config.mcpServers[server]) { console.error('exists'); process.exit(1); }
  config.mcpServers[server] = { type: 'stdio', command: args[at + 1], args: args.slice(at + 2), env: {} };
} else if (args[0] === 'mcp' && args[1] === 'remove') {
  const server = args[args.length - 1];
  if (!config.mcpServers[server]) { console.error('missing'); process.exit(1); }
  delete config.mcpServers[server];
} else { process.exit(2); }
writeFileSync(file, JSON.stringify(config, null, 2));
`;

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'protocol-chaos-init-'));
  homes.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  // DeepSeek Harness's command, found on PATH before any app on this machine; init never runs it.
  writeFileSync(join(bin, 'dsh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'dsh'), 0o755);
  mkdirSync(join(home, '.codex'));
  mkdirSync(join(home, '.dsh'));
  return home;
}

// --runtime runs the server from this clone, so that most tests need not copy it.
function installer(home, ...args) {
  return installerAs(home, [...args, '--runtime', ROOT]);
}

function installerAs(home, args) {
  const env = { HOME: home, PATH: [join(home, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':') };
  const result = spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8', input: '' });
  return { code: result.status, out: result.stdout + result.stderr };
}

const read = (file) => readFileSync(file, 'utf8');
const CODEX_CONFIG = 'model = "gpt-5"\n\n[mcp_servers.figma]\nurl = "http://127.0.0.1:3845/mcp"\n';
const CODEX_RULES = '# My own rules\n\nBe brief.';

function tomlParses(file) {
  const result = spawnSync('python3', ['-c', 'import sys, tomllib, json; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', file], { encoding: 'utf8' });
  if (result.error || result.status !== 0 && /No module named/.test(result.stderr)) return undefined;
  assert.equal(result.status, 0, `${file} is valid TOML: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('init connects Claude Code, Codex and DeepSeek Harness, and uninstall puts every file back', () => {
  const home = freshHome();
  writeFileSync(join(home, '.codex', 'config.toml'), CODEX_CONFIG);
  writeFileSync(join(home, '.codex', 'AGENTS.md'), CODEX_RULES);
  const launcher = join(home, '.protocol-chaos', 'bin', 'protocol-chaos');

  const first = installer(home, 'init', '--yes');
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Connected: Claude Code, Codex, DeepSeek Harness/);

  const claude = JSON.parse(read(join(home, '.claude.json'))).mcpServers.protocol_chaos;
  assert.deepEqual(claude, { type: 'stdio', command: launcher, args: ['--client', 'claude-code', '--tools', 'writer'], env: {} });

  const config = read(join(home, '.codex', 'config.toml'));
  assert.ok(config.startsWith(CODEX_CONFIG), 'the user\'s settings come first, unchanged');
  const parsed = tomlParses(join(home, '.codex', 'config.toml'));
  if (parsed) {
    assert.equal(parsed.model, 'gpt-5');
    assert.deepEqual(parsed.mcp_servers.protocol_chaos, { command: launcher, args: ['--client', 'codex', '--tools', 'writer'], startup_timeout_sec: 30 });
  }
  const rules = read(join(home, '.codex', 'AGENTS.md'));
  assert.ok(rules.startsWith(`${CODEX_RULES}\n\n<!-- protocol-chaos:begin`), 'the block follows the user\'s rules after a blank line');
  assert.ok(rules.includes(instructions('codex')), 'Codex gets the server\'s own instructions, naming it');

  const patch = read(join(home, '.dsh', 'cordis.patch.yml'));
  assert.match(patch, /serverName: protocol_chaos/);
  assert.ok(patch.includes(`command: '${launcher}'`));
  assert.ok(patch.includes("args: ['--client', 'dsh', '--tools', 'writer']"));

  const organizer = JSON.parse(read(join(home, '.protocol-chaos', 'organizer.json')));
  assert.deepEqual(organizer, { agent: 'dsh', command: join(home, 'bin', 'dsh'), actor: 'organizer', enabled: true, provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' }, 'DeepSeek Harness organizes first, with a small model and thinking off');
  assert.match(first.out, /Organizing in the background: DeepSeek Harness \(dsh --profile headless\)/);
  assert.match(first.out, /The daily sweep was not scheduled: HOME is not your home folder/, 'a test home never reaches the real scheduler');

  const doctor = installer(home, 'doctor');
  assert.equal(doctor.code, 0, doctor.out);
  assert.match(doctor.out, /the server answers through the launcher; 0 open matters/);
  assert.match(doctor.out, /ok {3}organizer: dsh/);

  const again = installer(home, 'init', '--yes');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /Nothing to do/);
  assert.equal(read(join(home, '.codex', 'config.toml')), config, 'a second run changes nothing');

  const removed = installer(home, 'uninstall');
  assert.equal(removed.code, 0, removed.out);
  assert.equal(read(join(home, '.codex', 'config.toml')), CODEX_CONFIG);
  assert.equal(read(join(home, '.codex', 'AGENTS.md')), CODEX_RULES);
  assert.ok(!existsSync(join(home, '.dsh', 'cordis.patch.yml')), 'the patch file init created is gone');
  assert.deepEqual(JSON.parse(read(join(home, '.claude.json'))).mcpServers, {});
  assert.ok(!existsSync(launcher) && !existsSync(join(home, '.protocol-chaos', 'installed.json')));
  assert.ok(!existsSync(join(home, '.protocol-chaos', 'organizer.json')) && !existsSync(join(home, '.protocol-chaos', 'organizer')), 'organizing goes too');
  assert.match(read(join(home, 'claude-calls.log')), /^mcp add --scope user protocol_chaos -- .*\nmcp remove --scope user protocol_chaos\n$/);
});

test('the launcher starts a server that knows which agent it serves', () => {
  const home = freshHome();
  assert.equal(installer(home, 'init', '--yes', '--only', 'codex').code, 0);
  const launcher = join(home, '.protocol-chaos', 'bin', 'protocol-chaos');
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(launcher, ['--client', 'codex', '--tools', 'writer'], { input: `${messages}\n`, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 15_000 });
  const answers = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.match(answers[0].result.instructions, /write as \{"kind": "agent", "id": "codex"\}/);
  assert.deepEqual(answers[1].result.tools.map((tool) => tool.name).sort(), ['context_pack', 'event_get_protocol', 'event_note', 'event_record_expression', 'event_search']);
});

test('without --runtime, init copies the server and its dependencies, and the copy runs on its own', () => {
  const home = freshHome();
  const result = installerAs(home, ['init', '--yes', '--only', 'codex']);
  assert.equal(result.code, 0, result.out);
  const entry = join(home, '.protocol-chaos', 'runtime', JSON.parse(read(join(ROOT, 'package.json'))).version, 'node_modules', 'protocol-chaos', 'server', 'index.mjs');
  assert.ok(existsSync(entry), 'the server is copied');
  assert.ok(existsSync(join(dirname(dirname(dirname(entry))), '@modelcontextprotocol', 'sdk')), 'with its dependencies');
  assert.ok(read(join(home, '.protocol-chaos', 'bin', 'protocol-chaos')).includes(entry), 'the launcher runs the copy');
  const doctor = spawnSync(process.execPath, [entry, 'doctor'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  const removed = installerAs(home, ['uninstall']);
  assert.equal(removed.code, 0, removed.out);
  assert.ok(!existsSync(join(home, '.protocol-chaos', 'runtime')), 'uninstall removes the copy, and its folder');
  assert.deepEqual(readdirSync(join(home, '.protocol-chaos')), [], 'nothing of init is left; the repository was never written');
});

test('an agent already connected to a server elsewhere is left alone, and --yes will not split the repository', () => {
  const home = freshHome();
  const remote = `${CODEX_CONFIG}\n[mcp_servers.protocol_chaos]\nurl = "https://example.org/mcp"\n`;
  writeFileSync(join(home, '.codex', 'config.toml'), remote);
  const result = installer(home, 'init', '--yes');
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Codex\s+already connected to the server at https:\/\/example\.org\/mcp; left as it is/);
  assert.match(result.out, /would not share it/);
  assert.equal(read(join(home, '.codex', 'config.toml')), remote);
  assert.ok(!existsSync(join(home, '.claude.json')) && !existsSync(join(home, '.dsh', 'cordis.patch.yml')), 'nothing else was connected');
});

test('--dry-run changes nothing, and a patch file init cannot extend is refused', () => {
  const home = freshHome();
  const dry = installer(home, 'init', '--dry-run');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Would do/);
  assert.ok(!existsSync(join(home, '.protocol-chaos')) && !existsSync(join(home, '.claude.json')) && !existsSync(join(home, '.codex', 'config.toml')));

  writeFileSync(join(home, '.dsh', 'cordis.patch.yml'), 'insert: {}\n');
  const refused = installer(home, 'init', '--yes', '--only', 'dsh');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /not a block-style YAML list/);
  assert.equal(read(join(home, '.dsh', 'cordis.patch.yml')), 'insert: {}\n');
});

test('without a terminal and without --yes, init asks for --yes instead of guessing', () => {
  const home = freshHome();
  const result = installer(home, 'init');
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /init --yes/);
  assert.ok(!existsSync(join(home, '.claude.json')));
});

test('the agent guide\'s template is the text the server sends', () => {
  const guide = read(join(ROOT, 'docs', 'agent-guide.md'));
  const template = /## Server instructions[\s\S]*?```text\n([\s\S]*?)\n```/.exec(guide)[1];
  assert.equal(template, instructions());
});

test('--organizer picks another agent or turns organizing off, and the choice holds on the next run', () => {
  const home = freshHome();
  assert.equal(installer(home, 'init', '--yes', '--only', 'claude-code,dsh', '--organizer', 'claude-code').code, 0);
  const config = JSON.parse(read(join(home, '.protocol-chaos', 'organizer.json')));
  assert.equal(config.agent, 'claude-code');
  assert.equal(config.model, 'haiku', 'a small model, with a spending cap per call');
  assert.equal(config.budgetUsd, 0.2);
  const off = installer(home, 'init', '--yes', '--organizer', 'none');
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /Organizing in the background: off/);
  assert.ok(!existsSync(join(home, '.protocol-chaos', 'organizer.json')));
  const again = installer(home, 'init', '--yes');
  assert.match(again.out, /Nothing to do/, 'once turned off, it stays off');
  const refused = installer(home, 'init', '--yes', '--organizer', 'codex');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /--organizer codex: it is not connected here/);
  const removed = installer(home, 'uninstall', '--only', 'dsh');
  assert.equal(removed.code, 0, removed.out);
  assert.equal(installer(home, 'init', '--yes', '--organizer', 'claude-code').code, 0);
  const gone = installer(home, 'uninstall', '--only', 'claude-code');
  assert.match(gone.out, /off, since its agent was disconnected|organizing in the background: off/);
  assert.ok(!existsSync(join(home, '.protocol-chaos', 'organizer.json')));
});

// A stand-in for the hermes command: logs how it was called.
const FAKE_HERMES = `#!/usr/bin/env node
require('node:fs').appendFileSync(require('node:path').join(process.env.HOME, 'hermes-calls.log'), process.argv.slice(2).join(' ') + '\\n');
`;

test('Hermes gets a token, the server over HTTP, its .env, an MCP server and the plugin; its own words are not queued', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'bin', 'hermes'), FAKE_HERMES);
  chmodSync(join(home, 'bin', 'hermes'), 0o755);
  mkdirSync(join(home, '.hermes'));
  const original = 'OPENAI_API_KEY=sk-test\n';
  writeFileSync(join(home, '.hermes', '.env'), original, { mode: 0o600 });
  const data = join(home, '.protocol-chaos');

  const result = installer(home, 'init', '--yes', '--only', 'hermes,dsh');
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Connected: DeepSeek Harness, Hermes|Connected: Hermes, DeepSeek Harness/);
  assert.match(result.out, /not set to start at login \(HOME is not your home folder\)/);
  const env = read(join(home, '.hermes', '.env'));
  assert.ok(env.startsWith(original));
  const url = /PROTOCOL_CHAOS_URL=(http:\/\/127\.0\.0\.1:(\d+)\/mcp)/.exec(env);
  const token = /PROTOCOL_CHAOS_TOKEN=(pc_[A-Za-z0-9_-]+)/.exec(env)?.[1];
  assert.ok(url && token);
  const { Clients } = await import('../clients.mjs');
  assert.equal(new Clients(data).verify(token), 'hermes', 'the token in .env is the one issued');
  const calls = read(join(home, 'hermes-calls.log'));
  assert.ok(calls.includes('config set mcp_servers.protocol_chaos.url ${PROTOCOL_CHAOS_URL}'));
  assert.ok(calls.includes('config set mcp_servers.protocol_chaos.headers.Authorization Bearer ${PROTOCOL_CHAOS_TOKEN}'));
  assert.ok(calls.includes('plugins install chaos-xxl/protocol-chaos#integrations/hermes/protocol-chaos --enable'));
  assert.deepEqual(JSON.parse(read(join(data, 'organizer.json'))).selfOrganizing, ['hermes'], 'Hermes folds its own words');

  // The service would start the server at login; here the test starts it.
  const server = spawn(process.execPath, [SERVER, '--data', data, '--http', `127.0.0.1:${url[2]}`], { stdio: 'ignore' });
  try {
    await new Promise((done) => setTimeout(done, 800));
    const doctor = await new Promise((done) => {
      const child = spawn(process.execPath, [SERVER, 'doctor', '--runtime', ROOT], { env: { HOME: home, PATH: [join(home, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':') } });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('close', (code) => done({ code, out }));
    });
    assert.match(doctor.out, /ok {3}Hermes: the server at http:\/\/127\.0\.0\.1:\d+\/mcp answers Hermes's token/, doctor.out);
    const note = await fetch(url[1], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'event_note', arguments: { actor: { kind: 'agent', id: 'hermes' }, text: 'Hermes records this itself', title: 'Recorded by Hermes, 2026' } } }),
    });
    assert.equal(note.status, 200);
    await new Promise((done) => setTimeout(done, 300));
    const queue = join(data, 'organizer', 'queue');
    assert.ok(!existsSync(queue) || readdirSync(queue).length === 0, 'Hermes\'s words are not queued for the organizer');
  } finally {
    server.kill();
  }

  const removed = installer(home, 'uninstall');
  assert.equal(removed.code, 0, removed.out);
  assert.equal(read(join(home, '.hermes', '.env')), original, '.env is as it was');
  assert.equal(new Clients(data).verify(token), undefined, 'the token is revoked');
  const after = read(join(home, 'hermes-calls.log'));
  assert.ok(after.includes('plugins remove protocol-chaos') && after.includes('config unset mcp_servers.protocol_chaos'));
});

test('a second run repairs a launcher whose Node.js is gone', () => {
  const home = freshHome();
  assert.equal(installer(home, 'init', '--yes', '--only', 'codex').code, 0);
  const stateFile = join(home, '.protocol-chaos', 'installed.json');
  const launcher = join(home, '.protocol-chaos', 'bin', 'protocol-chaos');
  const state = JSON.parse(read(stateFile));
  writeFileSync(stateFile, JSON.stringify({ ...state, runtime: { ...state.runtime, node: '/gone/node' } }));
  writeFileSync(launcher, read(launcher).replace(process.execPath, '/gone/node'));
  const broken = installer(home, 'doctor');
  assert.equal(broken.code, 1, broken.out);
  const repaired = installer(home, 'init', '--yes');
  assert.equal(repaired.code, 0, repaired.out);
  assert.match(repaired.out, /launcher: runs protocol-chaos [\d.]+ with /);
  assert.ok(read(launcher).includes(process.execPath) && !read(launcher).includes('/gone/node'));
  assert.equal(installer(home, 'doctor').code, 0);
  assert.match(installer(home, 'init', '--yes').out, /Nothing to do/, 'once repaired, nothing more to do');
});
