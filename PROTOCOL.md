# Protocol Chaos — Specification (draft 0.2)

> **Status: draft 0.2, October 2026.** This document is normative: where an implementation disagrees with it, the implementation is wrong, or a change to this document has to be proposed. Drafts carry no compatibility promise. Draft 0.1 was implemented by the `protocol-chaos` package up to 0.1.0-alpha.11; Appendix A lists what changed since. Conformance tests for this draft are in [`conformance/`](conformance/README.md).

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY" and "OPTIONAL" in this document are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in capitals.

## 1. What this is

People tell their AI assistants about trips, renovations, job searches, purchases and ambitions. Each looks like a one-off. Most are not: a trip belongs to a wish to see more of the world, a camera serves a hobby, a move touches the whole family. Protocol Chaos keeps these matters, called **Events**, in one repository that the user holds, so that any assistant can read them, add to them and connect them, and so that they outlast any one assistant.

The protocol standardises the envelope, not the content:

- what an Event is, and how it is identified;
- how the user's words are kept, and how what an agent infers is told apart from them;
- how an Event is connected to larger ones and to the people, places and things it involves;
- how writers change Events without overwriting one another, and how every change is recorded;
- how a repository is exported and moved.

What an Event says is natural language. How a client finds the Events a conversation is about, how it ranks and presents them, and when it tidies them up, are the client's choice (§10).

An Event is not a task. A task is one piece of work an agent does and then forgets, such as converting a file. An Event is something in the user's life with a state and a history. It may happen only once, like one trip, and still be connected to others.

### 1.1 Not covered yet

Per-client visibility; recognising the same person across applications; merging; deletion; Events shared by several people. See §13.

## 2. Terms

| Term | Meaning |
|---|---|
| Repository | The store of one user's Events and, optionally, Entities. |
| Owner, user | The one person the repository belongs to. |
| Agent, client, writer | Software that calls the operations on the user's behalf, such as an AI assistant. A writer writes; it never owns. |
| Actor | `{kind, id, label?}`: who performed a write (§4.1). |
| Event | A matter of the user's, with a state, a version and a history (§4). |
| Account | An immutable text an Event rests on, usually the user's own words (§4.4). |
| Fact | One of three natural-language values of an Event: `goal`, `constraint`, `plan` (§4.5). |
| Parent | A larger Event that an Event is part of (§4.7). |
| Revision | An immutable record of one change to an Event (§4.8). |
| Entity | One specific person, animal, thing or place the user refers to (§6). |
| Statement | One natural-language fact about an Entity (§6.2). |
| Directory | A brief list of every Event, from which a client decides what to read (§8.1). |

## 3. Principles

These hold for every server and every writer.

1. **Sparse is normal.** An Event may hold nothing but one Account. Servers MUST NOT reject a write for being incomplete beyond the shapes this document defines.
2. **Words are kept verbatim.** An Account keeps the words it was given, trimmed and otherwise unchanged, and is never edited or removed. Writers MUST pass the user's actual words, never a summary or a third-person paraphrase such as "The user confirmed…". When a message covers several Events, a writer passes the part about this Event, still in the user's words. Interpretation belongs in the fields.
3. **The user's words win.** What a writer adds itself, an inference or something it knows from elsewhere, MUST be marked as such together with its basis: inside the fact text for Events ("Inferred: walks start in Lisbon (basis: Alex lives there)"), and in `basis` for Statements (§6.2). When the user contradicts an inference, writers MUST rewrite the value without it.
4. **Every change is recorded.** Every change to an Event is a Revision that names its writer and the Accounts it rests on (§4.8). A change is reversed by a later write, recorded in the same way.
5. **Servers do not reorganise.** Servers MUST NOT merge, split, delete or re-link Events on their own. Two Events about the same matter stay two until a writer, acting on the user's words, links them or closes one.
6. **Writers name themselves.** A writer MUST give its own identity as `actor` and MUST NOT write as the owner or as another writer. Every Event belongs to the owner, whoever wrote it.
7. **Clients decide what to send.** A client decides on its own side what it needs from the repository, and sends only that (§10).

## 4. Events

### 4.1 Identifiers and actors

Ids are opaque strings generated by the server, unique within the repository; none is `current_user` (§6.1). The prefixes `evt_` (Event), `acc_` (Account), `rev_` (Revision), `ent_` (Entity) and `stm_` (Statement) are RECOMMENDED. Clients MUST NOT parse ids.

An **actor** is `{kind, id, label?}`. `kind` is `user`, `agent`, `authorized_external` or `system`; `id` is a non-blank string; `label` is optional display text. The actor says who wrote something into the repository; whose words they are is the Account's `source` (§4.4).

Timestamps are RFC 3339 date-times in UTC, written with `Z`, for example `2026-03-14T09:30:00.000Z`. A timestamp a writer supplies is kept as written.

