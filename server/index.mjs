#!/usr/bin/env node
// The Protocol Chaos reference server: draft 0.2, levels Core, Entities, Search, Sync and
// Undo, over MCP stdio (§9.1), keeping the repository in one JSON file (store.mjs).
//
//   node server/index.mjs [--data <directory>] [--owner-tools]
//
// --data         where the repository lives; default $PROTOCOL_CHAOS_DATA, then ~/.protocol-chaos
// --owner-tools  also offer repository_export and repository_import. An export holds
//                everything, so they are off unless the owner asks (§8.6, §10); the
//                conformance tests use them. Without them, the file itself is the export.
//
// Nothing but MCP messages is written to stdout, and nothing is logged.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Store } from './store.mjs';
import { ACCOUNT_SOURCES, ACTOR_KINDS, ProtocolError, STATES } from './validate.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dataOption = option('--data');
if (args.includes('--data') && !dataOption) {
  process.stderr.write('--data needs a directory\n');
  process.exit(2);
}
const directory = resolve(dataOption ?? process.env.PROTOCOL_CHAOS_DATA ?? join(homedir(), '.protocol-chaos'));
const ownerTools = args.includes('--owner-tools');
const store = new Store(directory);

const VERBATIM = "Verbatim rule: text is the user's actual words, trimmed and otherwise unchanged, never a summary or a third-person paraphrase such as \"The user confirmed…\"; when a message covers several Events, pass the part about this Event, still in the user's words. Interpretation belongs in the fields.";

const VERBATIM_ENTITY = "Verbatim rule: the words (text, accountText) are the user's actual words, trimmed and otherwise unchanged, never a summary or a third-person paraphrase; pass the part about this Entity. Statements are your one-fact interpretation; mark an inference with basis.";

// The template from docs/agent-guide.md, under 2,000 characters because some clients cut
// longer instructions. The rules it leaves out are in the tool descriptions.
const INSTRUCTIONS = [
  "This server holds the user's Events: the long-lived matters they tell their assistants about (trips, plans, purchases, ambitions), and the people and places involved. It outlives conversations, assistants and machines. It exists to organise what the user said, not to make Events complete.",
  'READ ON YOUR SIDE. Answer from what the conversation holds. When the answer depends on the user\'s own matters, use the directory (context_pack) to decide which Events matter, and read only those by id. Never send unrelated messages.',
  'RECORD AFTER. After answering, record only words that change an Event (its title, state, progress, goal, constraint, plan, refs or parents) or start one: an intention, plan, commitment, purchase, trip, target or arrangement that outlasts the conversation. One event_note with the user\'s words and the most specific Event\'s id; for a new Event, a title that names it on its own and parentEventId when it belongs under one. Never questions, hypotheticals, requests for work, fragments such as a meal or a workout, or your own calculations; but do record a feeling, news or progress said along with them.',
  "VERBATIM. Account text is the user's actual sentence, never a summary. Mark your inferences with their basis; the user's words win.",
  'YOUR NAME. Write as yourself (actor), never as the user or another assistant.',
  "DON'T ASK TO TIDY. Do not ask the user to fill in details or approve the organisation; ask only before an irreversible or outward action.",
].join('\n\n');

