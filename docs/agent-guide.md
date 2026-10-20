# Agent guide

> **Not normative.** How a client can give a good experience on top of the protocol. None of this is required to interoperate; the rules are in [PROTOCOL.md](../PROTOCOL.md). Written for draft 0.2.

## Answer first

The repository must not slow the answer down. Every tool call an agent makes before answering costs one more round of the model over the whole conversation, so:

- **Answer from what the conversation already holds.** Never re-read what is already there.
- **Decide on your own side what to read.** Load the directory (`context_pack`) once per conversation and keep it, checking with `sinceVersion` whether it changed. From the directory and the message, decide which Events the message is about, and read only those, by id (`event_get_protocol`). Do not send every message to the repository: send what you decided you need (PROTOCOL.md §10).
- **Read in full only when the answer needs it.** The directory is enough to know that an Event exists and where it stands.
- **Check before saying you cannot see something.** Before answering about the user's own plans, trips, commitments or budgets, or anything they say they mentioned before, look in what the conversation holds and in the directory. An empty result is an answer; not checking is an error. Do not consult the repository for task work that has nothing to do with the user's matters.

A server may offer more, such as an operation that takes a message and finds the related Events itself. Use it only for messages you already judged to be about the user's matters.

## Record after answering

- After answering, decide whether the user's words change an Event or start one (PROTOCOL.md §7, rule 1). Deciding is not optional: silently doing nothing is the most common failure.
- Look past the request. "How many calories is this?" ends when answered; "how many calories is this? way too much, I'm trying to lose weight" also carries a limit on the weight-loss Event, and that part is recorded. A feeling, news about the user's life, or progress said alongside a request is what you record.
- Record with one `event_note`: the user's words, verbatim, and the id of the most specific Event they are about. For a new Event, give a title that identifies it on its own, and `parentEventId` when it belongs under a larger one.
- Do not search, read or restructure an Event just to record words. Fields and links can be filled in later (below).
- When the user explicitly asks for a change now ("mark it done", "the plan is now…"), make it right away with `event_record_expression`.
- A rejected write means the words were not saved. Read the error, fix the call and try again; if it still fails after two attempts, tell the user plainly.

## Organize later

An **organizer** is an agent that folds recorded words into fields and links, away from the conversation, for example once a night:

1. Fetch the words since the last run with `event_words_since`, and keep the returned `checkpoint` for next time.
2. For each Event, fold its new words into `title`, `state`, `progress`, `facts` and `refs` with `event_record_expression`, grounding each change on the Account that supports it (`accountId`, with that Account's text). Write the complete current content of every field you change.
3. Split a concrete Event out of a broad one: start it with `event_note` under the broad one, carrying over the words that belong to it, verbatim, and remove from the broad one what now belongs to the part.
4. Link what plainly belongs together with `event_add_parent`. When an Event is itself a larger matter, attach the existing Events that are plainly its parts.
5. When two Events are the same matter, record on the older one what the newer one holds, and close the newer one as `cancelled` with a note saying where it went. Never delete.
6. Leave a short report for the user of what changed. Every change is a Revision, so any of it can be put back.

Going over the same words twice changes nothing, so a lost checkpoint costs time, not correctness.

## Talking to the user

- The repository exists to organise what the user has said, so that every agent can serve them better. It does not exist to make Events complete. Vague and fragmentary Events are normal.
- Do not ask the user to fill in details, to confirm a link, or to approve how you organised something. Ask only before an action that cannot be undone or that reaches outside the repository (booking, paying, sending), or when the answer changes what you are about to do for them now.
- Mark what you infer, with its basis, and rewrite it when the user says otherwise. Never act on an unconfirmed inference in a way that cannot be undone.
- When the answer depends on who the user is, read the owner's summary once per conversation (`entity_get` with `current_user` and `view: "summary"`).

## Server instructions

Many clients show the agent only the server's `instructions` and the tool descriptions. A template, kept under 2,000 characters because some clients cut longer text:

```text
This server holds the user's Events: the long-lived matters they tell their assistants about (trips, plans, purchases, ambitions), and the people and places involved. It outlives conversations, assistants and machines. It exists to organise what the user said, not to make Events complete.

READ ON YOUR SIDE. Answer from what the conversation holds. When the answer depends on the user's own matters, use the directory (context_pack) to decide which Events matter, and read only those by id. Never send unrelated messages.

RECORD AFTER. After answering, record only words that change an Event (its title, state, progress, goal, constraint, plan, refs or parents) or start one: an intention, plan, commitment, purchase, trip, target or arrangement that outlasts the conversation. One event_note with the user's words and the most specific Event's id; for a new Event, a title that names it on its own and parentEventId when it belongs under one. Never questions, hypotheticals, requests for work, fragments such as a meal or a workout, or your own calculations; but do record a feeling, news or progress said along with them.

VERBATIM. Account text is the user's actual sentence, never a summary. Mark your inferences with their basis; the user's words win.

YOUR NAME. Write as yourself (actor), never as the user or another assistant.

DON'T ASK TO TIDY. Do not ask the user to fill in details or approve the organisation; ask only before an irreversible or outward action.
```

## Clients

- **Name the server `protocol_chaos`** in the client's MCP configuration, so that tool names read the same in every client and in any instructions written for them.
- **Install standing instructions** where the client keeps them: `AGENTS.md` for Codex, a steering file for Kiro, `CLAUDE.md` for Claude Code, a rules file elsewhere. Clients that show neither instructions nor tool descriptions to the model need them most.
- **Avoid prompt hooks that send every prompt to the server.** They conflict with §10 of the protocol. A hook that runs on the client and decides there what to read is fine.
- **For several computers,** run one server that every client reaches over the network, with its own credential for each client (PROTOCOL.md §9.2).