Lengths count Unicode code points. Every string this document defines, such as a name, a kind or a fact, is not blank; `metadata` may hold any JSON values. Values are kept as given: only the texts of Accounts and Entity accounts, and aliases, are trimmed.

### 4.2 The Event document

```json
{
  "id": "evt_0001",
  "version": 6,
  "createdAt": "2026-03-14T09:30:00.000Z",
  "updatedAt": "2026-03-21T18:02:11.000Z",
  "title": "Learn street photography",
  "state": "active",
  "progress": { "text": "First photo walk done", "timestamp": "2026-03-21T18:02:11.000Z" },
  "facts": { "goal": "Get good at street photography.", "constraint": "Only at weekends." },
  "refs": [{ "criteria": "the old town" }, { "ref": "ent_0002" }],
  "parents": ["evt_0042"],
  "metadata": { "dev.example/source": "import" }
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Set by the server. |
| `version` | integer ≥ 1 | The number of its Revisions (§4.8, §5.2). An Event started with words is at version 2: `event.created`, then `account.added`. |
| `createdAt`, `updatedAt` | timestamp | `updatedAt` changes with every Revision. |
| `title` | string, optional | 1 to 80 characters, not blank: a name that identifies the Event on its own (§7). |
| `state` | enum | §4.3. Always present; it cannot be removed. |
| `progress` | object, optional | Where the Event stands now: `{text, timestamp}`. `text` is not blank. `timestamp` is when it stood so: a writer folding in earlier words passes their time; when a writer omits it, the server sets the time of the write. |
| `facts` | object, optional | `goal`, `constraint` and `plan`, each optional (§4.5). Absent when no fact is set. |
| `refs` | array, optional | The people, places and things it involves (§4.6). Absent rather than empty. |
| `parents` | array | Ids of the Events it is part of (§4.7); empty when there are none. |
| `metadata` | object, optional | Extension data: string keys, which SHOULD be namespaced (`dev.example/flag`), to JSON values. Absent rather than empty. |

Optional fields appear only when set. A write that supplies any other field, or an unknown member inside one of these, MUST fail with `VALIDATION_ERROR`.

### 4.3 States

| `state` | Meaning |
|---|---|
| `emerging` | Recorded, not yet clearly pursued. Every Event starts here. |
| `active` | Being pursued. |
| `waiting` | Waiting on someone or something. |
| `dormant` | Open but untouched. Dormant is not finished. |
| `done` | Finished. |
| `cancelled` | Given up, or not going to happen. |

`done` and `cancelled` are closed; the other four are open. Setting an open state reopens a closed Event. Writers SHOULD set `active` when the user is pursuing an Event, rather than leaving it `emerging`.

### 4.4 Accounts

| Field | Type | Meaning |
|---|---|---|
| `id` | string | |
| `eventId` | string | The Event it belongs to. |
| `text` | string, not blank | The words, trimmed and otherwise as received. |
| `source` | enum | Whose words they are: `user` (the user's own), `agent_response` (the writer's own sentence, such as an inference it records) or `authorized_external` (relayed from an application the user authorized). |
| `via` | string, optional | Where the words came from when they were not said in this conversation, for example `example-export`. |
| `actor` | actor | Who wrote them into the repository. |
| `createdAt` | timestamp | |

Accounts are only appended. A server MAY return an existing Account of the same Event instead of appending one whose text, source and actor id are identical.

### 4.5 Facts

| Key | Holds |
|---|---|
| `goal` | What the Event is meant to achieve, including what would count as done. |
| `constraint` | Conditions it must meet: limits, deadlines, budgets, wishes and preferences, even when a wish is about a place or a time. |
| `plan` | The arrangement as currently decided: when, where, how, which option. |

Each value is natural-language text that is clear on its own, a sentence or a paragraph, never an object or a list. Servers MUST reject any other key, and any value that is not a non-blank string, with `VALIDATION_ERROR`; the message SHOULD say where the information belongs instead.

### 4.6 Refs

Each entry of `refs` has exactly one member:

- `criteria`: a description in the user's terms, such as "the old town" or "my sister";
- `ref`: the id of an existing Entity (§6).

Any other shape, or a `ref` that names no Entity, fails with `VALIDATION_ERROR`. A ref MUST NOT name the owner, and one that does fails with `VALIDATION_ERROR`: every Event already belongs to the user, and such a ref would make every Event look related. A server without the Entities level (§12) MUST reject `ref` entries.

### 4.7 Parents

An Event MAY have several parents, so Events form overlapping trees: the parent links form a directed acyclic graph. `parents` is a set; its order carries no meaning.

- A link is added and removed only by the operations of §8.1, each grounded on at least one Account of the child or of the parent; no Account, or an Account of any other Event, fails with `VALIDATION_ERROR`.
- Servers MUST reject a link from an Event to itself, or one that would close a cycle, with `PART_OF_CYCLE`.
- Adding a link that already exists changes nothing. Removing a link that does not exist fails with `NOT_FOUND`.
- A link belongs to the child: it changes the child's version and Revisions, not the parent's.

Two Events are connected when one is the parent of the other, when they share a parent, or when their refs name the same Entity.

### 4.8 Revisions

```json
{ "id": "rev_0006", "targetEventId": "evt_0001", "type": "field.changed",
  "payload": { "field": "facts.plan", "before": null, "after": "Saturday-morning photo walks in the old town, with Sam." },
  "actor": { "kind": "agent", "id": "laptop" }, "sourceAccountIds": ["acc_0005"],
  "occurredAt": "2026-03-21T18:02:11.000Z", "baseVersion": 5, "newVersion": 6 }
