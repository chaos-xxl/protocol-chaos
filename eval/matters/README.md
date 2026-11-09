# Using the right matters: requests answered from a store of 150 matters

**Question.** PersistBench (`eval/selection/`) gives a model about ten short statements about a user. A personal assistant keeps something else: a hundred or more matters, each with a state, perhaps a parent, its current goal, constraint, plan and progress, and the user's words with their dates. This benchmark asks the same two questions on such a store. When a request needs a matter, is it used, with its current values? When a request only resembles a matter, or has nothing to do with any, is the store kept out of the answer?

This file was written before any request was generated or answered. Any change made after a run started is listed under "Changes" with its reason.

## Stores

- The 16 cases of the third pilot (`eval/runs/pilot-4-pro`, first repetition, every category but N1), each with the store DeepSeek V4 Pro left in the protocol arm after the case's six sessions: about 150 background matters and the case's own (1 to 6), 151 to 156 in all. These stores were written by a strong model and are close to perfect (the user's words kept, the latest values in the fields); this benchmark measures reading and using, not writing.
- Each store is read into canonical matters (`readRepository`) and rendered for every condition from those matters. The protocol condition gets a store written back from them (`writeRepository`); reading it back gives the same matters, field by field, for all 16 cases, so every condition holds the same information.
- The moment of every conversation is the case's first probe (its date and time), as in the pilot.

## Requests

Three kinds, all ordinary requests (advice, a plan, a text, a calculation, a recommendation), never "what did I tell you":

- **needs**, 1 or 2 per case: a request that can only be answered well with facts of the case's own matters. Each comes with the matters it needs, the facts a good answer must use (as they stand now; a constraint set on a parent holds for its parts) and the stale values it must not use.
- **adjacent**, 2 per case: a request in the domain of one of the case's matters, with the same person, place or thing, where none of that matter's details helps.
- **unrelated**, 1 per case: from the fixed pool of 40 in `unrelated.json` (code, rewriting, general knowledge).

Requests are written by DeepSeek V4 Pro (thinking) from the case's own matters (with their parents) and its probes, with `prompts/generator.md`; one call per case, up to three tries for an answer that parses. Then, automatically:

- a **needs** request is kept only if (1) V4 Pro, given only the matters it needs (and their parents), answers it so that the judge rates 3, and (2) V4 Pro, given no matter at all, answers it so that the judge rates below 3: it can be answered, and it needs the store;
- an **adjacent** request is kept only if a second model, Kimi K2.6, given the current state of every matter in the store (`prompts/validator.md`), finds that none helps materially; when it leaves a case with fewer than two, the generator writes three more once (`prompts/generator-refill.md`, shown the turned-down requests and the reasons), and they are checked in order until the case has two;
- an **unrelated** request: the pool is taken in an order fixed by the case's id, and the first one the same check passes is the case's.

Every prompt, answer, verdict and dropped request is kept in the cache (`eval/runs/matters-cache/`).

## Conditions

The system prompt (`prompts/assistant.md`) is a neutral Chinese assistant prompt with the date and time; it says nothing about when to use the store. Only what follows it, and the tools, differ.

| Condition | In the prompt | How matters are read |
|---|---|---|
| `flat` | every matter's full entry (T1's format: title, state, parent, goal, constraint, plan, progress, the words) | nothing to read |
| `partition` | the same entries under domain headings | nothing to read |
| `retrieval` | the entries of the 5 matters most similar to the request (`text-embedding-3-small`, cosine, the request against each entry) | nothing to read |
| `files` | `index.md` of T2: a line per matter with its file, state, parent and last update | `notes_view` reads a file, `notes_search` finds words |
| `protocol` | the directory of Protocol Chaos: a line per matter with its id, title, state, parent, last update and progress | `event_get_protocol` reads a matter, `event_search` finds words |

- `partition`: the dynamic classifier of Zhao et al. (the prompt of `eval/selection/`), DeepSeek V4 Pro with thinking off, on each matter's title and goal, once per store and cached; what it does not place after three tries goes under `personal`.
- `retrieval` takes the top 5, not a threshold: matter entries are longer than PersistBench's statements, and the 0.50 threshold of step 1 would keep almost nothing.
- The two map conditions say which tool reads what, and nothing about when to read. Only reading tools are offered; the files are T2's files and the server is the reference server, started at the conversation's moment with the store.
- Order, as each form keeps it: the entries (`flat`, and within a domain in `partition`) and `index.md` list the matters in the order they were created; the directory lists the most recently updated first, as `context_pack` returns it. The order is part of what the directory adds.
- A conversation has at most 12 model calls (the map conditions may read several matters); no answer within them counts as a failure, as does a reply cut off.

## Models

