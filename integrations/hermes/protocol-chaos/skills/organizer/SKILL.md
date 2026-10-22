---
name: organizer
description: Fold the words recorded in Protocol Chaos into structure (draft 0.2 servers)
version: 0.2.0
metadata:
  hermes:
    tags: [protocol-chaos, organizer, scheduled]
---

# Protocol Chaos organizer

During the day, assistants only record what the user says (`event_note`): the words are
stored, nothing else changes, so no answer waits on the repository. This run does the rest.
It reads the words recorded since the last run and folds them into structure: title, state,
progress, facts, the people and places involved, and the hierarchy. Nobody is waiting for
it. Be thorough and careful, and never ask the user anything during the run.

It needs the repository's tools, so Hermes must also have the server configured as the MCP
server `protocol_chaos`, with the same token as the plugin.

## When to use

- The scheduled run, usually at night.
- When the user asks to organize their Protocol Chaos repository.

## Procedure

1. **Checkpoint.** Read `~/.hermes/protocol-chaos/organizer-checkpoint`, one line holding a
   UTC timestamp such as `2026-10-22T03:00:00.000Z`. If it is missing or unreadable, use the
   time 26 hours before now. Going over words a second time changes nothing, so erring early
   is safe.
2. **Words.** Call `event_words_since` with `since` set to the checkpoint. Each Event in
   `events` comes with its current `title`, `state`, `facts`, `refs`, `progress`, `parents`
   and `version`, and `words`: its new Accounts, oldest first, each with `id`, `text`,
   `source`, `actor` and `createdAt`. When `remaining` is above 0, finish this batch, then
   call again with the returned `checkpoint` as `since`. Stop after five batches.
3. **Directory.** Call `context_pack` once (page with `cursor` while it returns `next`). Its
   directory of every Event is what you check for larger matters, duplicates and existing
   parts.
4. **Each Event.** Decide what its new words establish beyond what its fields already say. If
   nothing, move on. Otherwise write it with one `event_record_expression`:
   - `eventId`, and `expectedVersion`: the Event's `version`.
   - `actor`: `{"kind": "agent", "id": "hermes"}` (the client name this Hermes's token was
     issued for, if it is not `hermes`).
   - `accountId`: the word the change rests on (the latest of them, when several do), and
     `text`: that word's `text`, character for character. `accountSource`: its `source`.
   - `set`: only the fields that change, each as its complete new value: `title`, `state`,
     `progress` (`{"text": "...", "timestamp": "<the word's createdAt>"}`), `facts` (only the
     keys that change, each a sentence), `refs`.
   Check the receipt's `changed`. Use its `version` for any further write on that Event.
5. **Hierarchy.** Words belong on the most specific Event, so keep the tree whole:
   - When an Event you touch is plainly part of, or a step toward, a larger one in the
     directory, call `event_add_parent` with `childEventId`, `parentEventId`,
     `sourceAccountIds: [<the word's id>]`, `actor`, and the child's current version as
     `expectedVersion`.
   - When the words name a concrete matter with its own lifecycle inside a broad one (a
     specific trip within travel plans), and no such Event exists yet, start it with
     `event_note`: the words about it, verbatim, as `text`, their `source` as
     `accountSource`, a `title`, and the broad one as `parentEventId`. Then give it its
     fields with `event_record_expression`, grounded on the Account the receipt returns, and
     rewrite the broad one's facts without what now lives in the part: it keeps what holds
     for all its parts.
   - When new words landed on a broad Event but are about one of its parts, fold them into
     the part (as with duplicates, below), not the broad one.
6. **Duplicates.** When an Event recorded today is the same matter as an existing one, fold
   its words into the existing one: `event_record_expression` on that one with the words as
   `text`, verbatim, and no `accountId`, since the Account belongs to the other Event. Then
   close the duplicate, grounded on its own word: `set.state` `cancelled` and `set.progress`
   `{"text": "并入 <title of the other>"}`. Do not delete anything.