// ---- input schemas (documentation; the server validates every input itself) ----

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const actor = {
  type: 'object',
  description: 'Who is writing: your own identity, e.g. {"kind": "agent", "id": "laptop"}. Never the owner or another writer.',
  properties: { kind: { type: 'string', enum: ACTOR_KINDS }, id: { type: 'string', minLength: 1 }, label: { type: 'string' } },
  required: ['kind', 'id'],
  additionalProperties: false,
};
const text = { type: 'string', minLength: 1, description: "The user's actual words, verbatim. Never a summary or a third-person paraphrase." };
const accountSource = {
  type: 'string', enum: ACCOUNT_SOURCES,
  description: 'Whose words they are: user (default), agent_response (your own sentence, such as an inference) or authorized_external (relayed from an application the user authorized).',
};
const via = { type: 'string', description: 'Where the words came from when they were not said in this conversation, e.g. "example-export".' };
const eventId = { type: 'string', description: 'An Event id from the directory or a receipt.' };
const expectedVersion = { type: 'integer', description: "The Event's version from your last read or receipt. On VERSION_CONFLICT, read again and reconsider." };
const factValue = nullable({ type: 'string', minLength: 1, description: 'One sentence or paragraph, clear on its own; null removes the fact.' });
const set = {
  type: 'object',
  description: 'Fields to replace, each with its complete current content; null removes a field. Inside facts, each supplied key replaces that fact and the others are unchanged.',
  properties: {
    title: nullable({ type: 'string', minLength: 1, maxLength: 80 }),
    state: { type: 'string', enum: STATES },
    progress: nullable({
      type: 'object', description: 'Where the Event stands now. timestamp defaults to now.',
      properties: { text: { type: 'string', minLength: 1 }, timestamp: { type: 'string' } },
      required: ['text'], additionalProperties: false,
    }),
    facts: nullable({
      type: 'object',
      properties: {
        goal: { ...factValue, description: 'What the Event is meant to achieve, including what would count as done.' },
        constraint: { ...factValue, description: 'Conditions it must meet: limits, deadlines, budgets, wishes and preferences.' },
        plan: { ...factValue, description: 'The arrangement as currently decided: when, where, how, which option.' },
      },
      additionalProperties: false,
    }),
    refs: nullable({
      type: 'array', description: 'The people, places and things it involves; the complete new list. Each entry is {criteria} (a description in the user\'s terms, such as "my sister") or {ref} (the id of an existing Entity, never the owner). An empty list or null removes refs.',
      items: {
        anyOf: [
          { type: 'object', properties: { criteria: { type: 'string', minLength: 1 } }, required: ['criteria'], additionalProperties: false },
          { type: 'object', properties: { ref: { type: 'string', minLength: 1, description: 'An Entity id from entity_search or entity_create.' } }, required: ['ref'], additionalProperties: false },
        ],
      },
    }),
    metadata: nullable({ type: 'object', description: 'Extension data: namespaced keys (dev.example/flag) to JSON values, replaced as a whole. An empty object or null removes it.', additionalProperties: true }),
  },
  additionalProperties: false,
};
const linkSchema = {
  type: 'object',
  properties: {
    childEventId: eventId,
    parentEventId: eventId,
    actor,
    sourceAccountIds: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'At least one Account of the child or of the parent that the link rests on.' },
    expectedVersion: { ...expectedVersion, description: "The child's version." },
  },
  required: ['childEventId', 'parentEventId', 'actor', 'sourceAccountIds'],
  additionalProperties: false,
};
const partialTime = { type: 'string', description: 'YYYY, YYYY-MM, YYYY-MM-DD or an RFC 3339 date-time.' };
const newStatement = {
  type: 'object',
  description: 'A new Statement: one fact about the Entity.',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 200, description: 'One fact, in natural language, with absolute dates.' },
    topic: { type: 'string', minLength: 1, description: 'identity, home, family, work, skills, education, personality, beliefs, preferences, interests, taste, food, habits, health, finance, accounts (handles), relationship or details; other topics are accepted.' },
    basis: { type: 'string', minLength: 1, description: 'Only for an inference: what it rests on.' },
    saidAt: { ...partialTime, description: 'When it was said, if not now.' },
    validFrom: { ...partialTime, description: 'When it starts to hold.' },
    validTo: { ...partialTime, description: 'When it stops holding; after that it reads as outdated.' },
    sensitivity: { type: 'string', enum: ['normal', 'private', 'sensitive'], description: 'normal by default; sensitive Statements never appear in summaries.' },
    inSummary: { type: 'boolean', description: "Whether it belongs in the Entity's short summary. Default false." },
  },
  required: ['text', 'topic'],
  additionalProperties: false,
};
const statementIds = { type: 'array', items: { type: 'string' } };
const write = { readOnlyHint: false, destructiveHint: false };
const read = { readOnlyHint: true };