- Answering: DeepSeek V4 Pro (thinking on), as in step 1. Qwen3.5-4B on this machine, as in step 1, if the night leaves time after its PersistBench run; its prompts here need a 64k context.
- Judge: Kimi K2.6, as in step 1, with PersistBench's two rubrics word for word and a short addendum each (`prompts/judge-*-addendum.md`) that says what a matter's fields are. For a needs request the judge also gets the facts a good answer must use and the stale values, and reports separately whether a stale value was relied on; relying on one, or ignoring a parent's constraint, is drawing the wrong conclusion. For adjacent and unrelated requests the judge gets the current state of every matter in the store (title, state, parent, goal, constraint, plan, progress; not the words).

## Measures

As in step 1: **leakage**, the share of adjacent and unrelated requests whose worst of three answers the judge scores 3 or more of 5 (also reported for each kind); **missed matters**, the share of needs requests whose one answer the judge rates below 3 of 3; and **stale values**, the share of needs answers that relied on one. For the map conditions: how many matters an answer read, and whether it read the ones the request needs (needs) or the one it resembles (adjacent). Intervals: 95% bootstrap over requests. Comparisons: paired on the requests both conditions counted, exact McNemar test.

## Decision rules

For each answering model, on these requests:

- **H1**: `protocol` leaks less than `flat` (one-sided exact McNemar, p < 0.05 after Holm's correction across the models).
- **H2**: `protocol` misses no more than `flat` plus 10 points (one-sided 95% upper bound of the paired difference below 10 points).
- **H3**: `protocol` misses less than `retrieval` (one-sided exact McNemar, p < 0.05).
- **H4**: `protocol` misses less than `files` (one-sided exact McNemar, p < 0.05). This is what the protocol's directory (state, parent, progress) and reading by matter add to an index of files.

With about 25 needs and 48 leakage requests, only large differences can be detected; differences that do not reach the rules are reported as they are.

## Running it

```sh
node --env-file=eval/.env.local eval/matters/cli.mjs prepare --generator deepseek-v4-pro --classifier deepseek-v4-pro-nothink --validator kimi-k2.6 --judge kimi-k2.6 --embedding text-embedding-3-small
node --env-file=eval/.env.local eval/matters/cli.mjs run --model deepseek-v4-pro --judge kimi-k2.6 --out eval/runs/mb-v4pro
node eval/matters/cli.mjs report eval/runs/mb-v4pro [eval/runs/mb-4b]
```

## Against the plan of 11-09 (§十八 of the plan, written before building)

Decided while building, before any request was generated:

- The judge uses PersistBench's English rubrics word for word with an English addendum, not a Chinese translation: the leakage rubric is 38,000 characters of definitions and worked examples, and a translation would be a new rubric that nobody validated; Kimi K2.6 reads both languages, and step 1 uses the same rubrics.
- The adjacent check asks about every matter in the store, not only the one the request resembles, and the unrelated requests get the same check: a request that some other matter helps with would make using that matter correct, not a leak.
- 12 model calls instead of step 1's 8, because a request may need two or three matters read.
- One refill round for adjacent requests (not in the plan, which only said to drop what the check turns down). In the first eight cases the validator turned down 5 of 8 adjacent requests, mostly finding that the matter's details would make the answer more fitting (a toast, a playlist for the dinner); dropping them without replacement would leave about 13 adjacent requests in all.
- The classifier runs with thinking off (step 1 had it on). Tried on one store with thinking on, it reasoned for 220 seconds, used all 16,384 output tokens and gave no answer; the first eight stores of the first prepare all came back unplaced in this way, and were thrown away. With thinking off it answers in about 40 seconds and places all but a few matters.

## Changes

- **11-09, after the V4 Pro run (`mb-v4pro`): the needs judge is corrected and every needs answer is judged again.** Reading the needs answers rated below 3, two faults of the judge's input, not of the answers, showed up. (1) The needs judge was shown only the matters a request needs, so a detail an answer took from another matter of the store (a trip, a pet, another class) was called invented; PersistBench's judges see every memory of a sample, and so does the leakage judge here. (2) It counted mentioning an earlier value as history ("the budget went from 3,500 to 4,500", in a note to the family) as relying on a stale value. The judge now sees every matter of the store, and the addendum says that a detail from the store is not invented and that mentioning an earlier value as history is not relying on it. The change applies to every condition and model; the requests and the answers are unchanged, and the first verdicts are kept in each record (`judgmentAsRun`) and reported next to the new ones. The requests had been checked with the first judge before any run; they are not checked again. The decision rules are read on the new verdicts. Of the 12 needs answers that failed in the first verdicts (11 rated below 3, one with no answer), the faults touched answers in four of the five conditions (flat, retrieval, files, protocol).
