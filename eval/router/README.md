# Picking matters before the model answers: an offline replay of the Hermes plugin's router

**Question.** The matter benchmark (`eval/matters/`) gave the answering model a directory and let it decide what to read. The Hermes plugin does something else: before the model answers, it picks up to three matters itself, on this machine, from the words their titles share with the message, and puts their fields and latest words into the turn. That step was not part of the benchmark. This replay asks how well it picks, on the same 78 requests and 16 stores, with no model call at all.

This file was written before the replay was run. Anything changed after it ran is listed under "Changes".

## What is replayed

- The stores and requests of the matter benchmark, as cached in `eval/runs/matters-cache/` (16 stores of 151 to 156 matters; 32 needs, 30 adjacent and 16 unrelated requests).
- The router: `rank()` and `matter_text()` imported unchanged from `integrations/hermes/protocol-chaos/__init__.py`, given each store's directory (id, title, state, parents) as the server's directory would list it, and each matter's event and its last three words as `event_get_protocol` returns them.

## Routers

| Name | What it is |
|---|---|
| `plugin` | the plugin as shipped: shared title words weighed by rarity, at least 1.0, at most 3 |
| `plugin-0.5` | the same with the lower bound the plugin uses for recording candidates (0.5) |
| `fields` | the same weighing over the title, goal, constraint, plan and progress (exploratory) |
| `embed-3`, `embed-5` | the 3 or 5 matters most similar to the request (`text-embedding-3-small`, cosine, the request against each matter's full entry), as cached by the benchmark's `retrieval` condition |

Only `plugin` is what users run. The others show what a different router would change; `fields` and any threshold on the embeddings are tried on these same requests, so their numbers can only guide a choice, not prove it.

## Measures

- **Needs, picked**: the share of needs requests for which every matter the request needs is among those picked (and, looser, at least one of them).
- **Parents**: for the three needs requests that also need a parent's constraint, whether the parent is picked. The plugin shows a part's parent by title only.
- **Facts in the pushed text**: for the needs requests whose matters are picked, the share of the request's facts whose numbers and dates all appear in the text that would be put in the turn. Facts without a number or a date are not checked.
- **Pushed without need**: the share of adjacent requests for which the matter they resemble is picked, and the share of unrelated requests for which anything is picked; the mean number of matters and of characters put in a turn, for each kind.
- **Time**: the mean time `rank()` takes on one store's directory.

## What counts as good enough

Stated before the run, for putting the plugin's way of pushing into other hosts as it is: every needed matter picked for at least 90% of the needs requests (V4 Pro misses 3% with the whole store in its prompt), and nothing pushed for at least 90% of the unrelated requests. Adjacent requests are meant to resemble a matter, so picking it is expected; it is reported, and whether its details leak is the answering model's part, which this replay does not test.

## Running it

```sh
python3 eval/router/replay.py eval/runs/matters-cache eval/runs/router-replay
```

No network and no model. It writes `report.md` and `picks.json` to the output directory.

## Changes

- **11-16: router-v2 is not shipped; on a labeled set built on a real store it is no better than 0.3.1.** The 78 requests here were written for the benchmark. A second, private set has 109 short messages written in October against one person's real store: most were written for the test in that person's voice, a few are things the person actually typed, and each is labeled with the matters it should bring up (67) or with none (42). Both plugins were replayed on it against that store's current directory (142 matters), with no model call. Every needed matter picked: 53 of 67 for both. At least one: 56 of 67 for both. Matters picked that the labels do not accept: 71 for router-v2, 61 of them parents it adds, against 21 for 0.3.1. Something picked for an unrelated message: 13 of 42 against 10. Many of today's parents did not exist when the set was labeled, so these labels cannot say whether the added parents are wrong; without them, router-v2's own picks give 55, 23 and 12, no better than 0.3.1. The labels also predate matters split out of broader ones since, so the percentages below are approximate; before the set is used to choose a router, its labels are to be updated against the current store. router-v2's changes were tuned on the misses of the 78 requests and did not carry over. Neither plugin meets the bar above on this set: 0.3.1 picks every needed matter for 79% of the messages (53 of 67) and pushes nothing for 76% of the unrelated ones (32 of 42). The branch `router-v2` stays unmerged. From now on a change to the router is replayed on this set first and on these requests second. The set holds personal details and is not published.
- **11-10: `--plugin <file>` replays any version of the plugin, and the `plugin` row uses its whole picking step.** A plugin with `related_matters()` (the router after 0.3.1, branch `router-v2`) is replayed through it, so the matters it adds after the picked ones (the matters they are part of) count as pushed; an older one is replayed through `rank()`, as before. The report names the plugin version and the file's hash. Replaying 0.3.1 from `main` gives the same numbers as the first run (its `tokens()` and `rank()` are those of 0.3.0). Replaying `router-v2` (commit 0798283) on the same 78 requests: every needed matter pushed for 29 of 32 needs requests (26 with 0.3.1), at least one for 30 (28), the parent's condition for 3 of 3 (0), and something pushed for 2 of 16 unrelated requests (7); the resembled matter for 21 of 30 adjacent requests (20); per turn, 352 / 232 / 28 characters for needs, adjacent and unrelated requests (329 / 202 / 114). Its changes were made by reading this run's misses, so these numbers are not evidence for the bar written above; new requests are.
- **11-10, after the first run: the fact check accepts a date in either form.** The first run counted 6 facts as missing from the pushed text; all 6 were dates the request's facts write as `2026-11-22` and the store writes as `11 月 22 日`. An ISO date in a fact now also matches `11-22`, `11/22` and `11 月 22`. Nothing else changed; the picks are the same. With the fix, the shipped router's pushed text holds 27 of 28 checked facts instead of 22.
