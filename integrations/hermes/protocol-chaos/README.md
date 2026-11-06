# Protocol Chaos for Hermes

Tell any of your assistants about a plan, a change or a decision, and Hermes knows it too.
Your long-lived matters (a trip next spring, a renovation, a job search, a five-year goal) live
on your own [Protocol Chaos](https://github.com/chaos-xxl/protocol-chaos) server, which Hermes
and your other assistants (Codex, Claude Code, Kiro, anything that can use an MCP server) all
read and write. Each records what you tell it. Once a day Hermes folds everything they
recorded into one record per matter: where it stands, what it is for, its limits and plan, and
who said what, when.

It is not a memory provider and does not replace yours: it runs beside it. Your matters stay on
your server, and the server never sees your messages, only the words recorded from them.

This plugin connects [Hermes Agent](https://github.com/NousResearch/hermes-agent) to that
server, and the repository never holds up a reply:

- **Before the model answers.** When a session starts, an overview of your open matters goes
  into the system prompt. On each message, the plugin compares the message with the matters'
  titles on this machine; for the few it plainly names, it reads their goal, constraints,
  plan, progress and latest words by id and adds them to the turn.
- **After the model answers.** In a background thread, Hermes's recording model decides
  whether your message changes one of your matters or starts one, and which. If so, the
  plugin records your words with `event_note`, copied from the message itself, so they are
  stored verbatim. Then it folds them into that matter: its goal, constraints, plan,
  progress, state and the people and places involved, grounded on the words just recorded and
  read with the last few messages of the conversation, so that "let's take the second option"
  is understood. The next turn, and every other assistant on your server, sees the change.
- **Once a day.** A bundled skill, `protocol-chaos:organizer`, reads what all your assistants
  recorded that day and organizes it: it completes each matter's fields, links parts to the
  matters they belong to, merges duplicates, and keeps records of the people and places you
  mention. Turn it on with `/blueprint protocol-chaos:organizer`.

**One week, measured.** The author used it for a week on draft 0.2, with four assistants
sharing one server. 45 entries were recorded, 41 of them by assistants other than Hermes. Of
the 45, 29 were the author's own words, 15 the assistants' notes on what they did, and 1 a copy
the organizer made. Of the organizer's 54 changes, 46 rested on words another assistant had
recorded; checked one by one, no wrong fact was found. In conversation, on the one afternoon
it was used, Hermes recorded 3 entries and made 11 changes, 5 of which put the details of one
breakdown on the long-lived matter above it; 0.3.0 records such an episode on a part of its
own. Nothing was lost or edited across nine daily backups. One person, one week: an
observation, not a benchmark.

Everything fails open: if the server is unreachable or answers with an error, the turn goes on
as it would without the plugin. The plugin logs ids, counts, times and token counts, never what
you said: one line per turn with how long it took before the model answered
(`turn context in 0.31s`), and one per model call with its time and tokens (`recording decided
in 1.2s, skip (1830 in, 12 out, …)`, `structure answered in …`).

When a message is about one episode of a long-lived matter, such as a breakdown of the home
network or one trip among your travel plans, the plugin records it on a part of its own,
titled with when it happened, so that what holds only for that episode stays out of the
long-lived matter.

## What leaves this machine

- **To your Protocol Chaos server** (the URL you configure): requests for its directory, reads
  of the matters this plugin picked, by id, and the words it records. Never the messages
  themselves: deciding what is relevant happens here (see §10 of the
  [protocol](https://github.com/chaos-xxl/protocol-chaos/blob/main/PROTOCOL.md)).
- **To the model provider Hermes already uses**, only for recording, through Hermes's own
  auxiliary-model route: your message, up to 600 characters of the assistant's previous reply,
  and the titles and states of your matters (up to about 6,000 characters), with today's date.
  When it records, also the matter it records on (its current fields, its latest words, and the
  titles of the larger matters it belongs to and of its open parts) and the last few messages of
  the conversation with the assistant's reply (up to about 6,000 characters).
- Nothing else. No telemetry, no other network calls, no files read outside the plugin's own
  directory. One short-lived background thread per message it considers recording: one model
  call to decide, and one more when it records.
- **What Hermes keeps.** Hermes saves the context the plugin adds to a turn with that turn in
  its session database and sends it again on later turns of the session, as it does with any
  plugin's added context
  ([hermes-agent#143739](https://github.com/NousResearch/hermes-agent/issues/143739)). The
  details of the matters a turn named therefore stay in Hermes's session history, and its
  background memory review reads them along with the rest of the conversation.

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
protocol-chaos 0.3.0: overview in system prompt, recording background, structure auto
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
| `structure` | `auto` | `auto` folds recorded words into their matter's fields right away; `off` leaves that to the organizer. Needs background recording. |
| `overview` | `auto` | Where the overview goes: the system prompt (`auto`, `prompt`), the first turn's message (`turn`), or nowhere (`off`). |

Recording and the structure update run as the auxiliary task `protocol_chaos_capture`, which
follows the model configured for compression, a small and cheap one. Pin another under
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

Then turn the organizer on, from a chat with Hermes:

```text
/blueprint protocol-chaos:organizer
```

It asks for a time (04:00 by default) and where to report, and creates a daily job. On a Hermes
older than 0.21.7, which has no blueprints, create the job yourself:

```text
/cron add "every day at 4am" "Load the skill protocol-chaos:organizer with skill_view and follow it exactly."
```

The job reads the words with `event_words_since`, writes with the structured tools, keeps its
checkpoint in `~/.hermes/protocol-chaos/organizer-checkpoint`, and reports to the chat it was
created from: a few lines on what it organized and what needs your decision, or nothing
(`[SILENT]`) when there was nothing to do. Scheduled turns and subagents get no added context,
and nothing of theirs is recorded. Scheduled jobs also get no overview in their system prompt:
a job that needs your matters reads them with the repository's tools, as the organizer does.
Hermes does not tell the plugin when it builds a subagent's system prompt, so subagents still
get the overview there.

## Uninstall

`hermes plugins remove protocol-chaos`, and remove the scheduled job if you made one. Your
matters stay on your server.
