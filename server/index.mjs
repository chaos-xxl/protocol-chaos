#!/usr/bin/env node
// The Protocol Chaos reference server: draft 0.2, levels Core, Entities, Search, Sync, Undo
// and Remote, keeping the repository in one JSON file (store.mjs).
//
//   protocol-chaos [--data <directory>] [--client <name>] [--tools <groups>] [--owner-tools]
//                  [--instructions-in-tools]                                     MCP over stdio (§9.1)
//   protocol-chaos --http [<host>:]<port> [--tls-cert <file> --tls-key <file>]
//                  [--data <directory>] [--tools <groups>] [--owner-tools]        MCP over HTTP (§9.2)
//   protocol-chaos clients add <name> [--tools <groups>] | tools <name> <groups>|default
//                  | list | remove <name> [--data <directory>]
//   protocol-chaos init | uninstall | doctor   connect the agents on this machine (install.mjs)
//   protocol-chaos organize --pending | --sweep | --status   organizing in the background (organize.mjs)
//   protocol-chaos import [--yes] | --status | --undo   import other assistants' memories (memories.mjs)
//
// --data         where the repository lives; default $PROTOCOL_CHAOS_DATA, then ~/.protocol-chaos
// --client       over stdio, the name of the assistant on the other end, such as codex: the
//                instructions tell it to write as {"kind": "agent", "id": <name>}, and writes
//                as anyone else are refused, as over HTTP. Without it, any actor is accepted.
// --tools        which tool groups a connection is offered, so that an assistant's model is
//                not handed definitions it never uses: a comma-separated list of groups
//                (read, record, fields, links, history, sync, entities, owner) and profiles
//                (assistant, writer, all). Default: all. Over HTTP a client can have its own
//                list (clients add --tools, clients tools); the server's levels are those of
//                everything it can offer.
// --instructions-in-tools  also put the server's instructions at the start of the description
//                of context_pack, for clients that show their model the tools but not the
//                instructions and have no file of standing instructions (Claude Desktop).
// --owner-tools  also offer repository_export and repository_import. An export holds
//                everything, so they are off unless the owner asks (§8.6, §10); the
//                conformance tests use them. Without them, the file itself is the export.
// --http         serve MCP streamable HTTP at /mcp instead of stdio. Each client needs a
//                token from `clients add`, and writes only as {"kind": "agent", "id": <its name>}.
//                Plain HTTP only on a loopback address; otherwise give --tls-cert and --tls-key.
//
// Over stdio nothing but MCP messages is written to stdout. Nothing that is said is logged.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { CLIENT_NAME, Clients } from './clients.mjs';
import { isLoopback, parseListen, PATH, serveHttp } from './http.mjs';
import { instructions } from './instructions.mjs';
import { importOffer, memoriesTool } from './memories.mjs';
import { ORGANIZER_ACTOR, queueFold, readOrganizer } from './organize.mjs';
import { Store } from './store.mjs';
import { ACCOUNT_SOURCES, ACTOR_KINDS, ProtocolError, STATES } from './validate.mjs';

const args = process.argv.slice(2);
const VALUED = ['--data', '--http', '--tls-cert', '--tls-key', '--tools', '--client'];
// The installer and the organizer have flags of their own and parse their arguments themselves.
// The command is the first word that is not a flag's value: the launcher puts --data first.
const commandAt = args.findIndex((arg, index) => !arg.startsWith('-') && !VALUED.includes(args[index - 1]));
const rest = commandAt < 0 ? [] : [...args.slice(0, commandAt), ...args.slice(commandAt + 1)];
if (['init', 'uninstall', 'doctor'].includes(args[commandAt])) {
  const { runInstaller } = await import('./install.mjs');
  process.exit(await runInstaller(args[commandAt], rest));
}
if (args[commandAt] === 'organize') {
  const { runOrganize } = await import('./organize.mjs');
  process.exit(await runOrganize(rest));
}
if (args[commandAt] === 'import') {
  const { runImportCommand } = await import('./memories.mjs');
  process.exit(await runImportCommand(rest));
}
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const usage = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};
for (const name of VALUED) {
  if (args.includes(name) && (!option(name) || option(name).startsWith('--'))) usage(`${name} needs a value`);
}
const positional = [];
for (let index = 0; index < args.length; index += 1) {
  if (VALUED.includes(args[index])) index += 1;
  else if (!args[index].startsWith('--')) positional.push(args[index]);
}
const directory = resolve(option('--data') ?? process.env.PROTOCOL_CHAOS_DATA ?? join(homedir(), '.protocol-chaos'));
const ownerTools = args.includes('--owner-tools');
const instructionsInTools = args.includes('--instructions-in-tools');

