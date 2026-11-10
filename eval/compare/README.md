# Where things stand: Protocol Chaos against other memory plugins, in one host

**Question.** A person tells their assistant about the matters they are working through, over several weeks, and changes them along the way. Afterwards, can the assistant say where each matter stands, and who said what, when? This compares memory plugins as their authors ship them, in one host, on the same conversations.

This file was written before any part of the comparison was built or run. It is the plan; anything changed later is listed under "Changes", with its reason.

## Why a new comparison

The controlled experiment in `eval/` held the assistant's instructions equal and changed only the store, so it measures ways of storing. A person choosing a plugin gets a product: its instructions, what it injects, its tools, and what it does in the background. This comparison takes each plugin whole.

## The host

A minimal host that implements the parts of Hermes Agent's plugin and memory-provider interfaces these plugins use: tools a plugin registers, system-prompt sections, context returned by `pre_llm_call`, `post_llm_call`, a memory provider's system-prompt block, prefetch, turn sync and session end, and the auxiliary model a plugin may call. Every plugin targets Hermes, so each runs through the adapter its authors wrote for it, unchanged, pinned to a commit. Where the host must decide something Hermes decides (where injected context goes, when background work finishes), it follows Hermes's source at a pinned commit, and the choice is written down here before the run.

The host's own system prompt says only who the assistant is, the date and time, and, for a probe, the answer format. It says nothing about memory: what to record and how is each plugin's part.

## Arms

| Arm | Plugin, as shipped | Writes | Reads |
|---|---|---|---|
| `builtin` | Hermes's built-in memory (`MEMORY.md`) | the model, with Hermes's memory tool | every entry, at the start |
| `pc-mcp` | Protocol Chaos over MCP with its standing instructions, as Claude Code and Codex use it | the model, with the server's tools | the model, with the server's tools |
| `pc-hermes` | the Protocol Chaos Hermes plugin | after each answer, in the background, with the auxiliary model | the overview at the start; before each answer, the matters the plugin picks |
| `mindhall` | Mindhall's Hermes plugin | the model, with Mindhall's five tools | its rules section and its context block on every turn; `mindhall_read` |
| `memu` | memU's Hermes adapter, local mode (SQLite) | after each conversation, memU's extraction with the auxiliary model | before each answer, memU's retrieval for the message |
| `claude-mem` | claude-mem's Hermes memory provider, with its worker run locally | its worker, from each turn, with the auxiliary model | its context block at the start; its search tools |

`pc-hermes` is run with the router that ships when the comparison runs. The comparison is meant to run after the router's next version (see `eval/router/`), so that it measures what people will install.

## Held equal

- The main model: DeepSeek V4 Pro, thinking on, in every arm, for every conversation.
- The auxiliary model, for every plugin that calls one: one model for all, named before the run.
- The conversations: the same scripted messages, on the same simulated dates, to the same assistant names. Every plugin sees the simulated date and time as its clock.
- Each conversation is new, as in `eval/`. Background work a plugin starts after a conversation is allowed to finish before the next one: the next conversation is days later.
- Every plugin starts empty. A case's earlier history (its seed matters) is replayed as conversations on their dates, so every plugin writes it in its own way.

## Cases

New cases, not the dev set: the dev set was used to tune the prompts of `eval/`. About 20 cases from about 10 templates, a third of the templates written by an agent that has not seen the plugins or this plan. They cover what "where it stands" means:

| Kind | Asks |
|---|---|
| Current value | after two or three changes, by one assistant or by several, what is it now |
| Open matters | which matters are still open, which are waiting on someone, which are done |
| Parent condition | a question about a part whose answer depends on a condition set on the larger matter |
| Two similar matters | two trips, two purchases: asked one at a time |
| What was said | who said it, on which day, and was it the user's words |
| Single assistant | the same kinds, with every conversation to one assistant |

Probes are scored by rules against the timeline, as in `eval/` (`correct`, `stale`, `wrong`, `unknown`, `unparseable`).

## Measures and decision rules

- **Main**: the share of "where it stands" probes (current value, open matters, parent condition, two similar matters) answered correctly, per arm; paired comparisons of `pc-hermes` and `pc-mcp` with each other arm, exact McNemar, Holm's correction over the comparisons.
- **Secondary**: stale answers (a value the timeline replaced); "what was said" probes; single assistant against several; input tokens per conversation; what the plugin's own model calls cost.
- **Stated before the run**: Protocol Chaos is said to do better than a plugin only where the paired difference is significant after correction. Differences that are not are reported as no difference. Results that favour another plugin are reported the same way.

## Cost

Estimated before building: about 20 cases × 6 arms × about 15 conversations × about 8,000 tokens, roughly 14 million tokens for the main model, plus the plugins' own model calls, about 1 to 2 million. The smoke run is measured first; if it projects more than 20 million, the run stops for a decision.

## Not covered

- Leakage at scale (a store of hundreds of matters): `eval/selection/` and `eval/matters/`.
- Nightly organizing (Protocol Chaos's organizer skill), and any plugin's scheduled jobs.
- Installing the plugins: each is run from its source at the pinned commit, configured as its README says for a local setup.

## Changes
