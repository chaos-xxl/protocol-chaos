# Reference server

A small server that implements [draft 0.2](../PROTOCOL.md) at every level: Core, Entities, Search, Sync, Undo and Remote. It is here to try the protocol with your own assistants and to check other implementations against; it passes every [conformance test](../conformance/README.md).

It was written from the specification alone, by an agent that had never seen another implementation, as a test that the document is enough.

```sh
npx -y protocol-chaos@0.2 [--data <directory>] [--owner-tools]          # MCP over stdio, one computer
npx -y protocol-chaos@0.2 --http 127.0.0.1:8721 [--data <directory>]    # MCP over HTTP, several computers
npx -y protocol-chaos@0.2 clients add <name> | list | remove <name>     # the tokens for HTTP
node server/index.mjs …                                                 # the same, from a clone
```

| Option | |
|---|---|
| `--data` | Where the repository lives. Default: `$PROTOCOL_CHAOS_DATA`, then `~/.protocol-chaos`. |
| `--owner-tools` | Also offer `repository_export` and `repository_import`. An export holds everything, so these are off unless the owner asks (PROTOCOL.md §8.6, §10). Over HTTP, every client could then export the whole repository. |
| `--http [host:]port` | Serve MCP streamable HTTP at `/mcp` instead of stdio: the Remote level (§9.2). The host defaults to `127.0.0.1`. |
| `--tls-cert`, `--tls-key` | Serve HTTPS with this certificate and private key. Needed to listen on an address other machines can reach. |

## Storage

The repository is one file, `repository.json`, in the export format of §8.6. You can read it, back it up by copying it, and move it to another server by importing it. The file is created readable only by you, and the server sends it nowhere.

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

runs the storage tests (restart, several processes, a damaged file), the HTTP tests (tokens, browser requests, revocation, and the conformance tests over HTTP), and the conformance tests over stdio.
