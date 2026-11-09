// P: the matters in Protocol Chaos, kept by the reference server of this repository. Each
// conversation starts its own server on a loopback port with the clock fixed at the
// conversation's moment, and talks to it over MCP streamable HTTP with that assistant's own
// bearer token, as a remote client does: the server binds every write to the assistant
// (ACTOR_MISMATCH otherwise) and requires expectedVersion for the writes that change fields
// or parents. The directory (context_pack, every page) is in the system prompt; the tools
// are the server's own, as it lists them for the arm's tool profile (server --tools): by
// default writer, the reading tools, event_note and event_record_expression, which is what
// an assistant that brings an Event's fields up to date itself is offered.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Clients } from '../../../server/clients.mjs';
import { ASSISTANT_IDS, writeRepository } from '../p-writer.mjs';
import { ORGANIZER_ID } from '../prompts.mjs';
import { beijingDate, instantOf } from '../util.mjs';

const SERVER = fileURLToPath(new URL('../../../server/index.mjs', import.meta.url));
const PRELOAD = pathToFileURL(fileURLToPath(new URL('../clock-preload.mjs', import.meta.url))).href;
const START_TIMEOUT_MS = 20_000;

/** Starts a server on `directory` with its clock at `instant`, offering `tools`; resolves with {child, url}. */
export function startServer(directory, instant, tools = 'all') {
  const child = spawn(process.execPath, ['--import', PRELOAD, SERVER, '--http', '127.0.0.1:0', '--data', directory, '--tools', tools], {
    // Only what node needs: no keys from the harness's environment reach the server.
    env: { PATH: process.env.PATH ?? '', PROTOCOL_CHAOS_EVAL_CLOCK: instant },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the reference server did not start within ${START_TIMEOUT_MS} ms: ${log}`));
    }, START_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      log += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(log);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[0] });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the reference server exited (${code}): ${log}`));
    });
  });
}

export function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  });
}

/** The one text item of a tool result. */
const textOf = (result) => (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');

/**
 * The directory as lines, one per Event, with everything context_pack returns. `order`
 * "recent" keeps the server's order, most recently updated first; "id" sorts by id, so that
 * the lines of Events that did not change stay where they were and a prompt cache can reuse them.
 */
export function renderDirectory(events, order = 'recent') {
  if (events.length === 0) return '## 事情目录\n\n（库里还没有任何事情）';
  const listed = order === 'id' ? [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : events;
  const lines = listed.map((e) => {
    const parts = [e.id, e.title ?? '（无标题）', e.state, `上级：${e.parents.length ? e.parents.join('、') : '无'}`, `更新：${beijingDate(e.updatedAt)}`];
    if (e.progress) parts.push(`进展（${beijingDate(e.progress.timestamp)}）：${e.progress.text}`);
    return `- ${parts.join('｜')}`;
  });
  const sorted = order === 'id' ? '按 id 排列' : '最近更新的在前';
  return `## 事情目录\n\n这次对话开始时库里的全部事情，共 ${events.length} 件，${sorted}。每行：id｜标题｜状态｜上级｜最后更新｜进展。\n\n${lines.join('\n')}`;
}

/** Connects to a server as the client whose bearer token this is; resolves with the MCP client. */
export async function connect(url, token) {
  const client = new Client({ name: 'protocol-chaos-eval', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

/**
 * The tools each kind of conversation is offered. An assistant in mode inline: `tools` (by
 * default writer). An assistant that only records (modes light and organized): assistant, the
 * reading tools and event_note. The organizer: what the agent guide gives an organizer, the
 * reading tools, event_words_since, event_record_expression, the parent links, and event_note
 * to record words again on the Event they belong to.
 */
export const RECORD_ONLY_TOOLS = 'assistant';
export const ORGANIZER_TOOLS = 'read,record,fields,links,sync';

/** The latest createdAt of the Accounts in a repository.json; the organizer reads the words after it. */
export function latestAccountTime(directory) {
  const snapshot = JSON.parse(readFileSync(join(directory, 'repository.json'), 'utf8'));
  let latest = '';
  for (const { accounts } of snapshot.events) for (const a of accounts) if (a.createdAt > latest) latest = a.createdAt;
  return latest || new Date(0).toISOString();
}

/** The P arm with a tool profile of the server's (--tools) and a directory order (renderDirectory). */
export const protocolArm = ({ tools = 'writer', order = 'recent' } = {}) => ({
  name: 'P',
  tools,
  order,
  /** A tool call as it is counted in a pilot: event_note says whether it continued a matter or started one. */
  label(name, args) {
    if (name !== 'event_note') return name;
    return `event_note:${args?.eventId ? 'continue' : args?.parentEventId ? 'new-under' : 'new'}`;
  },
  /** Writes repository.json and one token per assistant (kept only in memory; clients.json holds their hashes). */
  prepare(directory, matters) {
    writeRepository(matters, directory);
    const clients = new Clients(directory);
    const tokens = {};
    for (const [letter, name] of Object.entries(ASSISTANT_IDS)) tokens[letter] = clients.add(name);
    tokens[ORGANIZER_ID] = clients.add(ORGANIZER_ID);
    return { tokens };
  },
  /** Starts a server for one conversation and connects to it as `assistant`, or as the organizer. */
  async open(directory, { date, time, assistant, meta, mode = 'inline', role = 'assistant' }) {
    const organizing = role === 'organizer';
    const offered = organizing ? ORGANIZER_TOOLS : mode === 'inline' ? tools : RECORD_ONLY_TOOLS;
    const { child, url } = await startServer(directory, instantOf(date, time), offered);
    let client;
    try {
      client = await connect(url, meta.tokens[organizing ? ORGANIZER_ID : assistant]);
      const { tools } = await client.listTools();
      const events = [];
      let cursor;
      do {
        const result = await client.callTool({ name: 'context_pack', arguments: cursor ? { cursor } : {} });
        const page = JSON.parse(textOf(result));
        events.push(...page.events);
        cursor = page.next;
      } while (cursor);
      const names = new Set(tools.map((t) => t.name));
      return {
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
        view: renderDirectory(events, order),
        has: (name) => names.has(name),
        async call(name, args) {
          const result = await client.callTool({ name, arguments: args ?? {} });
          return { text: textOf(result), isError: Boolean(result.isError) };
        },
        async close() {
          await client.close().catch(() => {});
          await stopServer(child);
        },
      };
    } catch (error) {
      await client?.close().catch(() => {});
      await stopServer(child);
      throw error;
    }
  },
  dump(directory) {
    return readFileSync(join(directory, 'repository.json'), 'utf8');
  },
  /** The organizer's starting point: the words after the starting store's are new. */
  organizeStart(directory) {
    return { since: latestAccountTime(directory) };
  },
  /** The organizer's message: where event_words_since starts; null when no words were recorded since. */
  organizeMessage(directory, state, { date }) {
    if (latestAccountTime(directory) <= state.since) return null;
    return `现在是 ${date} 夜里，整理上次整理以后新记的话：用 event_words_since 取，since 填 "${state.since}"。`;
  },
  /** After a night: the words the organizer itself recorded are not new the next night. */
  organizeDone(directory, state) {
    state.since = latestAccountTime(directory);
  },
});

export default protocolArm();
