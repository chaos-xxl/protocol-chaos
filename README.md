# Protocol Chaos · 混沌协议

**Your matters belong to you. Your AI can change.**

Protocol Chaos is an open protocol for a common layer of the matters a person holds: the long-lived things they tell their AI assistants about, such as a trip, a course, a renovation, a decision or an ambition. The matters live in one repository the user controls. Any compatible assistant can read them, add to them and connect them, and they outlast any one assistant.

[中文说明](README.zh-CN.md)

> **Draft 0.2, October 2026.** The specification may still change, and drafts carry no compatibility promise. Comments and implementations are welcome.

## Try it in five minutes

You need Node.js 20 or later and an assistant that can use MCP servers. Add the reference server to your assistants under the name `protocol_chaos`:

- **Claude Code:** `claude mcp add --scope user protocol_chaos -- npx -y protocol-chaos@0.2`
- **Codex**, in `~/.codex/config.toml`:

  ```toml
  [mcp_servers.protocol_chaos]
  command = "npx"
  args = ["-y", "protocol-chaos@0.2"]
  ```

- **Claude Desktop, Cursor, Kiro** and other clients configured in JSON (`claude_desktop_config.json`, `~/.cursor/mcp.json`, `~/.kiro/settings/mcp.json`):

  ```json
  { "mcpServers": { "protocol_chaos": { "command": "npx", "args": ["-y", "protocol-chaos@0.2"] } } }
  ```

`protocol-chaos@0.2` follows this draft and its fixes; a later draft will be `0.3`. To run it from a clone instead, use `git clone`, `npm ci`, and `node /path/to/protocol-chaos/server/index.mjs` as the command.

Then tell one assistant about something you are planning, for example "I'd like to get into street photography, but only at weekends". Open another assistant, or a new conversation, and ask what you said about photography. The matter is in `~/.protocol-chaos/repository.json`, a plain JSON file that is yours.

Give each assistant the standing instructions from the [agent guide](docs/agent-guide.md#server-instructions) too: MCP tells an assistant which tools exist, not when to use them.

## Why

Many people already use several assistants: one for daily life, one at work, another for code. Each keeps its own memory, but a person's matters do not split along those lines. The same plan is explained again to every new assistant, and it is lost when the tool changes.

The matters are not isolated either. What looks like a one-off rarely is: a trip belongs to a wish to see more of the world, a camera serves a hobby, a move touches the whole family. Protocol Chaos keeps these matters, called **Events**, and the ways they connect, in one place that belongs to the user. Assistants come and go; they read the same repository and add to it, each under its own name.

## What the protocol defines

The protocol standardises the envelope and leaves the content in natural language:

- **Events**: a title, a state, where the Event stands, what it is meant to achieve, the conditions it must meet, the plan as decided, the people, places and things it involves, and the larger Events it is part of. An Event may hold nothing but one sentence: sparse is normal.
- **The user's words**, kept verbatim and never edited. What an assistant infers is marked as an inference, with its basis, and the user's words win.
- **Entities**: the people, animals, things and places the user refers to, the user included, each described by one-fact Statements.
- **Revisions**: every change names who made it and the words it rests on.
- **Rules for writers**: what to record and what not to, so that every assistant writing to the same repository behaves the same way.
- **Export and import**: a repository can always be taken out whole and moved.

How a client finds the Events a conversation is about, how it ranks them and when it tidies up are left to the client. The full rules are in **[PROTOCOL.md](PROTOCOL.md)**.

## What is in this repository

| | |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | The specification. Normative. |
| [conformance/](conformance/README.md) | Tests that check any server over MCP, whatever its language. |
| [server/](server/README.md) | A reference server, for trying the protocol on one computer and checking other implementations against. |
| [docs/agent-guide.md](docs/agent-guide.md) | How an assistant can use a repository well: answer first, record after, organise later. Not normative. |

Nothing here runs as a service. A server runs where its owner puts it: on their own computer, on a machine they control, or in a cloud they choose.

## Implementing a server

1. Read [PROTOCOL.md](PROTOCOL.md). Start with the Core level; Entities, Search, Sync, Undo and Remote are optional levels (§12).
2. Offer the operations as MCP tools (§9.1): over stdio for one computer, or over streamable HTTP with a credential for each client when several computers share a repository (§9.2).
3. Run the conformance tests against it, with no need to clone anything:

   ```sh
   npx -y -p protocol-chaos@0.2 protocol-chaos-conformance --stdio "node my-server.js --data {tmp}"
   ```

   `{tmp}` becomes a fresh, empty directory for each server the suite starts. The tests write data, so they refuse to run against a repository that is not empty. From a clone, `node conformance/run.mjs` takes the same options.

The specification is meant to be enough on its own. As a check, an agent that had never seen any implementation wrote a server from this document alone. Its first attempt passed 39 of the 40 Core tests of the time, and the one gap it found has been fixed in the document. That server is the reference server here; `npm test` runs every test against it.

## Your data

- The repository belongs to its user. Every conforming server lets the owner export everything and import it into another server (§8.6), so the user can always leave with their matters.
- The reference server keeps the repository in one file on your computer and sends it nowhere.
- Today every connected assistant can read every Event and Entity; per-client visibility is an open issue (§13). Connect only assistants you would trust with the whole repository. What an assistant reads enters its model context and is processed by its provider.
- Assistants are told never to record passwords, tokens or identity-document numbers (§7).

## Status

Draft 0.2 grew out of daily use: the author uses an implementation of draft 0.1 every day, with several assistants on different computers sharing one repository. Draft 0.2 keeps what that use showed to matter and drops what was never used. That implementation, the `protocol-chaos` package on npm, is not part of this repository and is moving to this draft.

Open issues include per-client visibility, recognising the same person across applications, deletion, and Events shared by several people ([§13](PROTOCOL.md#13-open-issues)).

## Contributing

Questions, cases from real use and implementations are welcome as issues. A change to the specification is proposed as a change to PROTOCOL.md, together with the conformance test that checks it.

Part of the Chaos family, alongside **Doctor Chaos**.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
