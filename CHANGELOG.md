# Changelog

The specification and the `protocol-chaos` package, which holds the reference server and the conformance tests, are listed together. A package version follows the draft it implements: 0.2.x implements draft 0.2.

## Unreleased
- **A plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent)**, in [integrations/hermes/](integrations/hermes/protocol-chaos/README.md). Before the model answers, an overview of the user's open matters is in the system prompt, and the matters a message names, picked on the client from the directory's titles, are read by id and added to the turn. After it answers, the recording model decides whether the message changes a matter, and the words are recorded with `event_note`, verbatim. The server never receives the messages (§10). Includes an organizer skill for draft 0.2 and passes `hermes plugins validate`. Hermes installs it from this repository; it is not in the npm package.
## protocol-chaos 0.2.3 (2026-10-22)

- **The reference server implements the Remote level (§9.2).** `--http [host:]port` serves MCP streamable HTTP at `/mcp`. Each assistant gets its own token (`protocol-chaos clients add <name>`), kept only as a hash and revoked at once by `clients remove`. Over HTTP a client writes only as itself (`ACTOR_MISMATCH` otherwise), the writes that change fields or parents need `expectedVersion` (`VERSION_REQUIRED`), and requests from a browser page are refused. Plain HTTP is served only on a loopback address; elsewhere the server needs `--tls-cert` and `--tls-key`, or a TLS reverse proxy in front. See [server/README.md](server/README.md#remote).
- Every conformance test that can run over `--url` passes over HTTP; the tests now run that way too.

## protocol-chaos 0.2.2 (2026-10-21)

- The npm page shows the English README. npm packs every `README*` file at the root of a package and showed the Chinese one, which has moved to [docs/README.zh-CN.md](docs/README.zh-CN.md).

## protocol-chaos 0.2.1 (2026-10-20)

- Conformance tests: a server started with `npx`, from a test run that was itself started with `npx`, now starts. npm's own environment variables are no longer passed on to the server.
- The reference server reports the package version it was released as.
- The package carries the rewritten README.

## Draft 0.2 and protocol-chaos 0.2.0 (2026-10-20)

The first public draft, and the first release of the reference server.

- **Specification.** One flat Event document: title, state, progress, facts, refs, parents and metadata. A single `state` with six values, writer rules (§7), and the principle that clients decide on their own side what to send (§10). Everything is defined for interoperability only: matching, storage and models are left to implementations. [Appendix A](PROTOCOL.md#appendix-a-changes-from-draft-01) lists every change from draft 0.1.
- **Conformance tests.** 75 tests over MCP, covering every requirement on servers at the levels Core, Entities, Search, Sync, Undo and Remote.
- **Reference server.** Core, Entities, Search, Sync and Undo over MCP stdio, written from the specification alone. The repository is one JSON file in the export format, shared safely by several assistants on one computer. `npx -y protocol-chaos@0.2`.

## Draft 0.1 (protocol-chaos 0.1.0-alpha.1 to 0.1.0-alpha.11, September to October 2026)

The working draft behind the author's daily use, with several assistants on different computers sharing one repository. It was implemented by the 0.1.0-alpha versions of `protocol-chaos`, which are still available as `protocol-chaos@alpha`, and is replaced by draft 0.2.
