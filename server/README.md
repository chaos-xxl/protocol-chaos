# Reference server

A small server that implements [draft 0.2](../PROTOCOL.md) at the levels Core, Entities, Search, Sync and Undo, over MCP stdio. It is here to try the protocol with your own assistants and to check other implementations against; it passes every [conformance test](../conformance/README.md) of those levels.

It was written from the specification alone, by an agent that had never seen another implementation, as a test that the document is enough.

```sh
npx -y protocol-chaos@0.2 [--data <directory>] [--owner-tools]
node server/index.mjs [--data <directory>] [--owner-tools]     # from a clone
```

| Option | |
|---|---|
| `--data` | Where the repository lives. Default: `$PROTOCOL_CHAOS_DATA`, then `~/.protocol-chaos`. |
| `--owner-tools` | Also offer `repository_export` and `repository_import`. An export holds everything, so these are off unless the owner asks (PROTOCOL.md §8.6, §10). |

## Storage

The repository is one file, `repository.json`, in the export format of §8.6. You can read it, back it up by copying it, and move it to another server by importing it. The file is created readable only by you, and the server sends it nowhere.

Several assistants on one computer can share it: each usually starts its own server process. A write takes a lock file, reads what the other processes committed, and replaces the file in one step, so no process overwrites another's words and the file is never half-written. A damaged file is reported by every call and left as it is.

## Limits

- One computer only: there is no network binding yet (the Remote level, §9.2). To share a repository between computers, a server has to implement §9.2.
- Search matches words, not meaning.
- The whole file is read after another process writes, and rewritten on every write. That is fine for one person's matters, and not meant for more.

## Tests

```sh
npm test
```

runs the storage tests (restart, several processes, a damaged file) and the conformance tests against this server.
