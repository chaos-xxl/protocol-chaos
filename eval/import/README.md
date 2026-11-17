# Importing other assistants' memories, with a real model

**Question.** `protocol-chaos import` (`server/memories.mjs`) reads the memory files and standing instructions other assistants keep on the machine and asks the organizer's model, one part of about 6,000 characters at a time, for the matters they show, with the sentences each rests on. Does the small model an organizer uses find the matters, group them as the user would (a long-horizon aim with its parts under it), set their state, and leave out who the user is and how an assistant should work?

## One import: `check.mjs`

Invented notes as three assistants keep them: a Claude Code memory file (who Sam is, how Sam likes answers, and a long-term goal with two parts), a Hermes `MEMORY.md` (a trip with a budget and a wish, an instrument set aside, a rule for answering), and a Kiro steering file in Chinese (a move with a budget, a renovation that is done, a rule for writing). Seven checks: the trip with its budget; the long-term goal as a matter; one of its parts under it; the instrument set aside; the move with its budget; the renovation done; nothing about who Sam is or how to answer.

```sh
node --env-file=eval/.env.local eval/import/check.mjs --model deepseek-flash
```

It calls the model directly, at temperature 0, instead of through an agent's headless run, and writes through the importer's own code (`applyExtraction`), so a matter none of whose quotes is in the notes is left out, as in a real import. It prints every matter written, with the sentences it rests on, and the tokens used against the plan's estimate.

Not run yet: one run is about 4,000 tokens.