// Each tool runs against the repository the store hands it: the store reloads the file
// when another process changed it, so the repository object is not fixed.
const TOOLS = [
  {
    name: 'event_note',
    description: `Record the user's words on an Event, or start a new Event with them. Changes nothing else (it gives a title only to an Event that has none). With eventId the words are appended; without it a new Event starts in state emerging, optionally titled and placed under parentEventId. Check the directory first so one matter does not become two. ${VERBATIM} Returns a receipt.`,
    inputSchema: {
      type: 'object',
      properties: {
        actor, text, accountSource, via, eventId,
        title: { type: 'string', minLength: 1, maxLength: 80, description: 'For a new Event, or an Event without a title: a name that identifies it on its own.' },
        parentEventId: { ...eventId, description: 'For a new Event only: the larger Event it is part of.' },
      },
      required: ['actor', 'text'],
      additionalProperties: false,
    },
    annotations: write,
    run: (repo, args) => repo.eventNote(args),
  },
  {
    name: 'event_record_expression',
    description: `Record words together with the changes they support, atomically: set any of title, state, progress, facts (goal, constraint, plan), refs and metadata. To fold words recorded earlier into fields, pass that Account's accountId and its exact text instead of appending new words. Each supplied field replaces the stored one, so supply its complete current content and carry over what still holds; null removes a field. Mark your own inferences inside the fact text with their basis. ${VERBATIM} Returns a receipt.`,
    inputSchema: {
      type: 'object',
      properties: { eventId, actor, text, accountSource, via, expectedVersion, accountId: { type: 'string', description: 'An existing Account of this Event to ground the changes on.' }, set },
      required: ['eventId', 'actor', 'text'],
      additionalProperties: false,
    },
    annotations: write,
    run: (repo, args) => repo.recordExpression(args),
  },
  {
    name: 'event_add_parent',
    description: 'Link an Event (child) as part of a larger Event (parent). Link only when it is plainly part of it or a step toward it; two separate trips are siblings. Ground the link on Accounts of the child or of the parent. Adding an existing link changes nothing; a link that would close a cycle fails with PART_OF_CYCLE. Returns {eventId, version, parents} for the child.',
    inputSchema: linkSchema,
    annotations: write,
    run: (repo, args) => repo.addParent(args),
  },
  {
    name: 'event_remove_parent',
    description: 'Remove the link "child is part of parent", grounded on Accounts of the child or of the parent. Removing a link that does not exist fails with NOT_FOUND. Returns {eventId, version, parents} for the child.',
    inputSchema: linkSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (repo, args) => repo.removeParent(args),
  },
  {
    name: 'event_get_protocol',
    description: 'Read one Event: {event, accounts, entities?}, the document, its most recent Accounts (default 20, or "all"), oldest first, and, when its refs name Entities, those Entities as {id, kind, name}. History is read with event_get_revisions.',
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
    description: 'The directory: every Event in brief, {id, title?, state, parents, progress?, updatedAt}, most recently updated first, from which you decide what to read. Pass sinceVersion (the version you cached) to learn whether anything changed; filter by state (a state, "open" or "closed"); page with limit and cursor (pass next).',
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
    description: 'Read the history of an Event: its Revisions in commit order. Page with limit and after (pass next).',
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
    description: 'Find Events for a query you chose, such as the name of a matter, before creating one (so one matter does not become two). Matching is by words, not by meaning: every Event whose title contains the query (ignoring case) comes first, then Events whose facts, progress, refs or recorded words contain it, then Events that hold every word of the query. Returns {events} in brief, as in the directory, best matches first. Filter by state (a state, "open" or "closed"); limit caps the number returned.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'The words to look for, such as the name of a matter.' },
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
    description: 'The words recorded since a moment, for folding them into fields later or refreshing a cache. Returns {version, checkpoint, remaining, events}: each Event that gained Accounts after since, with its current title, state, facts, refs, progress and parents, and words, its new Accounts, oldest first. Pass checkpoint as the next since to continue; remaining counts the Accounts not yet returned. limit is the number of Events per batch (a batch never ends between two Accounts with the same createdAt). Going over the same words twice changes nothing, because each field write carries the complete current content.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'A timestamp such as 2026-03-14T09:30:00.000Z: the checkpoint of your previous call, or an early time to read every word.' },
        limit: { type: 'integer', minimum: 1, description: 'The number of Events per batch.' },
      },
      required: ['since'],
      additionalProperties: false,
    },
    annotations: read,
    run: (repo, args) => repo.wordsSince(args),
  },
  {
    name: 'event_undo_revision',
    description: 'Undo the latest change of an Event that has not been undone: a field.changed, parent.added or parent.removed Revision (words recorded since do not count). Events and words are never removed, so event.created and account.added cannot be undone, nor can an undo. Anything else fails with REVISION_NOT_REVERSIBLE, for example after another writer changed the Event: read it again and reconsider. Records a revision.reverted Revision and returns it; call again on the next change to walk further back.',
    inputSchema: {
      type: 'object',
      properties: { revisionId: { type: 'string', description: 'The Revision to undo, from event_get_revisions.' }, actor },
      required: ['revisionId', 'actor'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: (repo, args) => repo.undoRevision(args),
  },
  {
    name: 'entity_search',
    description: 'Find the people, animals, things and places the user refers to (Entities), for example before creating one, so that one does not become two. Every Entity whose name or an alias equals the query (ignoring case) comes first, then names and aliases that start with or contain it, then Entities whose Statements contain it. Omit query to list every Entity; filter by kind. Returns {entities}: cards {id, kind, name, aliases?, owner?, version, statements}, where statements counts the Statements that are not outdated.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'A name, alias or words to look for.' },
        kind: { type: 'string', minLength: 1, description: 'person, animal, thing or place (other kinds are kept as written).' },
        limit: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    annotations: read,
    run: (repo, args) => repo.entitySearch(args),
  },
  {
    name: 'entity_get',
    description: 'Read one Entity. entityId is an Entity id or "current_user" (the user\'s own Entity). view "summary" returns {entity, summary}: the short list of Statements meant to be loaded into every conversation (never sensitive ones). view "full" (default) returns {entity, statements}: the Statements that are not outdated, by topic, then by creation. includeHistory adds history (the outdated ones); includeEvents adds referencedBy (the Events whose refs name it); topics restricts the Statements returned.',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'An Entity id, or "current_user" for the owner.' },
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
    description: `Create an Entity: one specific person, animal, thing or place that recurs across Events or applications and has user-specific information to accumulate (otherwise use a {criteria} ref on the Event). Search first (entity_search). accountText holds the words it rests on; statements are its first facts, one fact each, 1 to 200 characters, with absolute dates. owner: true only for the user's own Entity (at most one). ${VERBATIM_ENTITY} Returns {entityId, version, accountId, added}.`,
    inputSchema: {
      type: 'object',
      properties: {
        actor, kind: { type: 'string', minLength: 1, description: 'person, animal, thing or place.' },
        name: { type: 'string', minLength: 1, description: 'What the user calls it.' },
        accountText: { ...text, description: "The user's actual words this Entity rests on, verbatim." },
        accountSource, via,
        aliases: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Other names; not the name itself, each once.' },
        owner: { type: 'boolean', description: "true only for the user's own Entity." },
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
    description: `Record words about an Entity together with what they change: name, aliases (the complete new list), add (new Statements; may supersede or conflict with existing ones), update (status, reason, sensitivity, inSummary of existing Statements) and support (existing Statements these words also support). Saying the same thing again is merged into the existing Statement as more evidence. A Statement resting on the user's words can be superseded, or its status changed, only by the user's own words (USER_WORDS_PROTECTED): add your version with conflictsWith instead. A disputed Statement becomes current again only by the user's words (USER_CONFIRMATION_REQUIRED). Carry expectedVersion (the Entity's). ${VERBATIM_ENTITY} Returns {entityId, version, accountId, added?, merged?, changed?, supported?}.`,
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'An Entity id, or "current_user" for the owner.' },
        actor, text, accountSource, via,
        expectedVersion: { type: 'integer', description: "The Entity's version from your last read or write." },
        name: { type: 'string', minLength: 1 },
        aliases: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'The complete new list of aliases.' },
        add: { type: 'array', items: { ...newStatement, properties: { ...newStatement.properties, supersedes: statementIds, conflictsWith: statementIds } } },
        update: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              statementId: { type: 'string' },
              status: { type: 'string', enum: ['current', 'outdated', 'disputed'] },
              reason: { type: 'string', minLength: 1, description: 'Why the status changed.' },
              sensitivity: { type: 'string', enum: ['normal', 'private', 'sensitive'] },
              inSummary: { type: 'boolean' },
            },
            required: ['statementId'],
            additionalProperties: false,
          },
        },
        support: { ...statementIds, description: 'Existing Statements these words also support.' },
      },
      required: ['entityId', 'actor', 'text'],
      additionalProperties: false,
    },
    annotations: write,
    run: (repo, args) => repo.entityRecord(args),
  },
  {
    name: 'repository_export',
    description: 'For the owner only: export the whole repository (every Event with its Accounts and Revisions, every Entity with its accounts, Statements and revisions) in the draft-0.2 format. An export holds everything; do not call it for an agent task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: read,
    run: (repo, args) => repo.exportRepository(args),
  },
  {
    name: 'repository_import',
    description: 'For the owner only: import an export ({snapshot}) into this repository, which must be empty (otherwise REPOSITORY_NOT_EMPTY). Everything is checked first; if any check fails nothing is imported.',
    inputSchema: {
      type: 'object',
      properties: { snapshot: { type: 'object', description: 'An export produced by repository_export.' } },
      required: ['snapshot'],
      additionalProperties: false,
    },
    annotations: write,
    run: (repo, args) => repo.importRepository(args),
  },
];
const OWNER_TOOLS = new Set(['repository_export', 'repository_import']);
const offered = TOOLS.filter((tool) => ownerTools || !OWNER_TOOLS.has(tool.name));
const byName = new Map(offered.map((tool) => [tool.name, tool]));

const { version } = createRequire(import.meta.url)('../package.json');
const server = new Server(
  { name: 'protocol-chaos-reference', version },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: offered.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = byName.get(request.params.name);
  if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
  const input = request.params.arguments ?? {};
  let body;
  let isError = false;
  try {
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
  if (isError) result.isError = true;
  return result;
});

await server.connect(new StdioServerTransport());
