# Protocol Chaos for Hermes

Your long-lived matters (a trip next spring, a renovation, a job search, a five-year goal) live
on your own [Protocol Chaos](https://github.com/chaos-xxl/protocol-chaos) server, where every
assistant you use can read and add to them. This plugin connects
[Hermes Agent](https://github.com/NousResearch/hermes-agent) to that server so that the
repository never holds up a reply:

- **Before the model answers.** When a session starts, an overview of your open matters goes
  into the system prompt. On each message, the plugin compares the message with the matters'
  titles on this machine; for the few it plainly names, it reads their goal, constraints,
  plan, progress and latest words by id and adds them to the turn.
- **After the model answers.** In a background thread, Hermes's recording model decides
  whether your message changes one of your matters or starts one, and which. If so, the
  plugin records your words with `event_note`, copied from the message itself, so they are
  stored verbatim.
- **Later, optionally.** A bundled skill, `protocol-chaos:organizer`, folds the words recorded
  during the day into structure: facts, titles, people, progress, the hierarchy. Run it on a
  schedule.

Everything fails open: if the server is unreachable or answers with an error, the turn goes on
as it would without the plugin. The plugin logs ids and counts, never what you said.

## What leaves this machine

- **To your Protocol Chaos server** (the URL you configure): requests for its directory, reads
  of the matters this plugin picked, by id, and the words it records. Never the messages
  themselves: deciding what is relevant happens here (see §10 of the
  [protocol](https://github.com/chaos-xxl/protocol-chaos/blob/main/PROTOCOL.md)).
- **To the model provider Hermes already uses**, only for recording, through Hermes's own
  auxiliary-model route: your message, up to 600 characters of the assistant's previous reply,
  and the titles and states of your matters (up to about 6,000 characters).
- Nothing else. No telemetry, no other network calls, no files read outside the plugin's own
  directory. One short-lived background thread per recorded turn.

## Requirements

- Hermes 0.21.1 or later.
- A Protocol Chaos server that speaks draft 0.2 over HTTP and that this Hermes can reach, with
  a token for this client. With the reference server (0.2.3 or later), on the machine that
  holds the repository:

  ```bash
  npx protocol-chaos clients add hermes      # prints the token once
  npx protocol-chaos --http 127.0.0.1:8721   # behind a TLS reverse proxy for other machines
  ```

  See [Remote](https://github.com/chaos-xxl/protocol-chaos/blob/main/server/README.md#remote).

## Install

```bash
hermes plugins install chaos-xxl/protocol-chaos#integrations/hermes/protocol-chaos --enable
```

Hermes asks for two values and keeps them with your other credentials:

| Variable | Value |
|---|---|
| `PROTOCOL_CHAOS_URL` | The server's MCP endpoint, such as `https://example.org:8443/mcp` |
| `PROTOCOL_CHAOS_TOKEN` | The token from `clients add hermes` |

Restart Hermes (and the gateway, if one runs). The log then shows one line:

```text
protocol-chaos 0.2.0: overview in system prompt, recording background
```

`overview in first turn` on a Hermes without system prompt sections; `recording model` where
Hermes has no plugin model access, in which case the added context asks the model itself to
record with `event_note` (that needs the MCP server below).

## Settings

Under `plugins.entries.protocol-chaos.settings` (the plugin's page in Hermes Desktop shows them
as a form):

| Key | Default | Meaning |
|---|---|---|
| `actor` | `hermes` | The client name the token was issued for. The plugin writes as `{"kind": "agent", "id": <actor>}`. |
| `capture` | `auto` | `auto` records in the background after each answer; `model` asks the model to record; `off` records nothing. |
| `overview` | `auto` | Where the overview goes: the system prompt (`auto`, `prompt`), the first turn's message (`turn`), or nowhere (`off`). |

Recording runs as the auxiliary task `protocol_chaos_capture`, which follows the model
configured for compression, a small and cheap one. Pin another under
`auxiliary.protocol_chaos_capture`.

## The organizer

The organizer and the model's own reads and writes use the repository's tools, so add the same
server as an MCP server named `protocol_chaos` too. Hermes fills `${...}` in an MCP server's
settings from your credentials when it connects, so the entry can reuse the plugin's two values
and a new token is set in one place:

```yaml
mcp_servers:
  protocol_chaos:
    url: "${PROTOCOL_CHAOS_URL}"
    headers:
      Authorization: "Bearer ${PROTOCOL_CHAOS_TOKEN}"
```

Then create a scheduled job, for example from a chat with Hermes:

```text
/cron add "every day at 4am" "Load the skill protocol-chaos:organizer with skill_view and follow it exactly."
```

The job reads the words with `event_words_since`, writes with the structured tools, keeps its
checkpoint in `~/.hermes/protocol-chaos/organizer-checkpoint`, and reports to the chat it was
created from: a few lines on what it organized and what needs your decision, or nothing
(`[SILENT]`) when there was nothing to do. Scheduled turns and subagents get no added context,
and nothing of theirs is recorded.

## Uninstall

`hermes plugins remove protocol-chaos`, and remove the scheduled job if you made one. Your
matters stay on your server.
