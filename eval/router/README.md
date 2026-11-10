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

- **11-10, after the first run: the fact check accepts a date in either form.** The first run counted 6 facts as missing from the pushed text; all 6 were dates the request's facts write as `2026-11-22` and the store writes as `11 月 22 日`. An ISO date in a fact now also matches `11-22`, `11/22` and `11 月 22`. Nothing else changed; the picks are the same. With the fix, the shipped router's pushed text holds 27 of 28 checked facts instead of 22.