```

| `type` | `payload` |
|---|---|
| `event.created` | `{}`. Fields set in the same call follow as their own Revisions. |
| `account.added` | `{accountId}` |
| `field.changed` | `{field, before, after}`. `field` is `title`, `state`, `progress`, `facts.goal`, `facts.constraint`, `facts.plan`, `refs` or `metadata`; `before` and `after` are whole values, `null` when absent. |
| `parent.added`, `parent.removed` | `{parentEventId}` |
| `revision.reverted` | `{revisionId}`: only with the Undo level (§8.4). |

Each Revision records one change. `sourceAccountIds` are the Accounts it rests on: empty for `event.created` and `revision.reverted`, the new Account for `account.added`, and the call's Accounts for the others. `newVersion` is `baseVersion + 1`. Revisions are immutable, apart from `revertedByRevisionId` (§8.4), and are listed in commit order.

One call can produce several Revisions. They are committed in this order: `event.created`, `account.added`, `parent.added`, and then the `field.changed` Revisions in the order `title`, `state`, `progress`, `facts.goal`, `facts.constraint`, `facts.plan`, `refs`, `metadata`.

## 5. Writing

### 5.1 Atomicity and concurrency

Each operation is atomic: everything it changes is committed, or nothing is. A rejected call leaves no Account and no Revision behind. Servers MUST serialise the writes to a repository and MUST NOT let one writer overwrite what another has committed. Reads observe committed state.

### 5.2 Versions

- Every Revision adds one to the Event's version. A call that changes nothing leaves it unchanged.
- The writes that can overwrite something take `expectedVersion`, an integer: `event_record_expression`, `event_add_parent`, `event_remove_parent` and `entity_record`. When it is supplied, the server MUST compare it with the current version before changing anything, even if the call would change nothing, and fail with `VERSION_CONFLICT` on a mismatch. A local server MAY treat it as optional; a remote server MUST require it (§9.2).
- On `VERSION_CONFLICT` a writer MUST read the Event or Entity again and reconsider its change. It MUST NOT resend the same change blindly.
- `event_note` overwrites nothing, because it sets a title only where there is none and a parent only on a new Event, and so takes no version.
- A repository also has a **repository version**: an opaque string that changes whenever anything in the repository changes, so that a client can tell whether what it cached is still current (§8.1). It is not accepted as `expectedVersion`.

### 5.3 Replacing and removing fields

A write replaces each field it supplies as a whole, so a writer MUST supply the complete current content and carry over what still holds: a new `plan` replaces the old one, and a new `refs` list replaces the old list. Fields that are not supplied are unchanged. Supplying `null` removes a field, and so does an empty `refs` list or `metadata` object; `facts: null` removes every fact. `state` cannot be removed. Writing the stored value again changes nothing.

### 5.4 Errors

A failure is `{code, message}`. Messages are written for agents and say how to fix the call. They can quote user input, so servers MUST NOT log them.

| Code | When |
|---|---|
| `VALIDATION_ERROR` | The input breaks a rule of this document. This includes unknown members, and ids inside the input that name nothing of the right kind, such as an Account of another Event or a Statement of another Entity. |
| `NOT_FOUND` | The Event, Entity or Revision that an operation reads or changes does not exist, including a parent named by `parentEventId`. |
| `VERSION_CONFLICT` | `expectedVersion` is not the current version. |
| `VERSION_REQUIRED` | A remote write that needs `expectedVersion` has none (§9.2). |
| `ACTOR_MISMATCH` | A remote write names an actor other than the authenticated client (§9.2). |
| `PART_OF_CYCLE` | A parent link would join an Event to itself or close a cycle. |
| `REVISION_NOT_REVERSIBLE` | An undo that is not allowed (§8.4). |
| `USER_WORDS_PROTECTED`, `USER_CONFIRMATION_REQUIRED` | The Entity rules of §6.3. |
| `REPOSITORY_BUSY` | The server could not take the write now. Nothing changed; retry later. |
| `REPOSITORY_NOT_EMPTY` | An import into a repository that already holds data (§8.6). |
| `INTERNAL_ERROR` | Anything else. |

When a call breaks several rules, the server reports one of them; which one is its choice. Servers MAY define further codes; clients treat an unknown code as a failure.

## 6. Entities

This section applies to servers at the Entities level (§12).

### 6.1 Entities and their Accounts

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Set by the server. |
| `kind` | string | `person`, `animal`, `thing` or `place`. Other values are kept as written, and readers MUST NOT reject an Entity because of its kind. |
| `name` | string | What the user calls it. |
| `aliases` | array of strings | Other names, empty when there are none. Each is trimmed; a blank alias, a repeated one, or one equal to `name`, compared ignoring case, fails with `VALIDATION_ERROR`. |
| `owner` | boolean | `true` only for the user's own Entity. At most one Entity is the owner: creating a second fails with `VALIDATION_ERROR`. |
| `version` | integer ≥ 1 | 1 at creation, then one more per write. |
| `createdAt`, `updatedAt` | timestamp | |

Everything known about an Entity is a Statement. Every Entity write appends exactly one **Entity account**, shaped like an Account (§4.4) with `entityId` instead of `eventId`, and records an **Entity revision** `{id, targetEntityId, type, payload, actor, sourceAccountIds, occurredAt, baseVersion, newVersion}` with `type` `entity.created` or `entity.recorded`, kept for audit. `sourceAccountIds` names the write's Entity account; `payload` is an object of the server's choosing that describes the write, and an import accepts any object there. In every Entity operation the id `current_user` refers to the owner Entity; before an owner exists it fails with `NOT_FOUND`.

### 6.2 Statements

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Set by the server. |
| `entityId` | string | |
| `text` | string, 1 to 200 characters | One fact, in natural language, with absolute dates. |
| `topic` | string | One of `identity`, `home`, `family`, `work`, `skills`, `education`, `personality`, `beliefs`, `preferences`, `interests`, `taste`, `food`, `habits`, `health`, `finance`, `accounts`, `relationship`, `details`; other topics are accepted. `accounts` holds identifiers such as handles. |
| `evidence` | array, at least one | Ids of Entity accounts of the same Entity. |
| `basis` | string, optional | Present only when the Statement is an inference: what it rests on. |
| `saidAt`, `validFrom`, `validTo` | partial time, optional | When it was said, if not now; when it holds. A partial time is `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or an RFC 3339 date-time, and covers its whole period in UTC: `validTo: "2020"` has passed from `2021-01-01T00:00:00Z`. |
| `status` | enum | `current`, `outdated` or `disputed`. A `current` Statement whose `validTo` has passed reads as `outdated`: it is returned with that status. |
| `reason` | string, optional | Why the status changed. |
| `supersedes`, `conflictsWith` | arrays, optional | Statements this one replaces, and Statements it contradicts. |
| `sensitivity` | enum | `normal` (default), `private` or `sensitive`. |
| `inSummary` | boolean | Whether it belongs in the Entity's summary. Default `false`. |
| `actor` | actor | Who wrote it. |
| `createdAt`, `updatedAt` | timestamp | |

