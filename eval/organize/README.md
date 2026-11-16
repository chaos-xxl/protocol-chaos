# One fold, with a real model: the background organizer's single call

**Question.** After an assistant records the user's words, the reference server folds them into their matter in the background with one model call (`server/organize.mjs`, the same rules as the Hermes plugin's structure update). Does that call write what the new words establish and leave the rest alone, with the small model an organizer would use?

**Cases.** Eleven, each a fresh repository holding one matter as it stands and the new words recorded on it (`check.mjs`): a plan and a budget from nothing; a change of plan that must replace the old value; a booking; a wish, which is a constraint; the same wish once decided, which must move to the plan and leave the constraint; done; given up; an episode on a long-lived matter, which must stay off it; a relative date; an assistant's inference; a question, which establishes nothing. The data is invented. Each check is a rule written with the case, before the run.

**Running it.**

```sh
node --env-file=eval/.env.local eval/organize/check.mjs --model deepseek-flash
```

It calls `foldOne` with each model directly, at temperature 0, instead of through an agent's headless run, so it tests the rules and the patch, not an agent's command line.

## Results

2026-11-16, at temperature 0:

| Model | Checks passed | Tokens in / out, all eleven |
|---|---|---|
| `deepseek-flash` (what `dsh --profile headless` uses by default) | 11 of 11 | 8,816 / 619 |
| `deepseek-v4-pro`, thinking off | 10 of 11 (left the settled wish in the constraint) | 8,805 / 680 |

About 800 tokens in and 60 out per fold, before the overhead of an agent's own system prompt when it runs headless.

## Changes

- **Before these numbers, the rules were changed after a first run** at the gateway's default temperature, where `deepseek-flash` passed 9 of 11: the decided wish stayed in the constraint, and a question added people and places to the matter. The rules now say that a question, a hypothetical or a request establishes nothing, that `involves` takes only what the new words themselves name, that a decision rewrites the constraint without the wish it settles, with `"(remove)"` when nothing of a fact still holds, and that words only about one episode change nothing on a long-lived matter. The cases did not change. Since the rules were tuned on these eleven cases, the table shows that the rules can be followed, not how often they are on other words.
