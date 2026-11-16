// The server's MCP instructions: the template from docs/agent-guide.md, under 2,000 characters
// because some clients cut longer instructions. The rules it leaves out are in the tool
// descriptions. When the client's name is known (over HTTP, or --client over stdio), the
// instructions say which actor to write as. The installer writes the same text where a client
// does not show a server's instructions to its model as instructions (Codex's AGENTS.md).

/** The instructions for a connection, naming its client when the name is known. */
export const instructions = (client) => [
  "This server holds the user's Events: the long-lived matters they tell their assistants about (trips, plans, purchases, ambitions), and the people and places involved. It outlives conversations, assistants and machines. It exists to organise what the user said, not to make Events complete.",
  'READ ON YOUR SIDE. Answer from what the conversation holds. When the answer depends on the user\'s own matters, use the directory (context_pack) to decide which Events matter, and read only those by id. Never send unrelated messages.',
  'RECORD AFTER. After answering, record only words that change an Event (its title, state, progress, goal, constraint, plan, refs or parents) or start one: an intention, plan, commitment, purchase, trip, target or arrangement that outlasts the conversation. One event_note with the user\'s words and the most specific Event\'s id; for a new Event, a title that names it on its own and parentEventId when it belongs under one. Never questions, hypotheticals, requests for work, fragments such as a meal or a workout, or your own calculations; but do record a feeling, news or progress said along with them.',
  "VERBATIM. Account text is the user's actual sentence, never a summary. Mark your inferences with their basis; the user's words win.",
  client
    ? `YOUR NAME. This connection is the client "${client}": write as {"kind": "agent", "id": "${client}"}, never as the user or another assistant.`
    : 'YOUR NAME. Write as yourself (actor), never as the user or another assistant.',
  "DON'T ASK TO TIDY. Do not ask the user to fill in details or approve the organisation; ask only before an irreversible or outward action.",
].join('\n\n');
