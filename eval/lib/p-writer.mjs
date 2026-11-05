// The protocol arm's starting store: canonical matters written through the reference
// server's own Repository, as the assistants would have written them, each operation at the
// date it happened (the server's clock is fixed for each one). The result is the server's
// own file, repository.json, which a server started on that directory reads as it is.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setClockForEvaluation } from '../../server/clock.mjs';
import { Repository } from '../../server/repository.mjs';
import { beijingDate, writeFileAtomic } from './util.mjs';

export const ASSISTANT_IDS = { A: 'assistant-a', B: 'assistant-b', C: 'assistant-c' };
const LETTER_OF = Object.fromEntries(Object.entries(ASSISTANT_IDS).map(([letter, id]) => [id, letter]));
const actorOf = (letter) => ({ kind: 'agent', id: ASSISTANT_IDS[letter] });
const MAX_PER_DAY = 3600;

/** Every write the matters took, in the order they happened. */
function operations(matters) {
  const ops = [];
  matters.forEach((matter, index) => {
    matter.accounts.forEach((account, at) => ops.push({ date: account.date, seq: index * 1000 + at, kind: 'note', matter, account, at }));
    if (matter.organizedBy) ops.push({ date: matter.organizedBy.date, seq: index * 1000 + 999, kind: 'organize', matter });
  });
  return ops.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
}

/**
 * Writes `<directory>/repository.json` holding the matters. Parents must come before their
 * parts in `matters`, and a part's first words must not be older than its parent's.
 * @returns {{eventIds: Object<string, string>, accountIds: Object<string, string[]>}} by matter key
 */
export function writeRepository(matters, directory) {
  const repo = new Repository();
  const eventIds = {};
  const accountIds = {};
  const perDay = new Map();
  let instant = 0;
  setClockForEvaluation(() => instant);
  try {
    for (const op of operations(matters)) {
      const n = perDay.get(op.date) ?? 0;
      if (n >= MAX_PER_DAY) throw new Error(`more than ${MAX_PER_DAY} writes on ${op.date}`);
      perDay.set(op.date, n + 1);
      instant = Date.parse(`${op.date}T12:00:00.000Z`) + n * 1000;
      const { matter } = op;
      if (op.kind === 'note') {
        const input = { actor: actorOf(op.account.assistant), text: op.account.text, accountSource: op.account.source };
        if (op.at === 0) {
          input.title = matter.title;
          if (matter.parent) {
            if (!eventIds[matter.parent]) throw new Error(`${matter.key}: its parent ${matter.parent} has no words yet on ${op.date}`);
            input.parentEventId = eventIds[matter.parent];
          }
        } else {
          input.eventId = eventIds[matter.key];
        }
        const receipt = repo.eventNote(input);
        eventIds[matter.key] = receipt.eventId;
        (accountIds[matter.key] ??= []).push(receipt.accountId);
      } else {
        const index = matter.accounts.findLastIndex((account) => account.date <= matter.organizedBy.date);
        if (index < 0) throw new Error(`${matter.key}: organized before any words`);
        const set = { state: matter.state };
        const facts = Object.fromEntries(['goal', 'constraint', 'plan'].filter((k) => matter.facts[k]).map((k) => [k, matter.facts[k]]));
        if (Object.keys(facts).length) set.facts = facts;
        if (matter.progress) set.progress = { text: matter.progress.text, timestamp: `${matter.progress.date}T12:00:00.000Z` };
        const receipt = repo.recordExpression({
          eventId: eventIds[matter.key],
          actor: actorOf(matter.organizedBy.assistant),
          accountId: accountIds[matter.key][index],
          text: matter.accounts[index].text,
          expectedVersion: repo.getProtocol({ eventId: eventIds[matter.key], accounts: 0 }).event.version,
          set,
        });
        if (receipt.changed.length === 0) throw new Error(`${matter.key}: organizing it changed nothing, so who organized it would be lost`);
      }
    }
    instant = Math.max(instant, repo.lastTime) + 1;
    const snapshot = repo.exportRepository({});
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(directory, 'repository.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 0o600);
  } finally {
    setClockForEvaluation(() => Date.now());
  }
  return { eventIds, accountIds };
}

/** A store written by writeRepository (or by models through the server) as canonical matters keyed by title. */
export function readRepository(directory) {
  const snapshot = JSON.parse(readFileSync(join(directory, 'repository.json'), 'utf8'));
  const repo = new Repository();
  repo.importRepository({ snapshot });
  const titleOf = new Map([...repo.events.values()].map((rec) => [rec.doc.id, rec.doc.title]));
  return [...repo.events.values()].map((rec) => {
    const { doc } = rec;
    if (doc.parents.length > 1) throw new Error(`${doc.id} has ${doc.parents.length} parents`);
    const organizing = rec.revisions.filter((r) => r.type === 'field.changed' && r.payload.field !== 'title').at(-1);
    const facts = {};
    for (const key of ['goal', 'constraint', 'plan']) if (doc.facts?.[key] !== undefined) facts[key] = doc.facts[key];
    return {
      key: doc.title,
      title: doc.title,
      state: doc.state,
      parent: doc.parents.length ? titleOf.get(doc.parents[0]) : null,
      facts,
      progress: doc.progress ? { text: doc.progress.text, date: beijingDate(doc.progress.timestamp) } : null,
      accounts: rec.accounts.map((a) => ({
        date: beijingDate(a.createdAt), assistant: LETTER_OF[a.actor.id] ?? a.actor.id, source: a.source, text: a.text,
      })),
      organizedBy: organizing ? { assistant: LETTER_OF[organizing.actor.id] ?? organizing.actor.id, date: beijingDate(organizing.occurredAt) } : null,
    };
  });
}
