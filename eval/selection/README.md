# Using the right memories: PersistBench under five ways of giving a model its memories

**Question.** When an assistant keeps memories about its user, does it use the ones a request needs and leave the others out? Two failures are measured, as [PersistBench](https://arxiv.org/abs/2602.01146) (Pulipaka et al., ICML 2026) defines them: **cross-domain leakage**, a memory that has nothing to do with the request shapes the answer; and **missed memories**, a memory the request needs is not used. Published work finds the two traded against each other: putting every memory in the prompt leaks, and retrieving only similar memories misses ([Zhao et al., 2026](https://arxiv.org/abs/2608.08300)). This benchmark asks where reading the memories from a map, on demand, falls: as a plain-text index of files, and as Protocol Chaos.

This file was written before the runs. Any change made after a run started is listed under "Changes" with its reason.

## Samples

PersistBench as [Inspect Evals](https://ukgovernmentbeis.github.io/inspect_evals/evals/persistbench/index.html) bundles it (`eval/selection/fetch.sh` downloads it to `eval/external/`, which is not committed: the PersistBench repository states no license, so the samples are used for evaluation only):

- cross-domain leakage: 200 samples, each answered 3 times; the worst of the three counts;
- beneficial memory use: 100 samples, each answered once;
- the 200 sycophancy samples are not run: memory layout is not expected to change them (Zhao et al. find it does not), and they are not what this benchmark asks.

| File | SHA-256 |
|---|---|
| `cross_domain.jsonl` | `6143000cd911199bc297b5490d3155e310b0d6515afb8d2742d5fd9b5120edcb` |
| `beneficial_samples.jsonl` | `23408261f8f20c891c26e9584b81389e9927b65ff4591fab638d1334d3799c46` |

Each sample holds 4 to 16 short statements about a user (10.5 on average) and a request.

## Conditions

The system prompt is PersistBench's own (a production-style assistant prompt ending in `{memories}`); only what replaces `{memories}`, and the tools, differ.

| Condition | In the prompt | How memories are read |
|---|---|---|
| `flat` | every memory, as PersistBench formats them | nothing to read |
| `partition` | every memory, under domain headings | nothing to read |
| `retrieval` | the memories whose cosine similarity to the request is at least 0.50 (`text-embedding-3-small`; the threshold of Zhao et al.) | nothing to read |
| `files` | an index: one file per domain, with how many memories it holds, no content | `read_memory_file` reads one file |
| `protocol` | the same index, as Protocol Chaos keeps it: Statements on the user's own Entity, by topic | the reference server's `entity_get` (by topic) and `entity_search` |

- `partition`, `files` and `protocol` use the same grouping of each sample's memories: the dynamic classifier of Zhao et al. (Appendix F of their paper), run once with one model (DeepSeek V4 Pro) and cached. Zhao et al. let each evaluated model classify for itself; one classifier for all keeps the three groupings identical.
- In `protocol`, a memory longer than 200 characters, the longest Statement the protocol takes, becomes several Statements, split at sentences, then clauses. The judge always sees the original memories.
- The two index conditions say only which tool reads a file or a topic. They give no advice on when to read, so that what is measured is the layout, not an instruction.
- `protocol` is offered the server's two reading tools for Entities, as the server describes them; its writing tools are not offered.

## Models

- Answering: DeepSeek V4 Pro (thinking on) and Qwen3.5-4B (q4_K_M, on this machine through Ollama, thinking off).
- Judge: Kimi K2.6, the closest available model to PersistBench's Kimi K2 Thinking; its endpoint allows temperature 1 only. PersistBench's judge prompts are used verbatim, with its way of reading the JSON. A judgment that cannot be read after three tries leaves that sample out of that condition, and is counted.
- Calibration: Qwen3-235B-A22B-Instruct-2507, which Zhao et al. report at 80.0% leakage in `flat`, is run in `flat`.

## Measures

As PersistBench: **leakage**, the share of cross-domain samples whose worst answer the judge scores 3 or more of 5; **missed memories**, the share of beneficial samples whose answer it rates below 3 of 3. An answer the model did not produce (a reply cut off, no answer within 8 model calls) counts as a failure, in every condition. Intervals: 95% bootstrap over samples. Comparisons: paired on the samples both conditions counted, exact McNemar test, paired bootstrap interval of the difference.

## Decision rules

For each answering model:

- **H1**: `protocol` leaks less than `flat` (one-sided exact McNemar, p < 0.05 after Holm's correction across the two models).
- **H2**: `protocol` misses no more memories than `flat` plus 10 points (one-sided 95% upper bound of the paired difference below 10 points).
- **H3**: `protocol` misses fewer memories than `retrieval` (one-sided exact McNemar, p < 0.05).

Secondary, reported but not decided on: `files` against `protocol` (both read from a map; on PersistBench, where memories are short statements about one person with no time or relations, no difference is expected between them); `partition` against `flat` (a replication of Zhao et al.); how often the index conditions read nothing, read everything, or how many topics they read.

If the calibration model's leakage in `flat` is more than 10 points from 80.0%, the judge is not on PersistBench's scale: absolute rates are then not compared with published ones, and comparisons between conditions still stand.

## Running it

```sh
eval/selection/fetch.sh                                   # PersistBench, into eval/external/
node --env-file=eval/.env.local eval/selection/cli.mjs prepare --classifier deepseek-v4-pro --embedding text-embedding-3-small
node --env-file=eval/.env.local eval/selection/cli.mjs run --model deepseek-v4-pro --judge kimi-k2.6 --out eval/runs/pb-v4pro
node eval/selection/cli.mjs report eval/runs/pb-v4pro [eval/runs/pb-4b ...]
node eval/selection/cli.mjs run --dry --limit 3 --cache DIR --out DIR   # the whole pipeline with stand-ins, no network
```

## Changes

None yet.
