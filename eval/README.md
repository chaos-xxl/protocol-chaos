# Protocol Chaos against plain-text memory: the controlled experiment

**Question.** When several assistants share one store across many sessions, where does keeping the user's matters in Protocol Chaos answer better than keeping them as plain-text memory, and where does plain text answer better?

This is not a general memory benchmark, and it does not test the protocol's product features (nightly organizing, plugins). It compares three ways of storing the same things, with everything else held equal. The plan, the sample sizes and the decision rules are fixed in a pre-registration before the formal run; this file describes the harness that runs it.

## The three arms

| Arm | Store | Injected when a session starts | Tools |
|---|---|---|---|
| **P** | the reference server of this repository, over local HTTP, one bearer token per assistant | the directory (`context_pack`, every page), one line per Event with everything it returns | the server's tools for the `writer` profile (`--tools writer`): `context_pack`, `event_search`, `event_get_protocol`, `event_note`, `event_record_expression`, as it lists them |
| **T1** entries | one list of entries, like the built-in memory of Hermes Agent, with no size limit | every entry | `memory`: `add`, `replace` and `remove`; `replace` and `remove` find one entry by a unique substring |
| **T2** files | one Markdown file per matter, plus `index.md` | `index.md` | `notes_view`, `notes_search`, `notes_create`, `notes_str_replace`, `notes_append` |

Held equal across arms: the model, its settings, the user's scripted words, the dates, the background library (written in each arm's own form, checked to hold the same information), and the shared instructions, word for word. Only the paragraph on how to use the store differs. Every arm organizes as it records: P records the words with `event_note` and then updates the fields with `event_record_expression`; T1 edits its entries; T2 edits its files and the index. No nightly organizer runs.

## How a case runs

A case is a scripted timeline: on which day, to which assistant (A, B or C), the user said what. The gold answers come from the same timeline.

1. **Store.** The case starts from a copy of the background library (10, 50 or 150 matters), plus the case's own seed matters, in the arm's form.
2. **Sessions.** Each scripted message is one new conversation with one assistant on one date. The harness sends the system prompt (shared part, arm part, injected store view) and the user's message; the model answers or calls tools; the harness runs each call against the arm's store and returns the result, until the model answers without a tool call. For P, a server process is started for each session with its clock fixed to that session's date (`eval/lib/clock-preload.mjs`), so the server records the simulated date.
3. **Frozen store.** After the last session the store is copied.
4. **Probes.** Each question starts a new conversation from its own copy of the frozen store, so one question cannot change what another sees. The model ends its reply with `ANSWER: …`.
5. **Scoring.** Rules, not a model: the answer is matched against the gold value. Outcomes are `correct`, `stale` (an earlier value from the timeline), `wrong`, `unknown` (the model says the store does not have it) and `unparseable`. Unparseable answers go to a review packet with ids and arm removed.

Every request and response, every tool call and result, and the token usage of every request (input, cached input, output, reasoning) are written to the run directory.

## Categories

| | Asks | Where P has a mechanism text lacks | Answer |
|---|---|---|---|
| D1 current value | after several changes by different assistants, what is it now | one current value per field | number or date |
| D2 provenance | who changed it, on which day, and was it the user's words or an inference | every write records its writer and time; words and inferences are stored apart | `{who, date, kind}` |
| D3 not mixed | two very similar matters, asked one at a time | one identity per matter | number or date |
| D4 episode and long term | during one episode, what holds for the long-lived matter | the episode is a matter of its own, under the long-lived one | option |
| D5 parent condition | a question about a part whose answer depends on a condition set on its parent | explicit parents | option or number |
| D6 states | which matters are waiting on someone, which are settled | a state field on every matter | multi-select |
| N1 no worse | one matter, one value, a small library | none; both should do equally well | number |
| X1 across matters | which matters involve money | none; full-text search may do better | multi-select |
| X2 no shared words | the question shares no word with the matter's title | none; P picks matters by title | number or option |
| X3 recorded elsewhere | the information was recorded under another matter | none; full-text search may do better | number or option |

D7, two assistants writing at once, is not a model comparison: `eval/lib/d7.mjs` replays one interleaving (A's conversation reads the matter, B's raises the budget, then A writes) against each arm's real tools, in four variants of what A writes, and reports whether A's change landed, whether B's survived, and whether A was told. `node eval/cli.mjs d7` prints the table; `eval/test/d7.test.mjs` pins it.

## Formats

### Template

A template is a JSON file in `eval/templates/<split>/`. Its variants expand into cases; `{name}` in any string is replaced by the variant's value.

