# Structure or the agreement: PersistBench with a usage guide

**Question.** In `eval/selection/`, the conditions give no advice on when to use the memories, so that what is measured is the layout. There, with DeepSeek V4 Pro, reading from the protocol's map leaked half as often as the flat list (6.5% against 12.5%) and missed three times as often (24% against 8%): the model often read nothing. An assistant that uses Protocol Chaos is not given a bare map, though: it comes with a working agreement on when to read and what to use. This follow-up gives the same short guide (`guide.md`) to three of the conditions and asks two things. Does the guide remove the misses of the map? And once every condition has the guide, does the map still leak less than the flat list, without missing more?

This file was written before any run of the follow-up, after the runs of `eval/selection/` with V4 Pro had ended. Any change made after a run started is listed under "Changes" with its reason.

## What is the same as in `eval/selection/`

The 300 samples (200 cross-domain, 3 answers each, the worst counts; 100 beneficial, 1 answer), PersistBench's system prompt, the grouping by domain and its cache, the three conditions `flat`, `files` and `protocol` exactly as there, the judge (Kimi K2.6 with PersistBench's prompts), the measures and the way they are counted.

## What changes

The guide is inserted in the system prompt right before the memory block (or the index), the same text in all three conditions. It says, in three lines, to check the memories that could bear on a request that depends on the user's situation, to answer without them when the request does not, and to use only what the answer needs. It is written for any layout: in `flat` the memories are in the prompt, in the map conditions checking them means reading.

## Models

DeepSeek V4 Pro (thinking on), the primary model; GPT-4o mini, secondary. Both were run without the guide in `eval/selection/`, so every comparison below is paired on the same samples.

## Decision rules

For V4 Pro (GPT-4o mini is reported the same way, outside the rules):

- **G1, the guide removes the misses of the map**: `protocol` with the guide misses less than `protocol` without it (one-sided exact McNemar, p < 0.05).
- **G2, the map with the guide is more precise than the list with the guide**: `protocol` with the guide leaks less than `flat` with the guide (one-sided exact McNemar, p < 0.05), and misses no more than it plus 10 points (one-sided 95% upper bound of the paired difference below 10 points). G2 holds only if both parts hold.

Reported, not decided on: `files` with the guide against `protocol` with the guide; each condition with the guide against itself without it; what the map conditions read.

## Running it

```sh
node --env-file=eval/.env.local eval/guide/cli.mjs run --model deepseek-v4-pro --judge kimi-k2.6 --out eval/runs/pg-v4pro
node eval/guide/cli.mjs report --guide eval/runs/pg-v4pro --without eval/runs/pb-v4pro
```

## Changes

None yet.
