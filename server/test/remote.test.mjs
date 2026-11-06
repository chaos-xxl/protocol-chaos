// The Remote binding (§9.2) over HTTP. First what the conformance tests cannot see: requests
// without a valid token, from a browser page, or other than POST are refused; a removed
// client is refused at once; plain HTTP is refused on an address other machines can reach.
// Then the whole conformance suite runs over HTTP, the Remote level included.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const SERVER = fileURLToPath(new URL('../index.mjs', import.meta.url));
const RUNNER = fileURLToPath(new URL('../../conformance/run.mjs', import.meta.url));
const directories = [];
const children = [];
after(async () => {
  await Promise.all(children.map(stop));
  directories.forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function freshDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'protocol-chaos-remote-'));
  directories.push(directory);
  return directory;
}

const clients = (directory, ...command) => execFileSync(process.execPath, [SERVER, 'clients', ...command, '--data', directory], { encoding: 'utf8' });
const addClient = (directory, name, ...flags) => /pc_[A-Za-z0-9_-]+/.exec(clients(directory, 'add', name, ...flags))[0];

/** The names of the tools a token is offered, and a function that calls one of them. */
async function toolsFor(url, token) {
  const client = new Client({ name: 'remote-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const { tools } = await client.listTools();
  return { names: tools.map((tool) => tool.name).sort(), call: (name, args) => client.callTool({ name, arguments: args }), close: () => client.close() };
}

/** Starts the server on a free loopback port; resolves with its /mcp URL. */
function startHttp(directory, ...flags) {
  const child = spawn(process.execPath, [SERVER, '--http', '127.0.0.1:0', '--data', directory, ...flags], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let log = '';
    child.stderr.on('data', (chunk) => {
      log += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(log);
      if (match) resolve(match[0]);
    });
    child.on('exit', (code) => reject(new Error(`the server exited (${code}): ${log}`)));
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

const INITIALIZE = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'remote-test', version: '0.0.0' } },
};
function request(url, { token, headers = {}, method = 'POST' } = {}) {
  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: method === 'POST' ? JSON.stringify(INITIALIZE) : undefined,
  });
}

test('requests without a valid token, from a browser page, or other than POST are refused', async () => {
  const directory = freshDirectory();
  const token = addClient(directory, 'laptop');
  const url = await startHttp(directory);

  const missing = await request(url);
  assert.equal(missing.status, 401, 'no token');
  assert.match(missing.headers.get('www-authenticate') ?? '', /^Bearer/);
  assert.equal((await request(url, { token: 'pc_not-a-token' })).status, 401, 'a token this server never issued');
  assert.equal((await request(url, { token, headers: { Origin: 'https://example.com' } })).status, 403, 'from a browser page');
  const get = await request(url, { token, method: 'GET' });
  assert.equal(get.status, 405, 'GET');
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await request(url.replace(/\/mcp$/, '/other'), { token })).status, 404, 'another path');

  const ok = await request(url, { token });
  assert.equal(ok.status, 200, 'a valid token');
  const { result } = await ok.json();
  assert.equal(result.serverInfo.name, 'protocol-chaos-reference');
  assert.match(result.instructions, /write as \{"kind": "agent", "id": "laptop"\}/, 'the instructions name the client');
});

test('a removed client is refused at once, without a restart', async () => {
  const directory = freshDirectory();
  const laptop = addClient(directory, 'laptop');
  const phone = addClient(directory, 'phone');
  const url = await startHttp(directory);
  assert.equal((await request(url, { token: laptop })).status, 200, 'before');
  clients(directory, 'remove', 'laptop');
  assert.equal((await request(url, { token: laptop })).status, 401, 'the removed client');
  assert.equal((await request(url, { token: phone })).status, 200, 'another client');
});

test('tool groups: the server\'s default, a client\'s own, and a tool not offered is refused', async () => {
  const directory = freshDirectory();
  const phone = addClient(directory, 'phone');
  const laptop = addClient(directory, 'laptop', '--tools', 'writer,entities');
  const organizer = addClient(directory, 'organizer');
  clients(directory, 'tools', 'organizer', 'all');
  assert.match(clients(directory, 'list'), /laptop .*tools read, record, fields, entities/);
  const url = await startHttp(directory, '--tools', 'assistant');

  const assistant = await toolsFor(url, phone);
  assert.deepEqual(assistant.names, ['context_pack', 'event_get_protocol', 'event_note', 'event_search'], 'the server\'s default');
  await assert.rejects(assistant.call('event_record_expression', { eventId: 'evt_0001', actor: { kind: 'agent', id: 'phone' }, text: 'x' }), /Unknown tool/);
  await assistant.close();

  const writer = await toolsFor(url, laptop);
  assert.deepEqual(writer.names, ['context_pack', 'entity_create', 'entity_get', 'entity_record', 'entity_search', 'event_get_protocol', 'event_note', 'event_record_expression', 'event_search']);
  await writer.close();

  const all = await toolsFor(url, organizer);
  assert.equal(all.names.length, 14, 'every operation but the owner\'s, which need --owner-tools');
  await all.close();

  clients(directory, 'tools', 'laptop', 'default');
  const back = await toolsFor(url, laptop);
  assert.equal(back.names.length, 4, 'back to the server\'s default, without a restart');
  await back.close();
});

test('an unknown tool group is refused, on the server and for a client', () => {
  const server = spawnSync(process.execPath, [SERVER, '--tools', 'read,everything', '--data', freshDirectory()], { encoding: 'utf8' });
  assert.equal(server.status, 2);
  assert.match(server.stderr, /Unknown tool group "everything"/);
  const directory = freshDirectory();
  addClient(directory, 'phone');
  const client = spawnSync(process.execPath, [SERVER, 'clients', 'tools', 'phone', 'nothing', '--data', directory], { encoding: 'utf8' });
  assert.notEqual(client.status, 0);
  assert.match(client.stderr, /Unknown tool group "nothing"/);
});

test('plain HTTP is refused on an address other machines can reach', () => {
  const run = spawnSync(process.execPath, [SERVER, '--http', '0.0.0.0:0', '--data', freshDirectory()], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /TLS/);
});

test('the conformance suite passes over HTTP, the Remote level included', { timeout: 240_000 }, async () => {
  const directory = freshDirectory();
  const token = addClient(directory, 'conformance');
  const url = await startHttp(directory, '--owner-tools');
  const runner = spawn(process.execPath, [RUNNER, '--url', url, '--token-env', 'PC_TOKEN', '--actor', 'conformance', '--json'], {
    env: { ...process.env, PC_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  runner.stdout.on('data', (chunk) => { out += chunk; });
  runner.stderr.on('data', (chunk) => { err += chunk; });
  const code = await new Promise((resolve) => runner.on('exit', resolve));
  assert.ok(out.trim().startsWith('{'), `the runner printed no results (exit ${code}): ${err}`);
  const report = JSON.parse(out);
  const failed = report.results.filter((result) => result.outcome === 'fail');
  assert.deepEqual(failed.map((result) => `${result.id}: ${result.detail}`), [], 'failed tests');
  const outcome = Object.fromEntries(report.results.map((result) => [result.id, result.outcome]));
  assert.equal(outcome['remote.actor'], 'pass');
  assert.equal(outcome['remote.version'], 'pass');
  assert.equal(outcome['remote.tls'], 'skip', 'TLS is not checked on a loopback address');
  assert.equal(code, 0);
});