Saying the same thing again is more evidence, not a second fact: a server SHOULD add the new Entity account to the evidence of an existing Statement of the same Entity and topic, not reading as `outdated`, whose text is the same, rather than create another. How loosely texts count as the same is the server's choice, except that for the topic `accounts` they are compared exactly, because in a handle the punctuation and case are the name.

The **summary** of an Entity is its Statements that have `inSummary: true`, read as `current` and are not `sensitive`. Servers SHOULD keep summaries short enough to load into every conversation, and MUST NOT include `sensitive` Statements.

### 6.3 Protecting the user's words

A Statement rests on the user's words when any of its evidence has source `user`.

- A write whose own Entity account is not `user`-sourced, whether `agent_response` or `authorized_external`, MUST NOT supersede such a Statement or change its status; it fails with `USER_WORDS_PROTECTED`. The writer adds its own version with `conflictsWith` instead. Its `reason`, `sensitivity` and `inSummary` can still be changed.
- A Statement added with `conflictsWith` is `disputed`. Each Statement it names gains a back-link: the new Statement's id in its own `conflictsWith`. A named Statement that reads as `current` and does not rest on the user's words also becomes `disputed`.
- Changing a `disputed` Statement to `current` requires a `user`-sourced write; otherwise it fails with `USER_CONFIRMATION_REQUIRED`, also when the Statement rests on the user's words.
- `supersedes` marks the replaced Statements `outdated`.

### 6.4 When to create an Entity

A writer SHOULD create an Entity only when all three hold: it is one specific individual, not a category; it recurs across Events or applications and needs to be recognised as the same one; and there is user-specific information to accumulate about it. Otherwise it uses a `criteria` ref. What progresses and ends is an Event; who someone is, and how things stand with them, is a Statement: "wants to adopt a second dog in 2027" is an Event, "has a dog called Biscuit" a Statement.

## 7. Writer rules

Every writer shares one repository, so careless writing by one harms all the others. Writers SHOULD follow these rules.

