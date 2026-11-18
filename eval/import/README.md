# Importing other assistants' memories, with a real model

**Question.** `protocol-chaos import` (`server/memories.mjs`) reads the memory files and standing instructions other assistants keep on the machine and asks the organizer's model, one part of about 6,000 characters at a time, for the matters they show, with the sentences each rests on. Does the small model an organizer uses find the matters, group them as the user would (a long-horizon aim with its parts under it), set their state, and leave out who the user is and how an assistant should work?

## One import: `check.mjs`

Invented notes as three assistants keep them: two Claude Code memory files (who Sam is, how Sam likes answers, a taste, a belief and a long-term goal with two parts; and a project not changed for six and a half months, with a list of next steps), a Hermes `MEMORY.md` (a trip with a budget and a wish, an instrument set aside, a rule for answering), and a Kiro steering file in Chinese (a move with a budget, a renovation that is done, a rule for writing). Ten checks: the trip with its budget; the long-term goal as a matter; one of its parts under it; the instrument set aside; the move with its budget; the renovation done; nothing about who Sam is or how to answer; nothing resting on the taste or the belief; the old project as one matter, without its steps; the trip and the cello, which bear on no aim, not under the long-term goal.

```sh
node --env-file=eval/.env.local eval/import/check.mjs --model deepseek-flash
```

It calls the model directly, at temperature 0, instead of through an agent's headless run, and writes through the importer's own code (`applyExtraction`, then `linkInput` and `applyLinks` for the call after the parts), so a matter none of whose quotes is in the notes is left out, as in a real import. It prints every matter written, with the sentences it rests on, and the tokens used against the plan's estimate.

2026-11-18, `deepseek-flash` with thinking off, last run:

| | |
|---|---|
| Parts and calls | 1 part (the notes fit in one), and the call after the parts, with thinking |
| Tokens | 2,123 in, 2,726 out, most of the output that call's thinking; the plan estimated 2,412 in all (it allows for thinking only when DeepSeek Harness organizes) |
| Matters written | 7; none left out for want of a sentence of the notes; no link made by the call after the parts |
| Checks | 10 of 10 |

- **What was written.** The Lisbon trip, with the budget and the wish to stay near the old town as its constraint and who goes as its plan. Financial independence by 40, with the monthly amount into an index fund and the sailing app as its plan, and the sailing app under it as a part, set aside until spring. The cello, set aside since October. The move, with its budget and the wish to live near work. The renovation, done, with what it cost as its progress. The icon pack, as one matter, with no step of its list as a matter.
- **What was left out.** Sam's age, city and job, the taste and the belief, and the two rules for answering and writing: none became a matter.
- **Not covered by the checks.** The titles and facts of the English notes came out in Chinese, though the rules ask for the language of the notes (this part held both languages). The cello's title has no year, though the notes give March 2026.

## Changes

- **2026-11-18, later still: the call after the parts links generously, and thinks.** It now places a plan that bears on an aim under it when the notes discuss the two together, so the check that the icon pack is not put under financial independence went; in its place, the trip and the cello, which bear on no aim, must not be put under it. The call is made with thinking on, as DeepSeek Harness makes it. One run: 10 of 10; 2,123 tokens in, 2,726 out, most of the output the thinking of the last call.
- **2026-11-18, last: ten checks, and the call after the parts.** The notes gained a taste, a belief and a project memory not changed for six and a half months, with a list of next steps; three checks came with them (nothing rests on the taste or the belief; the old project is one matter, without its steps; the project, which the notes tie to no aim, is not put under financial independence). The check also makes the importer's last call, which puts together what the parts wrote apart. The first run of it put the icon pack under financial independence; the rule for that call was then made to ask for the words that say so, and the third check was added. Runs after that: 10 of 10 twice (1,909 in and 792 out; 2,012 in and 882 out).
- **2026-11-18, later: the rules say three things more** (an aim written among background facts is a matter; a sentence that only shares a word or a theme with a matter is not about it; an existing matter under none can be given a parent), and quotes are matched without the spaces, markdown marks and end marks a model adds or drops. Run again: 7 of 7, 6 matters, none left out; 967 tokens in, 640 out.
- **2026-11-18: the check for the long-term goal was changed after the first run.** It looked for 财务自由 or "financial independence" in a title; the model titled the matter 财务独立（40岁前）, the other common Chinese word for it, so the check and the one after it (a part under that matter) failed. They now accept 财务独立 too. The matters themselves were as the checks intended: the goal is there, and the sailing app sits under it.
