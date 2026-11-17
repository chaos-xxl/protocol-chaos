# Reference server

A small server that implements [draft 0.2](../PROTOCOL.md) at every level: Core, Entities, Search, Sync, Undo and Remote. It is here to try the protocol with your own assistants and to check other implementations against; it passes every [conformance test](../conformance/README.md).

It was written from the specification alone, by an agent that had never seen another implementation, as a test that the document is enough.

```sh
npx -y protocol-chaos@0.2 [--data <directory>] [--tools <groups>] [--owner-tools]    # MCP over stdio, one computer
npx -y protocol-chaos@0.2 --http 127.0.0.1:8721 [--data <directory>] [--tools <groups>]  # MCP over HTTP, several computers
npx -y protocol-chaos@0.2 clients add <name> [--tools <groups>] | tools <name> <groups> | list | remove <name>  # the tokens for HTTP
npx -y protocol-chaos@0.2 init | uninstall | doctor                                   # connect the agents on this computer
npx -y protocol-chaos@0.2 import [--yes] | --status | --undo                          # import other assistants' memories
node server/index.mjs …                                                              # the same, from a clone
```

| Option | |
|---|---|
| `--data` | Where the repository lives. Default: `$PROTOCOL_CHAOS_DATA`, then `~/.protocol-chaos`. |
| `--client <name>` | Over stdio, the name of the assistant on the other end, such as `codex`. The instructions tell it to write as `{"kind": "agent", "id": "<name>"}`, and writes as anyone else are refused (`ACTOR_MISMATCH`), as over HTTP. Without it, any actor is accepted. |
| `--tools` | Which [tool groups](#tool-groups) a connection is offered. Default: `all`. |
| `--owner-tools` | Also offer `repository_export` and `repository_import`. An export holds everything, so these are off unless the owner asks (PROTOCOL.md §8.6, §10). Over HTTP, every client could then export the whole repository. |
| `--http [host:]port` | Serve MCP streamable HTTP at `/mcp` instead of stdio: the Remote level (§9.2). The host defaults to `127.0.0.1`. |
| `--tls-cert`, `--tls-key` | Serve HTTPS with this certificate and private key. Needed to listen on an address other machines can reach. |

## Tool groups

Every connection sends the definitions of the tools it is offered to its model, with every request. An assistant that only records the user's words, while an organizer folds them into fields later, needs four tools, not fourteen. `--tools` takes a comma-separated list of groups and profiles:

| Group | Tools |
|---|---|
| `read` | `context_pack`, `event_search`, `event_get_protocol` |
| `record` | `event_note` |
| `fields` | `event_record_expression` |
| `links` | `event_add_parent`, `event_remove_parent` |
| `history` | `event_get_revisions`, `event_undo_revision` |
| `sync` | `event_words_since` |
| `entities` | `entity_search`, `entity_get`, `entity_create`, `entity_record` |
| `owner` | `repository_export`, `repository_import`, offered only with `--owner-tools` as well |

| Profile | Groups | For |
|---|---|---|
| `assistant` | `read`, `record` | an assistant whose words an organizer folds in later |
| `writer` | `read`, `record`, `fields` | an assistant that brings an Event's fields up to date itself |
| `all` | every group | an organizer, the conformance tests; the default |

Add `entities` to either, as in `writer,entities`, for an assistant that keeps facts about people and places: those four tools are as long as all the others together. Over HTTP each client can have its own list, set when it is added (`clients add phone --tools assistant`) or later (`clients tools phone writer`, or `default` for the server's); it takes effect without a restart. A tool a connection is not offered cannot be called on it. The levels the server implements (PROTOCOL.md §12) are those of everything it offers with `all`.

## Installer

`init` connects the agents on one computer to one repository, `uninstall` takes that back, and `doctor` checks it. macOS and Linux.

```sh
npx protocol-chaos init [--only claude-code,codex,dsh,hermes,kiro,cursor] [--organizer <agent>|none] [--no-schedule] [--no-import] [--yes] [--dry-run] [--data <directory>]
npx protocol-chaos uninstall [--only …] [--dry-run] [--data <directory>]
npx protocol-chaos doctor [--data <directory>]
```

What `init` puts in place:

- **The server**, copied with the dependencies it runs with into `<data>/runtime/<version>` (the files `npx` just fetched, so nothing is downloaded twice), and a **launcher**, `<data>/bin/protocol-chaos`, that starts it with the full path of the Node.js that ran `init`. Apps started from the desktop do not see your shell's `PATH`; the launcher does not need it. Running a newer `init` moves the launcher to the newer server and removes the older one.
- **For each agent, an MCP server named `protocol_chaos`** that runs the launcher with `--client <agent> --tools writer`: the agent writes under its own name, and is offered the five tools of the `writer` profile.

| Agent | What `init` writes | How its model gets the instructions |
|---|---|---|
| Claude Code (`claude-code`) | `claude mcp add --scope user`, which keeps it in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | Claude Code shows the server's instructions to its model. |
| Codex (`codex`) | a `[mcp_servers.protocol_chaos]` table at the end of `config.toml` in `$CODEX_HOME` (default `~/.codex`) | Codex shows a server's instructions only as the description of its tools ([openai/codex#29097](https://github.com/openai/codex/issues/29097)), so `init` also writes them into `AGENTS.md` there, unless that file already mentions `protocol_chaos`. |
| DeepSeek Harness (`dsh`) | one `@deepseek-ai/dsh-mcp-client` entry at the end of `cordis.patch.yml` in `$DSH_HOME` (default `~/.dsh`), the patch layer of every profile | DeepSeek Harness puts the server's instructions in its system prompt. |
| Hermes (`hermes`) | the server over HTTP on `127.0.0.1` (port 8721, or the next free one up to 8725), started at login by launchd or a systemd user service; a token for the client `hermes`; `PROTOCOL_CHAOS_URL` and `PROTOCOL_CHAOS_TOKEN` at the end of `.env` in `$HERMES_HOME` (default `~/.hermes`); the `protocol_chaos` MCP server (`hermes config set`); and the plugin (`hermes plugins install … --enable`) | The plugin puts an overview of the open matters, with their ids, in the system prompt; the model opens matters through the MCP server. |
| Kiro (`kiro`) | a `protocol_chaos` entry under `mcpServers` in `~/.kiro/settings/mcp.json`, which the IDE and Kiro CLI share | Kiro does not show a server's instructions to its model, so `init` writes them as a steering file, `~/.kiro/steering/protocol-chaos.md`, with no front matter: Kiro includes such a file in every conversation. Not when a steering file there already mentions `protocol_chaos`. |
| Cursor (`cursor`) | a `protocol_chaos` entry under `mcpServers` in `~/.cursor/mcp.json` | Cursor does not show a server's instructions to its model either, and keeps its User Rules in its own settings, so `init` writes them as a skill, `~/.cursor/skills/protocol-chaos/SKILL.md`, whose description (which the model always sees) carries the main rule. Not when a skill there already mentions `protocol_chaos`. |

Where the instructions are written down (Codex, Kiro, Cursor), one line follows them: when the server offers the tool `memories_import`, call it in the first reply ([Importing other assistants' memories](#importing-other-assistants-memories)).

Text `init` adds to a file sits between `protocol-chaos:begin` and `protocol-chaos:end`; a JSON settings file gets one more entry, written with the file's own indentation, and a file that is not plain JSON (with comments, say) is refused, to be edited by hand. Every change is recorded in `<data>/installed.json`, and every file is copied to `<data>/backups/` before it is edited. `uninstall` takes the changes back in reverse order: the files are as they were, byte for byte, unless you edited them in between (then only what `init` added is taken out), and a file `init` created is deleted. When no agent is left, it removes the launcher and the server too, and keeps the repository.

An agent that already has a `protocol_chaos` server (for Hermes, a `PROTOCOL_CHAOS_URL` in its `.env`) is left as it is. When that server is elsewhere (a URL), the agents `init` would connect now would get a separate repository on this computer, not that one: `init` says so and asks, and with `--yes` it does not connect them. Hermes folds the words it records itself, with its plugin, so the server does not queue them for the organizer.

By hand, the entry for DeepSeek Harness, in `~/.dsh/cordis.patch.yml`, is:

```yaml
- insert:
    - id: protocol-chaos-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: protocol_chaos
        transport: stdio
        command: npx
        args: ['-y', 'protocol-chaos@0.2', '--client', 'dsh']
```

## Organizing in the background

An assistant records the user's words with `event_note` and goes on; folding them into their matter's fields (goal, constraint, plan, progress, state, the people and places involved) happens after, away from the conversation, as the Hermes plugin does after each answer:

1. The server that receives an `event_note` queues the words in `<data>/organizer/queue/` and starts a detached `protocol-chaos organize --pending`, so the call returns at once.
2. Once the assistant has finished its turn (15 seconds after the last words queued), that process folds each recorded sentence into its matter with **one** call to the organizer's model: it is shown the matter as it stands, where it sits (the matter it is part of, its open parts), its last six words and the new ones, and answers with only what changes (the rules are `FOLD_INSTRUCTIONS` in `organize.mjs`). The change is written with `event_record_expression`, grounded on those words, as `{"kind": "agent", "id": "organizer"}`. When someone wrote the matter in between, it reads again once and keeps what they changed.
3. A **daily sweep** at 04:00 (`organize --sweep`, from launchd on macOS or a systemd user timer on Linux) folds the words nobody folded: recorded while organizing was off, or whose fold failed. When the repository has not changed since the last sweep, it ends without calling a model.

The organizer is one of the connected agents, run headless: **DeepSeek Harness** (`dsh --profile headless --permission-mode read-only --approval-policy never --json`, with an overlay that uses the keys saved in the app, leaves out every tool, the session title, the upload of the session log and the session history on disk, and runs `deepseek-flash` with thinking off: about 1,400 tokens and 2 seconds a sentence), then **Claude Code** (`claude -p`, with the `haiku` model, no tools, no MCP servers and a spending cap of 0.2 USD a call), then **Codex** (`codex exec`, read-only; not yet run by us). `init` picks the first connected one and says what it sends: the matter and its recent words go to that agent's model provider. `--organizer claude-code` picks another, `--organizer none` turns organizing off, and `--no-schedule` leaves out the daily sweep. The choice is in `<data>/organizer.json`.

Kiro and Cursor cannot organize: neither has a headless run tried by us yet. When none of the connected agents can (or organizing is turned off), each `event_note` an agent connected by `init` makes is answered with a second text after the receipt, reminding its model to bring the matter's fields up to date itself with `event_record_expression`. Hermes is not reminded: its plugin folds its own words.

The organizer's runs cannot start the organizer again: its words are not queued, its agent runs without this repository's MCP server, and every process it starts carries `PROTOCOL_CHAOS_ORGANIZING=1`. `npx protocol-chaos organize --status` shows the organizer, the queue and the last runs; the log (`<data>/organizer/log.jsonl`) holds ids, outcomes, times and token counts, never words. An organizer run that calls a tool anyway is not used, and words whose fold fails three times are given up, so that the daily sweep does not pay for them every day. A check of the rules with real models, and an end-to-end run with DeepSeek Harness, are in [eval/organize/](../eval/organize/README.md).

## Importing other assistants' memories

A new repository starts empty, while the assistants on the computer already keep notes about the user. `npx protocol-chaos import` (and `init`, once) reads those notes and turns the matters they show into Events:

```sh
npx protocol-chaos import [--yes] [--only <agents>] [--data <directory>]   show what it would read and cost, ask, import
npx protocol-chaos import --status [--data <directory>]                    how far it got; the report when done
npx protocol-chaos import --undo [--data <directory>]                      cancel the matters the import started
```

**What it reads.** Claude Code's `CLAUDE.md` and memory folders (`~/.claude/projects/*/memory/`, without the index `MEMORY.md`), Codex's `AGENTS.md` and `memories/`, Gemini CLI's `GEMINI.md`, Hermes's `MEMORY.md` and `USER.md` (and each profile's), the steering files Kiro includes in every conversation, Cursor's `AGENTS.md` and `rules/`, and DeepSeek Harness's `AGENTS.md`. It leaves out the blocks `init` wrote, files that hold rules for using this repository (they name `protocol_chaos` or its tools), steering files Kiro includes only in some conversations, and files over 60,000 characters. Keys, tokens, passwords, ID and card numbers are replaced by `[hidden]` before anything is sent. The files are only read.

**Asking first.** The plan says which files it would read and leave out, how many parts it would send, about how many tokens and minutes that takes (an estimate), and where the text goes: the memory files and the repository stay on the computer; to organize them, the text is sent to the organizer's model, through that agent's provider, as when you use the agent yourself; Protocol Chaos itself has no server and sends nothing anywhere else. `init` asks in the terminal; with `--yes`, or without a terminal, it leaves the import pending, and `--no-import` declines it.

**In an assistant.** While an import is pending, running, or finished but not yet reported, a connection from this computer that records words is offered one more tool, `memories_import`, and the server's instructions end with a paragraph saying so (where the instructions are written down instead, the line `init` adds there does the same). The assistant calls it with action `status` in its first reply, tells the user what the plan says and asks; `start` and `decline` follow the user's answer. A pending import nobody answers is offered on three days, then no more. When it is done, `status` returns the report: how many matters were started and added to, the tokens used, any problems, and the tree of open matters, the new ones marked `+`; the assistant shows it and calls `finish`, and the tool is not offered again.

**How it runs.** With an organizer, in the background (`protocol-chaos import --run`, started detached): one call to the organizer's model per part of about 6,000 characters, shown the repository's open matters and the part (`IMPORT_INSTRUCTIONS` in `memories.mjs`). The model lists the matters the part shows, each with the sentences of the notes it rests on, copied exactly; a matter none of whose sentences is in the part is left out, so nothing is written that the notes do not say. Each matter is written as `{"kind": "agent", "id": "importer"}`: a new one with `event_note` (`accountSource: "authorized_external"`, `via` naming the file, its title, and its parent when it is a part of another), then its state, progress and facts with `event_record_expression`, grounded on those words; words on a matter the repository holds already are added to it, and only the facts it lacks are filled in. The repository is copied to `<data>/import/` first. A desktop notification says when it is done (macOS, or `notify-send` on Linux). Without an organizer (only Kiro or Cursor connected, say), the assistant in the conversation does the model's part: `start` hands it the first part and the same rules, and it answers each part with `record`.

`--undo` cancels the matters the import started, except those someone has written on since; words are never deleted. The state is in `<data>/import/state.json`, and the log (`<data>/import/log.jsonl`) holds parts, outcomes, times and token counts, never words. A check with a real model is in [eval/import/](../eval/import/README.md).

## Storage

The repository is one file, `repository.json`, in the export format of §8.6. You can read it, back it up by copying it, and move it to another server by importing it. The file is created readable only by you, and the server never sends it anywhere; what the organizer and an import send to a model is said in their sections above.

Several assistants on one computer can share it: each usually starts its own server process. A write takes a lock file, reads what the other processes committed, and replaces the file in one step, so no process overwrites another's words and the file is never half-written. A damaged file is reported by every call and left as it is.

## Remote

Assistants on several computers, and cloud assistants, can share one repository through a server reached over HTTP.

1. **Give each assistant its own token.** It is shown once. The server keeps only its hash, in `clients.json` next to the repository, readable only by you.

   ```sh
   npx -y protocol-chaos@0.2 clients add laptop
   ```

2. **Start the server.** Plain HTTP is served only on a loopback address: a server other machines can reach must use TLS (§9.2). Either put a reverse proxy that terminates TLS, such as Caddy or nginx, in front of `--http 127.0.0.1:8721`, or give the server a certificate:

   ```sh
   npx -y protocol-chaos@0.2 --http 0.0.0.0:8721 --tls-cert cert.pem --tls-key key.pem
   ```

3. **Point the assistant at the server**, `https://<your host>/mcp`, with the header `Authorization: Bearer <token>`:

   - **Claude Code:**

     ```sh
     claude mcp add --scope user --transport http protocol_chaos https://host.example/mcp --header "Authorization: Bearer <token>"
     ```

   - **Codex**, in `~/.codex/config.toml`:

     ```toml
     [mcp_servers.protocol_chaos]
     url = "https://host.example/mcp"
     http_headers = { Authorization = "Bearer <token>" }
     ```

   - **Cursor, Kiro** and other clients configured in JSON:

     ```json
     { "mcpServers": { "protocol_chaos": { "url": "https://host.example/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
     ```

Over HTTP the server applies §9.2:

- A client writes only as `{"kind": "agent", "id": "<its name>"}`; any other actor fails with `ACTOR_MISMATCH`. The server's instructions tell each client its name.
- `event_record_expression`, `event_add_parent`, `event_remove_parent` and `entity_record` need `expectedVersion`, or fail with `VERSION_REQUIRED`.
- Requests from a browser page, which carry an `Origin` header, are refused.
- `clients remove <name>` revokes a token at once, without a restart.

The server keeps no sessions: each request is answered on its own, so it can be restarted at any time.

## Limits

- Every client can read the whole repository; what each one may read is not designed yet (PROTOCOL.md §13). Give a token only to an assistant you would trust with all of it.
- Search matches words, not meaning.
- The whole file is read after another process writes, and rewritten on every write. That is fine for one person's matters, and not meant for more.

## Tests

```sh
npm test
```

runs the storage tests (restart, several processes, a damaged file), the HTTP tests (tokens, browser requests, revocation, and the conformance tests over HTTP), the installer tests (every agent in a throwaway home folder, put back byte for byte), the organizer and import tests (with a stand-in for the model), and the conformance tests over stdio.
