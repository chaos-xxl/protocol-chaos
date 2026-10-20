# Conformance tests for Protocol Chaos draft 0.2

These tests check a server against [PROTOCOL.md](../PROTOCOL.md). They reach the server only through its MCP tools, so they run against any implementation, in any language.

## Running

```sh
npm ci

# A server started over stdio. {tmp} becomes a fresh, empty directory for each server the
# suite starts; with it, the suite can also test import into an empty repository.
node conformance/run.mjs --stdio "node my-server.js --data {tmp}"

# A remote server. The token is read from the named variable; --actor is the client name
# the token was issued for.
PC_TOKEN=… node conformance/run.mjs --url https://host.example/mcp --token-env PC_TOKEN --actor laptop
```

| Option | |
|---|---|
| `--levels core,entities,…` | The levels to test. Core is always included. By default: Core, every optional level whose operations the server lists, and Remote with `--url`. |
| `--only PREFIX` | Only the tests whose id starts with `PREFIX`, for example `core.parents`. |
| `--assume-empty` | Skip the check that the repository is empty. |
| `--json` | Print the results as JSON. |

The tests write Events and Entities, so they refuse to run against a repository whose directory is not empty. Never point them at a repository that holds real data.

Each test prints `✓` (passed), `✗` (failed, with the rule it broke) or `-` (skipped, with the reason: for example, export and import are not offered as operations, or a fresh repository cannot be started over `--url`). The exit code is 1 when any test failed.

The suite needs Node.js 20 or later and the packages of this repository (`npm ci`). The server under test can be written in any language. `npm run test:conformance` runs it against the [reference server](../server/README.md).

## What is checked

Every requirement that this document places on servers is checked by at least one test. Tests are named `<level>.<topic>`, and each names the section it checks.

| Section | Requirement | Tests |
|---|---|---|
| §3.1 | One Account is enough for an Event | `core.note.creates` |
| §3.2, §4.4 | Words are kept verbatim, only trimmed, with their source, `via` and actor; they are never removed | `core.words.verbatim`, `core.words.sources`, `undo.walk` |
| §3.4, §4.8 | Every change is one Revision that names its writer and its Accounts, committed in a fixed order; versions count Revisions | `core.revisions.versions`, `core.revisions.payloads`, `core.revisions.paging`, `core.note.parent` |
| §3.5 | Servers do not merge or link Events on their own | `core.no.reorganising` |
| §4.1 | Actors are kept as written; strings are not blank; lengths count code points | `core.actor`, `core.words.sources`, `core.title.rules`, `search.query` |
| §4.2 | The document holds only its fields, optional ones only when set; titles and progress follow their rules; unknown members are rejected | `core.note.creates`, `core.set.fields`, `core.title.rules`, `core.progress`, `core.unknown.members` |
| §4.3 | Six states; closed Events reopen; other states are rejected | `core.states` |
| §4.5 | Only `goal`, `constraint` and `plan`, each a non-blank string | `core.facts.rules`, `core.set.facts` |
| §4.6 | A ref has exactly one member; it names an existing Entity, never the owner; without Entities, `ref` is rejected | `core.refs.shape`, `entities.refs` |
| §4.7 | Links are grounded, never cyclic, belong to the child, and may be several | `core.parents.add`, `core.parents.cycle`, `core.parents.remove`, `core.parents.grounding`, `core.note.parent` |
| §5.1 | Calls are atomic; writes are serialised and never overwrite one another | `core.atomic`, `core.concurrent`, `core.note.errors` |
| §5.2 | `expectedVersion` is compared; a no-op changes nothing; the repository version moves with every write and is not an `expectedVersion` | `core.version.conflict`, `core.set.unchanged`, `core.version.repository`, `core.directory.version`, `entities.version` |
| §5.3 | Fields are replaced whole; `null`, an empty list or object removes; facts are replaced per key | `core.set.replace`, `core.set.facts`, `core.states` |
| §5.4 | Failures are `{code, message}` with the codes of the table | `core.errors`, and every test that expects a failure |
| §6.1 | Entities: kinds, aliases, one owner, `current_user`, one version per write, one Entity account and revision per write | `entities.owner.absent`, `entities.create`, `entities.owner`, `entities.kinds`, `entities.aliases`, `entities.version`, `entities.export` |
| §6.2 | Statements: text length, partial times, evidence, validity, the summary without sensitive Statements | `entities.statements.rules`, `entities.evidence`, `entities.validity`, `entities.summary` |
| §6.3 | Only the user's words supersede or re-status what rests on them; conflicts are disputed and linked back; confirming needs the user | `entities.protected`, `entities.conflicts`, `entities.confirmation`, `entities.supersedes` |
| §8.1 | The core operations, their inputs, receipts, paging and filters | `core.*` |
| §8.2 | Search finds titles containing the query; filters by state; needs a query | `search.title`, `search.state`, `search.query` |
| §8.3 | Words since a moment, by Event, with a checkpoint and a count of what remains; batches count Events and never split a tie | `sync.words`, `sync.batches`, `sync.ties` |
| §8.4 | Only the latest change can be undone; words in between do not count; cycles are refused | `undo.walk`, `undo.refused`, `undo.parents` |
| §8.5 | Entity operations: cards, views, order, topics, history, `referencedBy`, search by name and alias | `entities.*` |
| §8.6 | Exports hold everything per Event and Entity; imports only into an empty repository, all or nothing, after every check | `core.export.shape`, `core.import`, `core.import.invalid`, `entities.export`, `entities.import`, `entities.import.invalid` |
| §9.1 | Operations are tools of the same name; one JSON text item; failures with `isError`; read and destructive hints | `mcp.tools`, `mcp.annotations`, and every call |
| §9.2 | TLS; writes bound to the authenticated client; `expectedVersion` required | `remote.tls`, `remote.actor`, `remote.version` |
| §11 | `protocolVersion`; unknown metadata keys, kinds and topics kept as written | `core.directory.shape`, `core.export.shape`, `core.metadata`, `entities.kinds` |

Some requirements cannot be checked from outside a server, and are left to its implementer:

- Messages are not logged (§5.4).
- A server does not require messages that are not about the user's matters (§10). The core operations take only what a client decided to send; extensions are not covered.
- Export and import exist for the owner (§8.6). When a server does not offer them as operations, the export tests are skipped and the export has to be checked by hand.

Requirements on writers (§3 principles 2, 3 and 6, §5.2 and §5.3 for writers, and §7) cannot be checked against a server. They are checked by reading what a writer wrote.

## Adding a test

A test is an object `{id, level, ref, title, run}` in one of the files under `tests/`. `run` receives a context with `call(name, args)`, `fails(code, () => …)`, `assert`, `equal`, `unique(label)` (a text unique to the run), shorthands for the common operations (`note`, `record`, `read`, `revisions`, `newEvent`) and `fresh()`, which starts a second, empty server when the suite was started with `{tmp}`. A test checks what the specification says, and names the section in `ref`; a rule the specification does not state is proposed as a change to the specification first.