```json
{
  "id": "d1-moving-budget",
  "category": "D1",
  "author": "kiro",
  "shape": "One value changed twice, by two assistants.",
  "library": 150,
  "keywords": ["搬家"],
  "variants": [{ "v1": "20000", "v2": "25000" }],
  "seed": [],
  "sessions": [
    { "day": 0, "assistant": "A", "user": "下个月搬家，预算先定 {v1} 元。" },
    { "day": 5, "assistant": "B", "user": "搬家的预算改成 {v2} 元吧。" }
  ],
  "probes": [
    { "day": 9, "assistant": "C", "question": "我搬家的预算现在是多少？",
      "answer": { "type": "number", "value": "{v2}", "unit": "元", "stale": ["{v1}"] } }
  ]
}
```

- `day` counts from the case's day 0 (2026-10-05). A session or probe may give `"time": "HH:MM"`, Beijing time between 08:00 and 23:59 (default 20:00), so that its date is the same in Beijing and in UTC. Sessions are in time order, and probes come after the last session.
- `keywords` are words that identify the case's matters. The background library must not contain them, so every probe has one right matter.
- `seed` lists matters that exist before the first session, in the matter format below with `day` offsets instead of dates. A seed's `parent` names another seed's `key`.
- Answer types:
  - `number`: `value`, optional `unit`, `stale` (earlier values) and `confused` (values of a similar matter in the case, counted as wrong and marked). Units, thousands separators, 万 and Chinese numerals (两万五) are understood.
  - `date`: `value` as `YYYY-MM-DD`, or `day` as an offset; optional `stale`.
  - `option`: `options` as `{"A": "…", "B": "…"}`, `value` a letter, optional `stale` and `confused` letters. The harness lists the options under the question.
  - `multi`: `options` as above, `value` a list of letters; correct only when the set is exact.
  - `provenance`: `who` (`A`, `B` or `C`), `date` (or `day`), `kind` (`user` or `inference`); correct only when all three match.
  - `unknown`: the store does not hold the answer; correct only for `UNKNOWN`. `as` (`number`, `date` or `option`) picks the answer format shown, so the question does not give it away.

### Matter

The background library and the seeds are written in one canonical form, then rendered into each arm's own form. The equivalence check reads each arm's store back into this form and requires all three to be identical before a run starts.

```js
{
  key: 'bg-017',                      // stable, never shown to the model
  title: '2026 年春天学吉他',            // names the matter on its own
  state: 'active',                    // emerging | active | waiting | dormant | done | cancelled
  parent: 'bg-003',                   // key of the parent, or null
  facts: { goal: '…', constraint: '…', plan: '…' },   // any of the three, or none
  progress: { text: '…', date: '2026-05-01' },        // or null
  accounts: [                         // what was said, oldest first
    { date: '2026-03-02', assistant: 'A', source: 'user', text: '…' },
    { date: '2026-04-10', assistant: 'B', source: 'agent_response', text: '…' },
  ],
  organizedBy: { assistant: 'B', date: '2026-04-10' },  // who last set the fields, and when; null if never
}
```

- **P**: `event_note` for each account, by that assistant at that date (the first one starts the Event, with its title and parent), then one `event_record_expression` by `organizedBy`, grounded on the latest account, setting title, state, progress and the facts. Written in process through the server's own `Repository` with the clock fixed per operation, then saved as `repository.json`.
- **T1**: one entry per matter, fields on labelled lines (`状态：`, `上级：`, `目标：`, `条件：`, `安排：`, `进展（日期）：`), then the record lines with date, assistant and whether it is the user's words or an inference, then `最后整理：助手 B，2026-04-10`.
- **T2**: one file per matter with the same content as Markdown sections, and one line per matter in `index.md`: link, state, parent, last update.

### Answers

The shared instructions ask the model to end its reply with one line `ANSWER: <value>` whenever the user's message ends with an answer format, and the harness appends that format to every probe: a number with its unit, a date as `YYYY-MM-DD`, an option letter, a list of letters such as `["A", "C"]`, or `{"who": "B", "date": "2026-10-10", "kind": "user"}`. `ANSWER: UNKNOWN` says the store does not hold it.

## Models