7. **People and things.** Words that say who someone is, what they like, or how things
   stand with them belong on Entities: `entity_search` first, then `entity_record` (with the
   Entity's `version` as `expectedVersion`), or `entity_create` when nothing matches: one fact
   per Statement, with the words as `text` (or `accountText`), verbatim. Point the Event at
   the Entity with a `refs` entry `{"ref": "<entity id>"}`; describe anyone or anything that
   has no Entity with `{"criteria": "..."}`. Never point an Event at the user.
8. **Save the checkpoint.** Write the last `checkpoint` you received to the checkpoint file,
   creating `~/.hermes/protocol-chaos/` if needed.
9. **Report** (below).

## How to write structure

- **Three fact keys.** `goal`: what the Event is meant to achieve, including what would
  count as done. `constraint`: conditions it must meet, such as limits, deadlines, budgets,
  wishes and preferences, even a wish about a place or a time. `plan`: the arrangement as
  currently decided: when, where, how, which option. A wish moves from `constraint` into
  `plan` once it is decided; never put the same thing in both.
- **Complete content.** A value replaces the previous one. Write everything that still
  holds plus the change, in natural language, clear on its own. Never an object or list.
- **Older details.** An Event may carry details from an earlier version of the repository
  under `metadata` (for example `dev.protocol-chaos/legacy-0.1`: facts under older keys such
  as a budget or a place, or what would count as done). They are things the user said
  before: when you next write that aspect, fold what still holds into `goal`, `constraint`
  or `plan`.
- **Concrete times, from when the words were said.** A relative time is relative to the
  word's `createdAt`, not to now: "this weekend", said on 2026-10-16, is 2026-10-17 to 10-18.
  Leave it as said when it depends on something else ("before I turn 40").
- **Never "the user".** The repository is theirs; do not write them into facts or refs.
- **Progress is not a fact.** Where the Event stands goes in `progress`.
- **State.** `active` while the user is pursuing it, `waiting` while it waits on something,
  `dormant` while it is set aside, `done` when it is achieved, `cancelled` when it is given
  up or folded into another. `emerging` is where a new Event starts.
- **Title.** A name in the user's language that identifies the Event on its own: what it
  is, plus when or which wherever a similar Event could follow ("2027 年春天葡萄牙行（和朋友）",
  "2026 年秋天搬家"), never a bare topic ("葡萄牙", "搬家"). Give one to an untitled Event,
  rename one that would be ambiguous next to its siblings, and keep a good existing one.
- **Newer words win.** When new words contradict a fact, rewrite the fact. Words with
  `source: "agent_response"` are an assistant's inference: fold them only as an inference
  with its basis ("推测：…（依据：…）"), and never over the user's own words.
- **Not every word is structure.** Words that change no field add nothing: small talk,
  instructions to an assistant, questions, one-off occurrences such as a meal or a workout,
  and an assistant's own calculations. A feeling, news or progress said in the same message
  does change a field: a feeling about eating too much while losing weight is a constraint
  on the weight-loss Event, friends coming to stay is a new Event, "三天健康饮食" is
  progress.

## Report

- Your final answer is delivered to the user. Write it in the language of their words.
- If you changed nothing, answer exactly `[SILENT]` and nothing else.
- Otherwise at most eight short lines: what you organized, by Event title; new Events and
  links; and, under a last line starting `需要你拍板`, only what you could not decide (two
  plausible readings, a contradiction without a clear newer side). No ids, no tool names, no
  apology.

## Pitfalls

- `text` is the stored words, never a summary or a paraphrase. With `accountId`, the text
  must be that Account's text exactly, or the write is refused.
- Do not use `event_note` for words that are already stored; it adds a second copy. It is
  only for starting a part (step 5).
- `VERSION_CONFLICT`: someone wrote first. Read the Event again with `event_get_protocol`,
  reconsider, and write again with its current version. On any other refusal, read the
  message, correct the call once, and if it still fails, list it in the report.
- Leave alone Events whose words add nothing, and never touch words you did not get from
  `event_words_since`.
- No secrets, ever: passwords, tokens, identity-document numbers.

## Verification

Every receipt's `changed` lists what you meant to change, and the checkpoint file holds the
last checkpoint received.
