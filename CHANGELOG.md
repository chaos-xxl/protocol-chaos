# Changelog

The specification and the `protocol-chaos` package, which holds the reference server and the conformance tests, are listed together. A package version follows the draft it implements: 0.2.x implements draft 0.2.

## protocol-chaos 0.2.2 (2026-10-20)

- The npm page shows the English README. The Chinese one stays in the repository, linked from it.

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
