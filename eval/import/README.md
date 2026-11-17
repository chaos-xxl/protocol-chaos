# Importing other assistants' memories, with a real model

**Question.** `protocol-chaos import` (`server/memories.mjs`) reads the memory files and standing instructions other assistants keep on the machine and asks the organizer's model, one part of about 6,000 characters at a time, for the matters they show, with the sentences each rests on. Does the small model an organizer uses find the matters, group them as the user would (a long-horizon aim with its parts under it), set their state, and leave out who the user is and how an assistant should work?

## One import: `check.mjs`

Invented notes as three assistants keep them: a Claude Code memory file (who Sam is, how Sam likes answers, and a long-term goal with two parts), a Hermes `MEMORY.md` (a trip with a budget and a wish, an instrument set aside, a rule for answering), and a Kiro steering file in Chinese (a move with a budget, a renovation that is done, a rule for writing). Seven checks: the trip with its budget; the long-term goal as a matter; one of its parts under it; the instrument set aside; the move with its budget; the renovation done; nothing about who Sam is or how to answer.

```sh
node --env-file=eval/.env.local eval/import/check.mjs --model deepseek-flash
```

It calls the model directly, at temperature 0, instead of through an agent's headless run, and writes through the importer's own code (`applyExtraction`), so a matter none of whose quotes is in the notes is left out, as in a real import. It prints every matter written, with the sentences it rests on, and the tokens used against the plan's estimate.

2026-11-18, `deepseek-flash` with thinking off:

| | |
|---|---|
| Parts and calls | 1 (the notes fit in one part) |
| Tokens | 897 in, 646 out; the plan estimated 1,898 in all, allowing for an agent's own prompt around each call |
| Matters written | 6; none left out for want of a sentence of the notes |
| Checks | 7 of 7 (5 of 7 with the checks as written before the run; see Changes) |

- **What was written.** The Lisbon trip, with the budget and the wish to stay near the old town as its constraint and who goes as its plan. Financial independence by 40, with the monthly amount into an index fund as its plan, and the weekend sailing app under it as a part, set aside until spring. The cello, set aside since October. The move, with its budget and the wish to live near work. The renovation, done, with what it cost as its progress.
- **What was left out.** Sam's age, city and job, and the two rules for answering and writing: none became a matter.
- **Not covered by the checks.** The titles and facts of the English notes came out in Chinese, though the rules ask for the language of the notes (this part held both languages). The cello's title has no year, though the notes give March 2026.

## Changes

- **2026-11-18: the check for the long-term goal was changed after the first run.** It looked for 财务自由 or "financial independence" in a title; the model titled the matter 财务独立（40岁前）, the other common Chinese word for it, so the check and the one after it (a part under that matter) failed. They now accept 财务独立 too. The matters themselves were as the checks intended: the goal is there, and the sailing app sits under it.