// Tool groups (§9.1 lets a server offer a connection only some of its operations). Profiles
// name the usual choices: an assistant whose words an organizer folds into fields later, an
// assistant that brings the fields up to date itself, and everything. People and places are
// an add-on to either, such as "writer,entities": their four tools are as long as all the rest.
const GROUPS = ['read', 'record', 'fields', 'links', 'history', 'sync', 'entities', 'owner'];
const PROFILES = {
  assistant: ['read', 'record'],
  writer: ['read', 'record', 'fields'],
  all: GROUPS,
};
/** A comma-separated list of groups and profiles, as groups in a fixed order; throws on an unknown name. */
function parseTools(list) {
  const chosen = new Set();
  for (const name of String(list).split(',').map((part) => part.trim()).filter(Boolean)) {
    if (Object.hasOwn(PROFILES, name)) PROFILES[name].forEach((group) => chosen.add(group));
    else if (GROUPS.includes(name)) chosen.add(name);
    else throw new Error(`Unknown tool group "${name}". Groups: ${GROUPS.join(', ')}. Profiles: ${Object.keys(PROFILES).join(', ')}.`);
  }
  if (chosen.size === 0) throw new Error('A tool list needs at least one group or profile.');
  return GROUPS.filter((group) => chosen.has(group));
}
let toolsOption;
try {
  toolsOption = option('--tools') === undefined ? undefined : parseTools(option('--tools'));
} catch (error) {
  usage(error.message);
}

if (positional[0] === 'clients') clientsCommand(positional.slice(1));
if (positional.length) usage(`Unknown command: ${positional.join(' ')}. Commands: init | uninstall | doctor | organize | import | clients add <name> | tools <name> <groups> | list | remove <name>.`);
const stdioClient = option('--client');
if (stdioClient !== undefined && option('--http')) usage('--client is for stdio. Over HTTP every token names its client (clients add <name>).');
if (stdioClient !== undefined && !CLIENT_NAME.test(stdioClient)) usage(`--client takes a name of lowercase letters, digits, ".", "_" and "-", such as codex; got "${stdioClient}"`);

