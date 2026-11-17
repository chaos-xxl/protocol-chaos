# The background organizer, with real models

**Question.** After an assistant records the user's words, the reference server folds them into their matter in the background with one model call (`server/organize.mjs`, the rules of the Hermes plugin's structure update, adapted). Does that call write what the new words establish and leave the rest alone, with the small model an organizer would use? And does the whole path work with a real organizer agent: the server queues the words, a detached process runs the agent headless, and the fold is written?

Two scripts. The data is invented; each check is a rule written with its case.

## One fold per case: `check.mjs`

Twelve cases, each a fresh repository holding one matter as it stands and the new words recorded on it: a plan and a budget from nothing; a change of plan that must replace the old value; a booking; a wish, which is a constraint; the same wish once decided, which must move to the plan and leave the constraint; done; given up; an episode said about a long-lived matter, which must stay off it; the same episode recorded on a part of its own, which must get its progress; a relative date; an assistant's inference; a question, which establishes nothing.

```sh
node --env-file=eval/.env.local eval/organize/check.mjs --model deepseek-flash
```

It calls `foldOne` with each model directly, at temperature 0, instead of through an agent's headless run, so it tests the rules and the patch, not an agent's command line.

| Model | Checks passed | Tokens in / out, all twelve |
|---|---|---|
| `deepseek-flash` (the organizer's model with DeepSeek Harness) | 12 of 12 | 9,866 / 680 |

With the eleven cases before the episode-on-a-part case was added, `deepseek-v4-pro` with thinking off passed 10 of 11 (it left the settled wish in the constraint).

## End to end: `end-to-end.mjs`

A new repository, with DeepSeek Harness as the organizer. An assistant (`--client codex`, over stdio, with the MCP SDK's minimal environment) records eleven sentences about five matters in a row, a question among them. The server queues them; the detached organizer waits until the assistant's turn is over (15 seconds), then folds each with one run of `dsh --profile headless`. Then the daily sweep runs twice.

```sh
node eval/organize/end-to-end.mjs --agent dsh
```

It uses the organizer agent's own model credit. 2026-11-17, DeepSeek Harness 0.2.2-rc.1, `deepseek-flash` with thinking off:

- **What was written.** Ten folds changed their matter and the question changed nothing. The move ends with the budget as its constraint and, as its plan, the new date (the old one is in its history), the reason for the change and the booked company; the driving licence is done with how the test went; the router breakdown, recorded as a part of the home network, has its own progress, and the home network does not.
- **Cost and time.** 11 runs, 2.2 seconds each; 4,155 tokens in, 10,240 more read from DeepSeek's cache, 680 out: about 1,400 tokens a sentence.
- **The sweeps.** The first found every sentence already folded, the second found nothing changed; neither called a model.
- **What was left behind.** No DeepSeek Harness session history (its session folders were the same before and after), and no words in the organizer's log.

## Changes

- **2026-11-16: the rules were changed after a first run of `check.mjs`** at the gateway's default temperature, where `deepseek-flash` passed 9 of 11: the decided wish stayed in the constraint, and a question added people and places to the matter. The rules now say that a question, a hypothetical or a request establishes nothing; that `involves` takes only what the new words themselves name; that a decision rewrites the constraint without the wish it settles, with `"(remove)"` when nothing of a fact still holds; and that words only about one episode change nothing on a long-lived matter.
- **2026-11-17: the last rule was too broad.** In the first two end-to-end runs, the router breakdown, recorded on a part of its own, got no progress: the model applied "words only about one episode change nothing" to the episode itself. The rule now says that when the matter is itself the episode, its progress belongs on it, and the fold input says where the matter sits (`part of: … (this matter is one part of it …)`, `parts: … (what holds only for one of them belongs on that part …)`). The case "an episode keeps its own progress" was added to `check.mjs`, which now has twelve.
- 2026-11-17, after the end-to-end runs: the first sentence's two place names were replaced by neutral ones (`从老城区搬到新区`). Nothing else changed.
- Since the rules were tuned on these cases, the numbers show that the rules can be followed, not how often they are on other words.