1. **Record what changes an Event.** Record words that change an Event (its title, state, progress, facts, refs or parents) or that start one: an intention, plan, commitment, purchase, trip, target or arrangement that outlasts the conversation, long-horizon aims included. Do not record questions, hypotheticals, instructions to the agent, fragments that change no Event (a meal, a workout), or the writer's own calculations.
   - **A request is not a record, but what it reveals can be.** A bare request ends when it is answered: the calories in a meal, the nearest Hunan restaurant. When the same message also says how the user feels about one of their matters, what is happening in their life, or how far they have got, record that part: "…that felt like far too much, I'm trying to lose weight and daren't eat like this" is a limit on the weight-loss Event; "…friends from Hunan are coming to stay and I want to get ready" starts an Event of its own; "three days of healthy eating so far" is progress on the healthy-eating Event.
2. **Write on the most specific Event.** Put the words on the most specific Event they are about, following parents to find it. When the words start a concrete part of a larger Event, start a new Event under it.
3. **Titles identify.** A title names the Event on its own: what it is, plus when or which wherever a similar Event could follow ("Lisbon trip, spring 2027", never "Lisbon").
4. **Check before creating.** Before creating an Event or an Entity, check what is already known, in the directory or by search, so that one matter does not become two.
5. **Link only what plainly belongs.** Add a parent only when the Event is plainly part of the other, or a step toward it. Two separate trips are siblings, not parent and child.
6. **Write facts plainly.** Make relative times concrete when the date of speaking fixes them ("New Year's Eve 2026" rather than "this New Year's Eve"), and keep them as said when they depend on something else ("before I turn 40"). Never write "the user" into facts or refs. Where an Event stands goes in `progress`, not in a fact. A wish moves from `constraint` to `plan` once it is decided, and is never in both.
7. **No secrets.** Never record passwords, tokens or identity-document numbers.

## 8. Operations

Every operation takes one JSON object and returns one JSON value, or a failure (§5.4). Clients MUST NOT send members that are not listed; servers reject them (§4.2). A few rules hold for every operation:

- An optional input that is not used is omitted, never `null`; `null` has a meaning only inside `set` (§5.3).
- Where words are recorded, `accountSource` is `user` when omitted; clients SHOULD state it.
- `limit` is a positive integer. Without it, the server chooses: `context_pack` and `event_get_revisions` return everything or a page that `next` continues, `event_words_since` everything or one batch, with `remaining` counting what is left, and the searches as many results as the server sees fit.
- Where this document compares texts "ignoring case", it compares their Unicode lowercase mappings. Everywhere else texts are compared exactly.

### 8.1 Core

#### `event_note`

Records words on an Event, or starts a new Event with them. Changes nothing else.

- Input: `actor`; `text`; `accountSource`; optional `via`; optional `eventId`; optional `title` (§4.2). For a new Event: optional `parentEventId`.
- With `eventId`: appends the Account (§4.4), and sets `title` only when the Event has none.
- Without `eventId`: creates an Event in state `emerging` with this Account, the title if given, and a link to `parentEventId` if given. An unknown parent fails with `NOT_FOUND`; `eventId` together with `parentEventId` fails with `VALIDATION_ERROR`.
- Returns a receipt (below).

```json
{ "actor": { "kind": "agent", "id": "phone" }, "accountSource": "user", "eventId": "evt_0001",
  "text": "Sam wants to come along on Saturday mornings." }
```

#### `event_record_expression`

Records words together with the changes they support, atomically.

- Input: `eventId`, `actor`, `text`, `accountSource`, optional `via`, `expectedVersion` (§5.2), optional `accountId`, and optional `set`.
- `accountId` grounds the changes on an existing Account of this Event instead of appending one: this is how words recorded earlier are folded into fields later. `text` MUST then equal that Account's text after trimming; `accountSource` and `via` are not used. An `accountId` that is not an Account of this Event, or a `text` that differs from it, fails with `VALIDATION_ERROR`.
- `set` holds any of `title`, `state`, `progress`, `facts`, `refs` and `metadata`. Each supplied field replaces the stored one (§5.3). Inside `facts`, each supplied key replaces that fact and the others are unchanged; `null` removes a fact.
- Returns a receipt.

```json
{ "eventId": "evt_0001", "actor": { "kind": "agent", "id": "organizer" }, "expectedVersion": 7,
  "accountId": "acc_0005", "accountSource": "user", "text": "Sam wants to come along on Saturday mornings.",
  "set": { "refs": [{ "criteria": "the old town" }, { "ref": "ent_0002" }],
           "facts": { "plan": "Saturday-morning photo walks in the old town, with Sam." } } }
```

#### Receipt

Both write operations answer with a short receipt rather than the whole Event:

| Member | Content |
|---|---|
| `eventId`, `version`, `state` | The Event after the call; `version` is the `expectedVersion` for the next write. |
| `accountId` | The Account the call rests on. |
| `accountReused` | `true` when an identical Account was returned instead of appended (§4.4); otherwise absent or `false`. |
| `title`, `facts` | The current title, when set, and `facts`, an object with the current facts (empty when there are none), so that the next write can carry over what still holds. |
| `changed` | What this call changed, in commit order: `created`, `account`, `parent`, `title`, `state`, `progress`, `facts.goal`, `facts.constraint`, `facts.plan`, `refs`, `metadata`. Empty when nothing changed. |