/** `protocol-chaos clients …`: manages the tokens of the Remote level, then exits. */
function clientsCommand([action, name, ...rest]) {
  const clients = new Clients(directory);
  const say = (text) => process.stdout.write(`${text}\n`);
  try {
    if (action === 'add' && name && !rest.length) {
      const token = clients.add(name, toolsOption);
      say(`Created the client "${name}". Its token, shown only this once:\n\n  ${token}\n`);
      say(`Give it to that assistant as a bearer token (Authorization: Bearer <token>). It writes as {"kind": "agent", "id": "${name}"}.`);
      if (toolsOption) say(`It is offered the tool groups ${toolsOption.join(', ')}.`);
      say(`To revoke it: protocol-chaos clients remove ${name}`);
    } else if (action === 'tools' && name && rest.length === 1) {
      const tools = rest[0] === 'default' ? undefined : parseTools(rest[0]);
      if (!clients.setTools(name, tools)) {
        process.stderr.write(`There is no client named "${name}".\n`);
        process.exit(1);
      }
      say(tools ? `The client "${name}" is offered the tool groups ${tools.join(', ')}.` : `The client "${name}" is offered the server's tools.`);
    } else if (action === 'list' && !name) {
      const list = clients.list();
      say(list.length ? list.map((client) => `${client.name}  (created ${client.createdAt}${client.tools ? `; tools ${client.tools.join(', ')}` : ''})`).join('\n') : 'No clients.');
    } else if (action === 'remove' && name && !rest.length) {
      if (!clients.remove(name)) {
        process.stderr.write(`There is no client named "${name}".\n`);
        process.exit(1);
      }
      say(`Removed the client "${name}". Its token no longer works.`);
    } else {
      usage('Usage: protocol-chaos clients add <name> [--tools <groups>] | tools <name> <groups>|default | list | remove <name> [--data <directory>]');
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

const store = new Store(directory);

const VERBATIM = "text is the user's own words, unchanged (the part about this Event), never a summary or a paraphrase such as \"The user confirmed…\". Interpretation goes in the fields.";

const VERBATIM_ENTITY = "text and accountText are the user's own words, unchanged (the part about this Entity); Statements are your one-fact reading of them, and an inference carries its basis.";

// The MCP instructions (instructions.mjs) name the client when its name is known.

// ---- input schemas (documentation; the server validates every input itself) ----
// Kept short: every connection sends these definitions to its model with every request.

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const actor = {
  type: 'object',
  description: 'You: {"kind": "agent", "id": <your name>}. Never the owner or another writer.',
  properties: { kind: { type: 'string', enum: ACTOR_KINDS }, id: { type: 'string', minLength: 1 }, label: { type: 'string' } },
  required: ['kind', 'id'],
  additionalProperties: false,
};
const text = { type: 'string', minLength: 1, description: "The user's words, verbatim." };
const accountSource = {
  type: 'string', enum: ACCOUNT_SOURCES,
  description: 'user (default); agent_response for your own sentence, such as an inference; authorized_external for words relayed from an app the user authorized.',
};
const via = { type: 'string', description: 'Where the words came from, when not from this conversation.' };
const eventId = { type: 'string', description: 'An Event id.' };
const expectedVersion = { type: 'integer', description: 'The version from your last read or receipt.' };
const factValue = nullable({ type: 'string', minLength: 1 });
const set = {
  type: 'object',
  description: 'The fields to replace. Each replaces the stored one whole: give its complete current content, carrying over what still holds; null removes it.',
  properties: {
    title: nullable({ type: 'string', minLength: 1, maxLength: 80 }),
    state: { type: 'string', enum: STATES },
    progress: nullable({
      type: 'object', description: 'Where it stands now.',
      properties: {
        text: { type: 'string', minLength: 1 },
        timestamp: { type: 'string', description: 'When it was said, in UTC ending in Z, such as 2026-03-14T09:30:00.000Z. Default: now.' },
      },
      required: ['text'], additionalProperties: false,
    }),
    facts: nullable({
      type: 'object', description: 'goal, constraint and plan go here, never directly in set. Each key given replaces that fact; null removes it.',
      properties: {
        goal: { ...factValue, description: 'What it is for, and what would count as done.' },
        constraint: { ...factValue, description: 'Limits, budgets, deadlines, wishes.' },
        plan: { ...factValue, description: 'What is decided: when, where, how, which option.' },
      },
      additionalProperties: false,
    }),
    refs: nullable({
      type: 'array', description: "Who and what it involves, the complete list: {criteria} in the user's words, or {ref}, an Entity id (never the owner).",
      items: {
        anyOf: [
          { type: 'object', properties: { criteria: { type: 'string', minLength: 1 } }, required: ['criteria'], additionalProperties: false },
          { type: 'object', properties: { ref: { type: 'string', minLength: 1 } }, required: ['ref'], additionalProperties: false },
        ],
      },
    }),
    metadata: nullable({ type: 'object', description: 'Extension data, replaced as a whole.', additionalProperties: true }),
  },
  additionalProperties: false,
};
const linkSchema = {
  type: 'object',
  properties: {
    childEventId: eventId,
    parentEventId: eventId,
    actor,
    sourceAccountIds: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Accounts of the child or the parent that the link rests on.' },
    expectedVersion: { ...expectedVersion, description: "The child's version." },
  },
  required: ['childEventId', 'parentEventId', 'actor', 'sourceAccountIds'],
  additionalProperties: false,
};
const partialTime = { type: 'string', description: 'YYYY, YYYY-MM, YYYY-MM-DD or an RFC 3339 date-time.' };
const newStatement = {
  type: 'object',
  description: 'One fact about the Entity.',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 200, description: 'One fact, with absolute dates.' },
    topic: { type: 'string', minLength: 1, description: 'identity, home, family, work, skills, education, personality, beliefs, preferences, interests, taste, food, habits, health, finance, accounts, relationship or details.' },
    basis: { type: 'string', minLength: 1, description: 'For an inference: what it rests on.' },
    saidAt: partialTime,
    validFrom: partialTime,
    validTo: { ...partialTime, description: 'When it stops holding.' },
    sensitivity: { type: 'string', enum: ['normal', 'private', 'sensitive'], description: 'sensitive ones never appear in summaries.' },
    inSummary: { type: 'boolean', description: 'Whether it belongs in the short summary.' },
  },
  required: ['text', 'topic'],
  additionalProperties: false,
};
const statementIds = { type: 'array', items: { type: 'string' } };
const write = { readOnlyHint: false, destructiveHint: false };
const read = { readOnlyHint: true };

// Each tool runs against the repository the store hands it: the store reloads the file
// when another process changed it, so the repository object is not fixed. `group` is the
// tool group (--tools) it belongs to.
const TOOLS = [
  {
    name: 'event_note',
    group: 'record',
    description: `Record the user's words on an Event, or start an Event with them; changes nothing else. With eventId the words are added (and the title, if it has none); without it a new emerging Event starts, with a title that names it on its own and, for a part of a larger Event, parentEventId. Check the directory or search first, so that one matter does not become two. ${VERBATIM} Returns a receipt.`,
    inputSchema: {
      type: 'object',
      properties: {
        actor, text, accountSource, via, eventId,
        title: { type: 'string', minLength: 1, maxLength: 80, description: 'A name that identifies it on its own, with when or which.' },
        parentEventId: { ...eventId, description: 'For a new Event: the larger Event it is part of.' },
      },
      required: ['actor', 'text'],
      additionalProperties: false,
    },
    annotations: write,
    run: (repo, args) => repo.eventNote(args),
  },
  {
    name: 'event_record_expression',
    group: 'fields',
    description: `Record words together with the changes they support, in one atomic write: title, state, progress, facts (goal, constraint, plan), refs, metadata. To ground the changes on words already recorded, pass that Account's accountId and its exact text. Needs expectedVersion. Mark your own inferences in the text of a fact, with their basis. ${VERBATIM} Returns a receipt.`,
    inputSchema: {
      type: 'object',
      properties: { eventId, actor, text, accountSource, via, expectedVersion, accountId: { type: 'string', description: 'An Account of this Event that the changes rest on.' }, set },
      required: ['eventId', 'actor', 'text'],
      additionalProperties: false,
    },
    annotations: write,
    run: (repo, args) => repo.recordExpression(args),
  },
  {
    name: 'event_add_parent',
    group: 'links',
    description: 'Link an Event as part of a larger one, only when it plainly is, or is a step toward it (two separate trips are siblings). Ground the link on Accounts of either. Returns the child\'s {eventId, version, parents}.',
    inputSchema: linkSchema,
    annotations: write,
    run: (repo, args) => repo.addParent(args),
  },
  {
    name: 'event_remove_parent',
    group: 'links',
    description: 'Remove the link that makes an Event part of another, grounded on Accounts of either. Returns the child\'s {eventId, version, parents}.',
    inputSchema: linkSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (repo, args) => repo.removeParent(args),
  },
  {
    name: 'event_get_protocol',
    group: 'read',
    description: 'Read one Event: {event, accounts, entities?}, its document, its most recent Accounts (default 20, or "all"), oldest first, and the Entities its refs name.',
    inputSchema: {
      type: 'object',
      properties: { eventId, accounts: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string', enum: ['all'] }] } },
      required: ['eventId'],
      additionalProperties: false,
    },
    annotations: read,
    run: (repo, args) => repo.getProtocol(args),
  },
  {
    name: 'context_pack',
    group: 'read',
    description: 'The directory: every Event in brief (id, title, state, parents, progress, updatedAt), most recently updated first; decide from it what to read. sinceVersion tells whether anything changed; filter by state (also "open" or "closed"); page with limit and cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceVersion: { type: 'string' },
        state: { type: 'string', enum: [...STATES, 'open', 'closed'] },
        limit: { type: 'integer', minimum: 1 },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: read,
    run: (repo, args) => repo.contextPack(args),
  },
  {
    name: 'event_get_revisions',
    group: 'history',
    description: 'The history of an Event: its Revisions in commit order. Page with limit and after.',
    inputSchema: {
      type: 'object',
      properties: { eventId, after: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
      required: ['eventId'],
      additionalProperties: false,
    },
    annotations: read,
    run: (repo, args) => repo.getRevisions(args),
  },
  {
    name: 'event_search',
    group: 'read',
    description: 'Find Events by words, not meaning: titles containing the query first, then facts, progress, refs and recorded words. Search before starting an Event. Filter by state; limit caps the results. Returns {events}, as in the directory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        state: { type: 'string', enum: [...STATES, 'open', 'closed'] },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: read,
    run: (repo, args) => repo.search(args),
  },
  {
    name: 'event_words_since',
    group: 'sync',
    description: 'The words recorded since a timestamp, by Event, with each Event\'s current fields, to fold them in later. Returns {version, checkpoint, remaining, events}; pass checkpoint as the next since. limit is the number of Events per batch.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'A timestamp, such as the previous checkpoint.' },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['since'],
      additionalProperties: false,
    },
    annotations: read,
    run: (repo, args) => repo.wordsSince(args),
  },
  {
    name: 'event_undo_revision',
    group: 'history',
    description: 'Undo the latest change (fields or a link) of an Event that is not undone yet; Events and words are never removed. After another writer\'s change it fails with REVISION_NOT_REVERSIBLE: read again. Returns the new Revision.',
    inputSchema: {
      type: 'object',
      properties: { revisionId: { type: 'string', description: 'From event_get_revisions.' }, actor },
      required: ['revisionId', 'actor'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (repo, args) => repo.undoRevision(args),
  },
  {
    name: 'entity_search',
    group: 'entities',
    description: 'Find people, animals, things and places (Entities) by name, alias or Statement; search before creating one. Omit query to list all; filter by kind. Returns {entities}: {id, kind, name, aliases?, owner?, version, statements}.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        kind: { type: 'string', minLength: 1, description: 'person, animal, thing or place.' },
        limit: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    annotations: read,
    run: (repo, args) => repo.entitySearch(args),
  },
  {
    name: 'entity_get',
    group: 'entities',
    description: 'Read an Entity: an id, or "current_user" for the user. view "summary": the short list for every conversation; "full" (default): every current Statement, with includeHistory the outdated ones, with includeEvents the Events naming it; topics narrows it.',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string' },
        view: { type: 'string', enum: ['summary', 'full'] },
        topics: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        includeHistory: { type: 'boolean' },
        includeEvents: { type: 'boolean' },
      },
      required: ['entityId'],
      additionalProperties: false,
    },
    annotations: read,
    run: (repo, args) => repo.entityGet(args),
  },
  {
    name: 'entity_create',
    group: 'entities',
    description: `Create an Entity only for one specific person, animal, thing or place that recurs and has facts to keep; otherwise use a {criteria} ref. Search first. accountText: the words it rests on; statements: its first facts. owner: true only for the user's own Entity. ${VERBATIM_ENTITY} Returns {entityId, version, accountId, added}.`,
    inputSchema: {
      type: 'object',
      properties: {
        actor, kind: { type: 'string', minLength: 1, description: 'person, animal, thing or place.' },
        name: { type: 'string', minLength: 1, description: 'What the user calls it.' },
        accountText: text,
        accountSource, via,
        aliases: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Other names, each once.' },
        owner: { type: 'boolean' },
        statements: { type: 'array', items: newStatement },
      },
      required: ['actor', 'kind', 'name', 'accountText'],
      additionalProperties: false,
    },
    annotations: write,
    run: (repo, args) => repo.entityCreate(args),
  },
  {
    name: 'entity_record',
    group: 'entities',
    description: `Record words about an Entity with what they change: name, aliases (the complete list), add (new Statements, which may supersede or conflictsWith others), update (status, reason, sensitivity, inSummary) and support. Saying the same thing again adds evidence. Only the user's own words may supersede, or change the status of, a Statement resting on the user's words (USER_WORDS_PROTECTED): add yours with conflictsWith. Needs expectedVersion, the Entity's. ${VERBATIM_ENTITY} Returns {entityId, version, accountId, added?, merged?, changed?, supported?}.`,
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string' },
        actor, text, accountSource, via,
        expectedVersion: { type: 'integer', description: "The Entity's version from your last read or write." },
        name: { type: 'string', minLength: 1 },
        aliases: { type: 'array', items: { type: 'string', minLength: 1 } },
        add: { type: 'array', items: { ...newStatement, properties: { ...newStatement.properties, supersedes: statementIds, conflictsWith: statementIds } } },
        update: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              statementId: { type: 'string' },
              status: { type: 'string', enum: ['current', 'outdated', 'disputed'] },
              reason: { type: 'string', minLength: 1 },
              sensitivity: { type: 'string', enum: ['normal', 'private', 'sensitive'] },
              inSummary: { type: 'boolean' },
            },
            required: ['statementId'],
            additionalProperties: false,
          },
        },
        support: statementIds,
      },
      required: ['entityId', 'actor', 'text'],
      additionalProperties: false,
    },
    annotations: write,
    run: (repo, args) => repo.entityRecord(args),
  },
  {
    name: 'repository_export',
    group: 'owner',
    description: 'For the owner only: the whole repository, in the draft-0.2 export format. Never for an agent task: an export holds everything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: read,
    run: (repo, args) => repo.exportRepository(args),
  },
  {
    name: 'repository_import',
    group: 'owner',
    description: 'For the owner only: import an export ({snapshot}) into an empty repository (otherwise REPOSITORY_NOT_EMPTY). If any check fails, nothing is imported.',
    inputSchema: {
      type: 'object',
      properties: { snapshot: { type: 'object' } },
      required: ['snapshot'],
      additionalProperties: false,
    },
    annotations: write,
    run: (repo, args) => repo.importRepository(args),
  },
];

