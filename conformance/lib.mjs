// Shared pieces of the conformance suite: connecting to a server over MCP, calling its
// operations, and the small assertion vocabulary the tests use. Nothing here knows about
// any particular implementation; a server is reached only through its tools.
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** A failure the server reported as `{code, message}` (§5.4). */
export class ToolError extends Error {
  constructor(tool, code, message) {
    super(`${tool} failed with ${code}: ${message}`);
    this.code = code;
    this.serverMessage = message;
  }
}

/** The server did something this draft does not allow. */
export class Failure extends Error {}

/** The test cannot run against this server or set-up; reported, not counted as a failure. */
export class Skip extends Error {}

/** Connects to a server: `stdio` is a shell command, `url` an MCP streamable HTTP endpoint. */
export async function connect({ stdio, url, token }) {
  const client = new Client({ name: 'protocol-chaos-conformance', version: '0.2.0' });
  const transport = stdio
    ? new StdioClientTransport({ command: 'sh', args: ['-c', `exec ${stdio}`], env: { ...process.env }, stderr: 'ignore' })
    : new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools, serverInfo: client.getServerVersion() ?? {}, close: () => client.close() };
}

/** Calls one operation. Returns the JSON result, or throws ToolError for a reported failure. */
export async function callTool(connection, name, args) {
  const result = await connection.client.callTool({ name, arguments: args });
  const items = (result.content ?? []).filter((item) => item.type === 'text');
  if (items.length !== 1) throw new Failure(`${name}: expected one text item in the result, got ${items.length} (§9.1)`);
  let value;
  try {
    value = JSON.parse(items[0].text);
  } catch {
    throw new Failure(`${name}: the result is not JSON (§9.1): ${items[0].text.slice(0, 120)}`);
  }
  if (result.isError) {
    if (!value || typeof value.code !== 'string' || typeof value.message !== 'string') {
      throw new Failure(`${name}: a failure must hold {code, message} (§5.4)`);
    }
    throw new ToolError(name, value.code, value.message);
  }
  return value;
}

const show = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

/** The first place where two JSON values differ, as a path such as `[3].updatedAt`. */
function firstDifference(actual, expected, path = '') {
  if (isDeepStrictEqual(actual, expected)) return undefined;
  const container = (value) => value !== null && typeof value === 'object';
  if (!container(actual) || !container(expected) || Array.isArray(actual) !== Array.isArray(expected)) {
    return { path, actual, expected };
  }
  if (Array.isArray(actual)) {
    for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
      const found = firstDifference(actual[index], expected[index], `${path}[${index}]`);
      if (found) return found;
    }
    return { path, actual, expected };
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const found = firstDifference(actual[key], expected[key], `${path}.${key}`);
    if (found) return found;
  }
  return { path, actual, expected };
}

function receipt(t, value, tool) {
  t.assert(value && typeof value.eventId === 'string' && Number.isInteger(value.version) && typeof value.accountId === 'string',
    `${tool} answers with a receipt {eventId, version, accountId, …} (§8.1)`);
  return value;
}

/** The object each test receives. */
export function makeContext(connection, { actorId, runId }) {
  const actor = { kind: 'agent', id: actorId };
  let counter = 0;
  const t = {
    actor,
    tools: new Set(connection.tools.map((tool) => tool.name)),
    toolList: connection.tools,
    call: (name, args) => callTool(connection, name, args),
    /** A text unique to this run, so tests never collide with each other. */
    unique: (label) => `${label} ${runId}-${(counter += 1)}`,
    assert(condition, message) {
      if (!condition) throw new Failure(message);
    },
    equal(actual, expected, message) {
      if (isDeepStrictEqual(actual, expected)) return;
      const difference = firstDifference(actual, expected);
      const where = difference?.path
        ? ` (first difference at ${difference.path}: expected ${show(difference.expected)}, got ${show(difference.actual)})`
        : '';
      throw new Failure(`${message}: expected ${show(expected)}, got ${show(actual)}${where}`);
    },
    /** Expects the call to fail with `code` (any code when omitted) and returns the error. */
    async fails(code, run, message = 'the call') {
      try {
        await run();
      } catch (error) {
        if (error instanceof ToolError) {
          if (code && error.code !== code) throw new Failure(`${message}: expected ${code}, got ${error.code} (${error.serverMessage})`);
          return error;
        }
        throw error;
      }
      throw new Failure(`${message}: expected ${code ?? 'a failure'}, but it succeeded`);
    },
    skip(reason) {
      throw new Skip(reason);
    },
    // Shorthands for the operations most tests need. They check the shape of what comes
    // back, so that a server answering in another shape fails with the rule it breaks.
    async note(text, more = {}) {
      return receipt(t, await t.call('event_note', { actor, accountSource: 'user', text, ...more }), 'event_note');
    },
    async record(eventId, expectedVersion, text, set, more = {}) {
      return receipt(t, await t.call('event_record_expression', {
        eventId, actor, accountSource: 'user', text, expectedVersion, ...(set === undefined ? {} : { set }), ...more,
      }), 'event_record_expression');
    },
    async read(eventId, more = {}) {
      const result = await t.call('event_get_protocol', { eventId, ...more });
      t.assert(result && result.event && typeof result.event === 'object' && Array.isArray(result.accounts),
        'event_get_protocol returns {event, accounts} (§8.1)');
      return result;
    },
    async revisions(eventId) {
      const all = [];
      let after;
      for (let page = 0; page < 100; page += 1) {
        const result = await t.call('event_get_revisions', { eventId, ...(after ? { after } : {}) });
        t.assert(Array.isArray(result.revisions), 'event_get_revisions returns {revisions} (§8.1)');
        all.push(...result.revisions);
        if (!result.next) return all;
        after = result.next;
      }
      throw new Failure('event_get_revisions never ended its pages');
    },
    /** Starts an Event with one user Account and returns {id, version, accountId}. */
    async newEvent(label = 'Event', more = {}) {
      const receipt = await t.note(t.unique(label), more);
      return { id: receipt.eventId, version: receipt.version, accountId: receipt.accountId, receipt };
    },
  };
  return t;
}