#### `event_add_parent`, `event_remove_parent`

Add or remove the link "child is part of parent" (§4.7).

- Input: `childEventId`, `parentEventId`, `actor`, `sourceAccountIds` (at least one Account of the child or of the parent), `expectedVersion` (the child's).
- Returns `{eventId, version, parents}` for the child.

#### `event_get_protocol`

Reads one Event.

- Input: `eventId`; optional `accounts`: how many of the most recent Accounts to return, a non-negative integer, default 20, or `"all"`.
- Returns `{event, accounts, entities?}`: the document (§4.2); the Accounts, oldest first; and, when refs name Entities, `entities` as `[{id, kind, name}]`. History is read with `event_get_revisions`.

#### `context_pack`

The directory: every Event in brief, from which a client decides on its own side what to read (§10).

- Input: optional `sinceVersion`, `state` (one of the six states, or `open` or `closed`), `limit` and `cursor`.
- Returns `{protocolVersion, version, unchanged: true}` when `sinceVersion` equals the current repository version. Otherwise `{protocolVersion, version, events, next?}`: `events` lists `{id, title?, state, parents, progress?, updatedAt}`, most recently updated first, and Events updated at the same instant by `id` in descending code-point order, so that the order depends only on the documents and survives a move (§8.6); `next`, present when there are more, is passed as `cursor` for the next page.
- A cursor stays valid when the repository changes, but an Event updated between two pages can then appear twice or not at all; the repository version tells a client that this may have happened.
- A server MAY also return a `text` rendering of the same list, for clients that place it straight into a prompt.

#### `event_get_revisions`

Reads the history of an Event.

- Input: `eventId`; optional `after` (a Revision id) and `limit`.
- Returns `{revisions, next?}` in commit order; `next`, present when there are more, is passed as `after` for the next page.

### 8.2 Search

#### `event_search`

Finds Events for a query the client chose.

- Input: `query`; optional `state` (as in `context_pack`) and `limit`.
- Returns `{events}`, as in the directory, best matches first. How the server matches is its own choice: by words, by meaning, or both. A server SHOULD document which. Whatever else it matches, it MUST return every Event whose title contains the query, ignoring case, unless `state` leaves it out or there are more of them than `limit`, so that a writer checking before it creates (§7) finds a matter by its name.

### 8.3 Sync

#### `event_words_since`

The words recorded since a moment, for writers that fold words into fields later, and for clients that keep a cache.

- Input: `since`, a timestamp (a first sync passes `1970-01-01T00:00:00.000Z`); optional `limit`, the number of Events per batch.
- A batch is the Accounts created after `since`, in the order they were created, cut before the Account that would bring in one Event more than `limit`. It never ends between two Accounts with the same `createdAt`, so it can then hold more Events than `limit`.
- Returns `{version, checkpoint, remaining, events}`. `version` is the repository version (§5.2). `events` holds each Event with Accounts in the batch, with its current fields, as `{id, version, title?, state, facts?, refs?, progress?, parents, words}`; `words` are its Accounts in the batch, oldest first. An Event can appear again in a later batch. `checkpoint` is the `createdAt` of the batch's last Account, or `since` when the batch is empty; passing it as the next `since` continues. `remaining` counts the Accounts after the batch.
- A new Account's `createdAt` is later than that of every Account already in the repository, so that a checkpoint never skips words written after it.
- Going over the same words twice changes nothing, because field writes carry the complete current content.

### 8.4 Undo

#### `event_undo_revision`

- Input: `revisionId`, `actor`.
- Only changes can be undone: the Revision MUST be a `field.changed`, `parent.added` or `parent.removed` Revision, and the latest such Revision of its Event that has not been undone. Words recorded in between do not count. `event.created` and `account.added` cannot be undone, because Events and words are never removed; an undo cannot be undone; and neither can an Entity revision (§13). Otherwise the call fails with `REVISION_NOT_REVERSIBLE`; an unknown `revisionId` fails with `NOT_FOUND`.
- The server restores what the Revision changed, records a `revision.reverted` Revision and sets `revertedByRevisionId` on the undone one. Restoring a removed link that would now close a cycle fails with `PART_OF_CYCLE`. Undoing, in a later call, the change before it walks further back. Returns the new Revision.
- Because only the latest change can be undone, an undo needs no `expectedVersion`: after another writer's change, the call fails with `REVISION_NOT_REVERSIBLE`.

### 8.5 Entities

An Entity is returned as in §6.1, and a Statement as in §6.2. A **new Statement** is `{text, topic, basis?, saidAt?, validFrom?, validTo?, sensitivity?, inSummary?}`.

- **`entity_search`.** Input: optional `query` (omitted lists every Entity), `kind`, `limit`. Returns `{entities}`: cards `{id, kind, name, aliases?, owner?, version, statements}`, where `statements` counts the Statements not reading as `outdated`. Whatever else it matches, the result MUST include every Entity of that kind whose name or one of whose aliases equals the query, ignoring case, unless there are more of them than `limit`.
- **`entity_get`.** Input: `entityId` (an id or `current_user`); optional `view`, `summary` or `full` (default); optional `topics`, `includeHistory` and `includeEvents`. `summary` returns `{entity, summary}`, where `summary` lists the summary Statements (§6.2). `full` returns `{entity, statements}`, the Statements not reading as `outdated`, ordered by topic in the order of §6.2 and then by creation; with `includeHistory`, also `history`, the ones reading as `outdated`; with `includeEvents`, also `referencedBy`, the Events whose refs name the Entity, as `[{id, title?, state}]`. `topics` restricts the Statements returned in either view; `includeHistory` and `includeEvents` apply to the `full` view only.
- **`entity_create`.** Input: `actor`, `kind`, `name`, `accountText`, `accountSource`, optional `via`, `aliases`, `owner` and `statements` (new Statements). Returns `{entityId, version, accountId, added}`, `added` listing the ids of the Statements created.
- **`entity_record`.** Input: `entityId`, `actor`, `text`, `accountSource`, optional `via`, `expectedVersion` (the Entity's, §5.2), and at least one of: `name`; `aliases` (the complete new list); and non-empty lists `add` (new Statements, which MAY also carry `supersedes` and `conflictsWith`), `update` (`[{statementId, status?, reason?, sensitivity?, inSummary?}]`, each with at least one change) and `support` (ids of Statements these words also support). Returns `{entityId, version, accountId, added?, merged?, changed?, supported?}`, each a list of Statement ids: created, merged into an existing Statement (§6.2), changed by `update`, and given these words as evidence by `support`.

### 8.6 Export and import

A server MUST let the owner export the whole repository in this format, and import such an export into an empty repository. It need not offer either as an operation agents can call; because an export holds everything, it SHOULD NOT (§10). A server that offers them as operations, for example on a local binding used by the owner, names them `repository_export` (no input; returns the export) and `repository_import` (`{snapshot}`; returns `{imported: true}`, and fails with `REPOSITORY_NOT_EMPTY` unless the repository holds no Events and no Entities).

```json
{ "schemaVersion": "0.3.0", "protocolVersion": "draft-0.2", "exportedAt": "2026-03-21T18:05:00.000Z",
  "events": [{ "event": { "id": "evt_0001", "…": "…" }, "accounts": [], "revisions": [] }],
  "entities": [{ "entity": { "id": "ent_0002", "…": "…" }, "accounts": [], "statements": [], "revisions": [] }] }
```

Before changing anything, an import MUST check that: no two items of the export share an id; every Account and Revision belongs to the Event or Entity it is listed under; parents exist and form no cycle; each version equals the number of Revisions; at most one Entity is the owner; refs name Entities in the export, never the owner; Statements rest on Entity accounts of their own Entity; and `supersedes` and `conflictsWith` name Statements of the same Entity. A server without the Entities level also rejects an export that holds Entities. An import that fails any check fails with `VALIDATION_ERROR` and imports nothing. An import keeps every id, timestamp and version as exported, so that a moved repository answers as the original did. Moving a repository is an export followed by an import into an empty repository.

## 9. Bindings

### 9.1 MCP

- Each operation is an MCP tool of the same name. Its arguments are the operation's input; a success is a tool result whose single text item holds the JSON result; a failure is a tool result with `isError: true` whose text holds `{code, message}`.
- Read operations carry `readOnlyHint: true`; `event_remove_parent` and `event_undo_revision` carry `destructiveHint: true`. Because MCP assumes a write is destructive unless told otherwise, the other writes SHOULD carry `destructiveHint: false`.
- Many clients show an agent only the server's `instructions` and the tool descriptions. A server SHOULD therefore send short `instructions` in its `initialize` result covering principles 2, 3 and 6 and the writer rules of §7, and SHOULD repeat the verbatim rule in the descriptions of the write tools. The [agent guide](docs/agent-guide.md) has a template.

### 9.2 Remote

For a server reached from another machine, for example over MCP streamable HTTP:

- the connection MUST use TLS;
- each client SHOULD have its own credential, such as a bearer token, that can be revoked alone;
- the server MUST bind writes to the authenticated client: the `actor` of every write MUST be `{kind: "agent", id: <client name>}`, otherwise `ACTOR_MISMATCH`;
- `expectedVersion` is REQUIRED on `event_record_expression`, `event_add_parent`, `event_remove_parent` and `entity_record`, otherwise `VERSION_REQUIRED`;
- the server SHOULD reject requests that carry a browser `Origin` header.

A credential identifies the client, not the person speaking: `accountSource: "user"` remains the client's assertion.

## 10. Privacy

- **Who can read what.** Every connected client can currently read every Event and Entity. Users SHOULD connect only clients they would trust with the whole repository. What a cloud-backed agent reads enters its model context and is processed by its provider.
- **Clients decide on their own side.** A client SHOULD decide locally, from what it already has (the directory, its own model), whether and what to read, and SHOULD send the repository only what it decided it needs: an id to read, a query it chose, the words it decided to record. A server MUST NOT require clients to send messages that are not about the user's matters. An operation that takes a whole message and finds the related Events itself is an optional extension of a server, not part of this protocol.
- **Exports** hold everything and SHOULD be available to the owner only. Copies SHOULD be deleted once they have served their purpose.
- **Sensitive Statements** never appear in summaries (§6.2).

## 11. Versioning and compatibility

- This is draft 0.2. `protocolVersion`, in directory results and exports, says which draft a server implements: `draft-0.2`.
- Exports in this draft have `schemaVersion` `0.3.0`. Servers MAY also import exports of earlier drafts.
- Servers MUST keep `metadata` keys, Entity kinds and Statement topics they do not know, as written. Any other unknown member or value is rejected (§4.2).
- A reader that meets a `state` it does not know SHOULD treat the Event as `emerging`.

## 12. Conformance

A server states the levels it implements. Every level includes Core.

| Level | Requires |
|---|---|
| Core | §3, §4, §5, the core operations of §8.1, export and import (§8.6), §9.1, §10 and §11. |
| Entities | §6 and §8.5. |
| Search | §8.2. |
| Sync | §8.3. |
| Undo | §8.4. |
| Remote | §9.2. |

A conforming client follows principles 2, 3, 6 and 7 (§3); supplies the complete content of each field it changes (§5.3); handles versions as §5.2 says; and follows the writer rules (§7).

Every requirement on servers is checked by a test of the conformance suite in [`conformance/`](conformance/README.md), which runs against any server over MCP; its README maps each requirement to its tests and names the few that cannot be checked from outside. Requirements on writers cannot be checked against a server: they are checked by reading what a writer wrote.

## 13. Open issues

1. **Visibility per client.** Every client reads everything. A model for limiting what each client can see is not designed yet.
2. **The same person across applications.** Entities are recognised only by writers searching names, aliases and Statements. The intended direction: identifiers written as aliases with a platform prefix (`instagram:@sam`) and compared as written, and merging two Entities as a reversible revision. Not specified yet.
3. **Deletion.** Events, Accounts and Entities cannot be deleted; a mistaken Event is closed as `cancelled`.
4. **Events held by several people.** Draft 0.1 modelled several holders of one Event and never used it; it was removed. Shared Events are to be designed when a real case needs them.
5. **Other relations.** Draft 0.1 also stored other kinds of relation between Events. None was ever used, and they were removed. Connections are parents, shared parents and shared Entities (§4.7). A new kind of relation will be added when a real case needs one.
6. **Idempotent creation.** `event_note` without `eventId` has no idempotency key. After a write whose outcome is unknown, read before retrying.
7. **Undo of Entity writes.** Entity writes are kept for audit and reversed by later writes; there is no undo.

## Appendix A. Changes from draft 0.1

- One `state` replaces the Event lifecycle and `shared.activity`; `done` and `cancelled` replace `fulfilled`, `cancelled` and `closed`.
- The document is flat: `title`, `state`, `progress`, `facts`, `refs`, `parents` and `metadata`. Everything else in draft 0.1's document is gone: the per-holder perspectives, the list of relations, and the fields that were stored without behaviour. `progress` loses `source`; refs lose `role`.
- Parents are set only by `event_note` (on creation), `event_add_parent` and `event_remove_parent`.
- Unknown members are rejected instead of dropped; `null` removes a field.
- `event_record_expression` takes `set` with `facts` as an object, instead of `protocol.shared`, `protocol.perspectives` and a list of facts.
- Seven core operations and four optional levels. `context_for`, `event_create`, `event_get`, `event_list`, `event_set_lifecycle`, `event_get_children`, `event_get_ancestors`, `event_get_tree`, `account_add`, `event_add_claim`, `event_supersede_claim`, and export and import as agent tools, are left to implementations.
- `context_pack` returns structured entries and a cursor; `event_get_protocol` returns the most recent Accounts and leaves history to `event_get_revisions`.
- Revisions record field changes (`field.changed`) instead of Claims; exports are organised by Event and Entity (`schemaVersion` `0.3.0`). Claims and storage keys are no longer part of the protocol.
- Accounts gain `via`. `account.added` can no longer be undone.
- Entity ids need no fixed prefix: a ref names an Entity by its `ref` member.
- New: the writer rules (§7) and the principle that clients decide on their own side what to send (§10).
- Moved out of the protocol, as choices each implementation makes for itself: matching, embedding models, short ids, storage, token files, usage logs and the text of server instructions. How agents should use a repository is in the [agent guide](docs/agent-guide.md), which is not normative.