// The import of other assistants' memories (memories.mjs): offered only to a connection from
// this machine that records words, and only while there is an import to offer, follow or report.
const IMPORT_TOOL = {
  name: 'memories_import',
  description: "Offered only while memories that other assistants keep on this machine wait to be imported, are being imported, or wait to be reported. Once per conversation, in your first reply, call it with action status and follow what it returns: it says what to tell the user and what to do next. start or decline only on the user's answer; record hands back a part of an import that runs in this conversation; finish once the report is shown.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'start', 'decline', 'record', 'finish'] },
      sources: { type: 'array', items: { type: 'string' }, description: 'For start: only these assistants, by the ids in the plan.' },
      part: { type: 'integer', minimum: 1, description: 'For record: the number of the part the matters are from.' },
      matters: { type: 'array', items: { type: 'object' }, description: 'For record: the matters the part shows, as its instructions say.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};

// After a note, where nobody organizes in the background (init found no agent that can run
// headless, or organizing was turned off), the assistant brings the fields up to date itself.
const FIELDS_HINT = 'Nobody organizes this repository in the background on this machine, so bring the Event up to date yourself: when these words establish its title, state, progress, goal, constraint, plan or refs, call event_record_expression with the accountId and text of this receipt, its version as expectedVersion, and each changed field\'s complete new content.';
const managedByInit = () => existsSync(join(directory, 'installed.json'));

/** The tools a connection is offered: those of its groups; the owner's only with --owner-tools. */
const serverTools = toolsOption ?? GROUPS;
const offerings = new Map();
function offeringFor(groups) {
  const key = groups.join(',');
  if (!offerings.has(key)) {
    const tools = TOOLS.filter((tool) => groups.includes(tool.group) && (tool.group !== 'owner' || ownerTools));
    offerings.set(key, { tools, byName: new Map(tools.map((tool) => [tool.name, tool])) });
  }
  return offerings.get(key);
}
/** A client's own groups (clients.json), unknown names left out; the server's when it has none. */
let registry;
function groupsOf(client) {
  const own = client && registry ? registry.toolsOf(client)?.filter((group) => GROUPS.includes(group)) : undefined;
  return own?.length ? GROUPS.filter((group) => own.includes(group)) : serverTools;
}

// §9.2: over a remote connection every write is bound to the authenticated client, and the
// writes that change fields or parents must say which version they saw.
const VERSIONED = new Set(['event_record_expression', 'event_add_parent', 'event_remove_parent', 'entity_record']);
const wellFormed = (actor) => actor !== null && typeof actor === 'object' && ACTOR_KINDS.includes(actor.kind)
  && typeof actor.id === 'string' && actor.id.trim() !== '';
// A stdio connection started with --client is bound to that name the same way, without the
// version rule: it runs on the machine that holds the repository.
function checkClient(tool, input, client, remote) {
  if (tool.annotations.readOnlyHint) return;
  // A malformed actor is left to validation (VALIDATION_ERROR); a well-formed one must be the client.
  if (wellFormed(input.actor) && (input.actor.kind !== 'agent' || input.actor.id !== client)) {
    throw new ProtocolError('ACTOR_MISMATCH', `This connection is ${remote ? 'authenticated as' : 'started for'} the client "${client}": write as {"kind": "agent", "id": "${client}"}. Nothing was changed.`);
  }
  if (remote && VERSIONED.has(tool.name) && (input.expectedVersion === undefined || input.expectedVersion === null)) {
    throw new ProtocolError('VERSION_REQUIRED', `Over a remote connection, ${tool.name} needs expectedVersion: the version from your last read or receipt. Nothing was changed.`);
  }
}

const { version } = createRequire(import.meta.url)('../package.json');
const SERVER_ENTRY = fileURLToPath(import.meta.url);

// Whether the HTTP server listens on a loopback address: its clients are then on this machine.
let loopbackHttp = false;

/** One MCP server: for stdio, the only one; over HTTP, one per request, bound to its client. */
function createServer({ client, remote = true } = {}) {
  const groups = groupsOf(remote ? client : undefined);
  const { tools: offered, byName } = offeringFor(groups);
  // The import reads files on this machine, so only a connection from this machine is offered it.
  const importing = (!remote || loopbackHttp) && groups.includes('record') && client !== ORGANIZER_ACTOR;
  const server = new Server(
    { name: 'protocol-chaos-reference', version },
    { capabilities: { tools: {} }, instructions: instructions(client, { importStatus: importing ? importOffer(directory) : undefined }) },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const status = importing ? importOffer(directory) : undefined;
    // For a client that shows tools but not the instructions, the instructions open the directory's description.
    const describe = (name, description) => (instructionsInTools && name === 'context_pack'
      ? `How to use this server (its instructions, which this client does not show otherwise):\n\n${instructions(client, { importStatus: status })}\n\nThe tool: ${description}`
      : description);
    return {
      tools: [...offered, ...(status ? [IMPORT_TOOL] : [])]
        .map(({ name, description, inputSchema, annotations }) => ({ name, description: describe(name, description), inputSchema, annotations })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const input = request.params.arguments ?? {};
    if (importing && request.params.name === IMPORT_TOOL.name) {
      try {
        const body = await memoriesTool(directory, input, { entry: SERVER_ENTRY, store });
        return { content: [{ type: 'text', text: JSON.stringify(body) }] };
      } catch (error) {
        const body = error instanceof ProtocolError
          ? { code: error.code, message: error.message }
          : { code: 'INTERNAL_ERROR', message: `The import failed unexpectedly (${error.message}). Call status.` };
        return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
      }
    }
    const tool = byName.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    let body;
    let isError = false;
    try {
      if (client) checkClient(tool, input, client, remote);
      body = tool.annotations.readOnlyHint
        ? store.read((repo) => tool.run(repo, input))
        : await store.write((repo) => tool.run(repo, input));
    } catch (error) {
      isError = true;
      body = error instanceof ProtocolError
        ? { code: error.code, message: error.message }
        : { code: 'INTERNAL_ERROR', message: 'The server failed unexpectedly; nothing was changed. Retry, and report it if it persists.' };
    }
    const result = { content: [{ type: 'text', text: JSON.stringify(body) }] };
    // Recorded words are folded into their matter in the background, when init chose an organizer;
    // where init found none, the assistant is reminded to fold them itself.
    if (!isError && tool.name === 'event_note') {
      const queued = queueFold({ directory, eventId: body.eventId, accountId: body.accountId, client, entry: SERVER_ENTRY });
      if (!queued && !remote && client && client !== 'hermes' && groups.includes('fields') && managedByInit() && !readOrganizer(directory)) {
        result.content.push({ type: 'text', text: FIELDS_HINT });
      }
    }
    if (isError) result.isError = true;
    return result;
  });

  return server;
}

if (option('--http')) {
  const listen = parseListen(option('--http'));
  if (!listen) usage('--http takes a port, or host:port, such as 127.0.0.1:8721');
  const cert = option('--tls-cert');
  const key = option('--tls-key');
  if (Boolean(cert) !== Boolean(key)) usage('--tls-cert and --tls-key go together');
  if (!cert && !isLoopback(listen.host)) {
    usage(`Refused: ${listen.host} can be reached from other machines, and a remote server must use TLS (§9.2). Give --tls-cert and --tls-key, or listen on 127.0.0.1 behind a TLS reverse proxy.`);
  }
  const clients = new Clients(directory);
  registry = clients;
  loopbackHttp = isLoopback(listen.host);
  let httpServer;
  try {
    httpServer = await serveHttp({
      listen, tls: cert ? { cert, key } : undefined, clients, createServer,
      // A full import is sent in one request, so the owner tools allow far larger bodies.
      maxBody: ownerTools ? 64 * 1024 * 1024 : 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write(`Could not listen on ${option('--http')}: ${error.message}\n`);
    process.exit(1);
  }
  const host = listen.host.includes(':') ? `[${listen.host}]` : listen.host;
  const count = clients.list().length;
  process.stderr.write(`Protocol Chaos reference server ${version} at ${cert ? 'https' : 'http'}://${host}:${httpServer.address().port}${PATH}, `
    + `repository ${directory}, ${count} client${count === 1 ? '' : 's'}${toolsOption ? `, tools ${toolsOption.join(',')} unless a client has its own` : ''}`
    + `${ownerTools ? ', owner tools on: every client offered the owner group can export the whole repository' : ''}\n`);
  if (!count) process.stderr.write('No clients yet, so every request is refused. Create one with: protocol-chaos clients add <name>\n');
  const stop = () => {
    httpServer.close(() => process.exit(0));
    httpServer.closeAllConnections?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  await createServer({ client: stdioClient, remote: false }).connect(new StdioServerTransport());
}