Models are reached through any OpenAI-compatible Chat Completions endpoint with tool calling, or an Anthropic Messages endpoint (`"api": "anthropic"`; the harness translates the conversation, and marks the system prompt and the newest turn as cache breakpoints). A run's model list (`eval/models.local.json`, not committed; `eval/models.example.json` shows the shape) gives, for each model: the endpoint, the environment variable holding its key, the model name, extra request fields (for example DeepSeek's `thinking`), which fields of an assistant message must be sent back on later requests (DeepSeek's `reasoning_content` when thinking is on and tools are offered), how many cases run at once, and optionally the names of two headers a gateway reads: one carrying a conversation id (sent on every request of a conversation, so the gateway can route it to its cache) and one carrying a new request id on every attempt.

Before the pilot, candidate models are screened through the gateway they are reached by. A gateway description (`eval/gateway.local.json`, not committed) gives its Chat Completions and Messages endpoints, the base for `GET /models`, which model names need the Messages protocol, the key's environment variable, the two header names, and per-model request fields. `screen` gives each candidate four conversations from one dev case: the first message in P twice on fresh stores (the second shows whether the prefix came from the cache), the same message in T2, and a probe in P. It reports whether the model recorded and organized with the protocol's tools, wrote files, answered in the required format, and reported usage; the conversations are kept for reading. Keys are read from the environment, for example `node --env-file=eval/.env.local`, and are removed from anything written to disk. Requests that fail for a passing reason (429, 5xx, a timeout) are retried with backoff; any other failure ends that conversation, which counts as failed. The reference servers started for P get only `PATH` from the environment.

## Running it

```sh
node eval/cli.mjs validate                       # expand the templates; check that the three arms start from the same information
node eval/cli.mjs run --dry --split dev          # the whole pipeline with a stand-in for the model: no network, no cost
node eval/cli.mjs preview --case <id> --arms P   # the system prompt, first message and tools of one conversation
node --env-file=eval/.env.local eval/cli.mjs run --split dev --reps 1 --model <id>
node eval/cli.mjs report eval/runs/<run>         # report.md, summary.json, results.jsonl, review packet
node eval/cli.mjs d7                             # the concurrency demonstration
node --env-file=eval/.env.local eval/cli.mjs models --gateway eval/gateway.local.json
node --env-file=eval/.env.local eval/cli.mjs screen --gateway eval/gateway.local.json --candidates <name>,<name>
npm run test:eval                                # the harness's own tests
```

A run writes `manifest.json` (models without keys, code commit, hashes of the prompts, templates, library and code), `cases.json`, `library.json`, and under `work/<model>/rep<n>/<case>/<arm>/`: the store as the sessions left it, a copy per probe, every conversation (`conversations/*.json.gz`) and `result.json`. `--resume <run>` continues a run that stopped, refusing if anything it hashed has changed. The formal split runs only from a committed tree.

## Statistics

Per model: the primary comparison is P against each text arm on D1 to D6 together, items paired by case and question, each item's score averaged over the repetitions; P beats plain text only if it beats both text arms (intersection–union, so no correction across the two). Intervals come from a bootstrap that resamples templates, and p-values from a sign-flip permutation by template; McNemar's exact test per repetition is reported alongside. Across models, Holm's correction. N1 is a non-inferiority test with a 10-point margin. Per-category results are secondary. Failures are counted, never dropped.

## Files

| | |
|---|---|
| `cli.mjs` | `validate`, `run`, `report`, `preview`, `d7`, `models`, `screen` |
| `lib/provider.mjs` | the Chat Completions and Messages clients, usage accounting, retries, listing a gateway's models; a scripted provider for tests |
| `lib/screen.mjs` | screening candidate models |
| `lib/material.mjs` | the templates and the background library every command uses |
| `lib/rehearsal.mjs` | the stand-in model of `run --dry` |
| `lib/arms/protocol.mjs`, `lib/arms/entries.mjs`, `lib/arms/files.mjs` | the three stores, their tools and what each injects |
| `lib/prompts.mjs`, `prompts/` | the shared instructions and the three arm paragraphs, hashed into every run |
| `lib/session.mjs` | one conversation: the tool loop |
| `lib/case.mjs` | one case in one arm: sessions, the store they leave, probes |
| `lib/templates.mjs`, `templates/<split>/` | templates to cases; the scale contrast |
| `lib/library.mjs`, `lib/library-kinds.mjs`, `lib/library-long.mjs` | the background library and the kinds of matters it is made of |
| `lib/render.mjs`, `lib/p-writer.mjs`, `lib/equivalence.mjs` | matters rendered into each arm, and the check that all three hold the same |
| `lib/score.mjs` | answers to outcomes |
| `lib/stats.mjs`, `lib/report.mjs` | the analysis |
| `lib/d7.mjs` | the concurrency demonstration |
| `lib/clock-preload.mjs` | fixes the reference server's clock for one conversation (`server/clock.mjs`) |
| `lib/util.mjs` | seeded randomness, dates, files written in one step |
| `test/` | the harness's own tests, with scripted models and no network |
