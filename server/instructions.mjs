// The server's MCP instructions: the template from docs/agent-guide.md, under 2,000 characters
// because some clients cut longer instructions. The rules it leaves out are in the tool
// descriptions. When the client's name is known (over HTTP, or --client over stdio), the
// instructions say which actor to write as. The installer writes the same text where a client
// does not show a server's instructions to its model as instructions (Codex's AGENTS.md, a Kiro
// steering file, a Cursor skill), followed by IMPORT_STATIC.
//
// While memories from other assistants wait to be imported, are being imported, or wait to be
// reported (memories.mjs), the instructions end with one more paragraph saying so.

/** The paragraph for the import of other assistants' memories, by its status; undefined otherwise. */
export function importParagraph(status) {
  if (status === 'pending') {
    return 'IMPORT. Memories that other assistants keep on this machine can be imported into this repository. Once per conversation, in your first reply: call memories_import with action status and, besides answering, tell the user what it returns (what would be read, the estimated tokens and time, where the text goes) and ask whether to import. Start or decline only on their answer.';
  }
  if (status === 'running') {
    return 'IMPORT. Memories from other assistants are being imported in the background. In your first reply, or when the user asks, call memories_import with action status and tell them how far it got.';
  }
  if (status === 'done') {
    return 'IMPORT. The import of memories from other assistants has finished. Once per conversation, in your first reply: call memories_import with action status, show the user its report and the tree of their matters, then call it with action finish.';
  }
  return undefined;
}

/**
 * The line written after the instructions where they are written down once (AGENTS.md, steering,
 * a skill): the tool is offered only while there is an import to offer, follow or report.
 */
export const IMPORT_STATIC = 'IMPORT. When this server offers the tool memories_import, call it once per conversation, in your first reply, with action status, and follow what it returns: that is how memories other assistants keep on this machine are offered to the user, imported once they agree, and reported when done.';

/** The instructions for a connection, naming its client when the name is known. */
export const instructions = (client, { importStatus } = {}) => [
  "This server holds the user's Events: the long-lived matters they tell their assistants about (trips, plans, purchases, ambitions), and the people and places involved. It outlives conversations, assistants and machines. It exists to organise what the user said, not to make Events complete.",
  'READ ON YOUR SIDE. Answer from what the conversation holds. When the answer depends on the user\'s own matters, use the directory (context_pack) to decide which Events matter, and read only those by id. Never send unrelated messages.',
  'RECORD AFTER. After answering, record only words that change an Event (its title, state, progress, goal, constraint, plan, refs or parents) or start one: an intention, plan, commitment, purchase, trip, target or arrangement that outlasts the conversation. One event_note with the user\'s words and the most specific Event\'s id; for a new Event, a title that names it on its own and parentEventId when it belongs under one. Never questions, hypotheticals, requests for work, fragments such as a meal or a workout, or your own calculations; but do record a feeling, news or progress said along with them.',
  "VERBATIM. Account text is the user's actual sentence, never a summary. Mark your inferences with their basis; the user's words win.",
  client
    ? `YOUR NAME. This connection is the client "${client}": write as {"kind": "agent", "id": "${client}"}, never as the user or another assistant.`
    : 'YOUR NAME. Write as yourself (actor), never as the user or another assistant.',
  "DON'T ASK TO TIDY. Do not ask the user to fill in details or approve the organisation; ask only before an irreversible or outward action.",
  importParagraph(importStatus),
].filter(Boolean).join('\n\n');
