// Optional levels: Search (§8.2), Sync (§8.3) and Undo (§8.4).
const ENTRY_FIELDS = new Set(['id', 'title', 'state', 'parents', 'progress', 'updatedAt']);
const SYNC_FIELDS = new Set(['id', 'version', 'title', 'state', 'facts', 'refs', 'progress', 'parents', 'words']);
const ACCOUNT_FIELDS = new Set(['id', 'eventId', 'text', 'source', 'via', 'actor', 'createdAt']);
const CHANGES = new Set(['field.changed', 'parent.added', 'parent.removed']);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A word made only of letters and digits, unique to this run. */
const token = (t, base) => `${base}${t.unique('').replace(/[^A-Za-z0-9]/g, '')}`;

/**
 * A moment on the server's own clock, so that client and server clocks never have to agree:
 * the createdAt of a new Account. Every Account written afterwards is later.
 */
async function serverNow(t) {
  const event = await t.newEvent('Clock');
  const { accounts } = await t.read(event.id);
  await pause(20);
  return accounts.at(-1).createdAt;
}

function checkEntries(t, events, label) {
  t.assert(Array.isArray(events), `${label} returns {events}`);
  for (const entry of events) {
    for (const key of Object.keys(entry)) t.assert(ENTRY_FIELDS.has(key), `${label}: unexpected member "${key}" in an entry`);
    t.assert(typeof entry.id === 'string' && typeof entry.state === 'string' && Array.isArray(entry.parents) && typeof entry.updatedAt === 'string',
      `${label}: entry ${entry.id} has id, state, parents and updatedAt`);
  }
}

const undo = (t, revisionId) => t.call('event_undo_revision', { revisionId, actor: t.actor });
const link = (t, child, parent, expectedVersion) => t.call('event_add_parent', {
  childEventId: child.id, parentEventId: parent.id, actor: t.actor, sourceAccountIds: [child.accountId], expectedVersion,
});
/** The changes that can still be undone, oldest first. */
const undoable = (revisions) => revisions.filter((revision) => CHANGES.has(revision.type) && !revision.revertedByRevisionId);

export default [
  {
    id: 'search.title', level: 'search', ref: '§8.2', title: 'event_search returns every Event whose title contains the query, ignoring case',
    async run(t) {
      const word = token(t, 'Kestrel');
      const first = await t.note(t.unique('Kayaking along the coast next summer'), { title: `Kayak trip ${word}, summer 2027` });
      const second = await t.note(t.unique('Joining the paddle club'), { title: `${word.toUpperCase()} paddle club` });
      await t.note(t.unique(`Words that mention ${word} outside a title`));
      const { events } = await t.call('event_search', { query: word.toLowerCase() });
      checkEntries(t, events, 'event_search');
      const ids = events.map((entry) => entry.id);
      t.assert(ids.includes(first.eventId) && ids.includes(second.eventId), 'both Events whose titles contain the query are found');
      t.equal(new Set(ids).size, ids.length, 'no Event is listed twice');
    },
  },
  {
    id: 'search.state', level: 'search', ref: '§8.2', title: 'event_search filters by state, open or closed',
    async run(t) {
      const word = token(t, 'Heron');
      const open = await t.note(t.unique('An open matter'), { title: `Open ${word}` });
      const done = await t.note(t.unique('A finished matter'), { title: `Done ${word}` });
      await t.record(done.eventId, done.version, t.unique('That one is finished'), { state: 'done' });
      const ids = async (state) => {
        const { events } = await t.call('event_search', { query: word, state });
        checkEntries(t, events, `event_search with state ${state}`);
        return events.map((entry) => entry.id);
      };
      const closed = await ids('closed');
      t.assert(closed.includes(done.eventId) && !closed.includes(open.eventId), 'closed');
      const opened = await ids('open');
      t.assert(opened.includes(open.eventId) && !opened.includes(done.eventId), 'open');
      const finished = await ids('done');
      t.assert(finished.includes(done.eventId) && !finished.includes(open.eventId), 'done');
    },
  },
  {
    id: 'search.query', level: 'search', ref: '§8.2', title: 'event_search needs a query',
    async run(t) {
      await t.fails('VALIDATION_ERROR', () => t.call('event_search', {}), 'a search without a query');
      await t.fails('VALIDATION_ERROR', () => t.call('event_search', { query: '   ' }), 'a blank query (§4.1)');
    },
  },
  {
    id: 'sync.words', level: 'sync', ref: '§8.3', title: 'event_words_since returns the words recorded after a moment, by Event, with a checkpoint',
    async run(t) {
      const since = await serverNow(t);
      const a = await t.newEvent('Sync A');
      await pause(5);
      const title = t.unique('Sync B');
      const b = await t.note(t.unique('Sync B words'), { title });
      await pause(5);
      const more = await t.note(t.unique('More words for A'), { eventId: a.id });
      const { version } = await t.call('context_pack', {});
      const result = await t.call('event_words_since', { since });
      t.equal(result.version, version, 'version is the repository version');
      t.equal(result.remaining, 0, 'nothing remains');
      t.assert(typeof result.checkpoint === 'string' && result.checkpoint.length > 0, 'a checkpoint');
      t.assert(Array.isArray(result.events), 'events');
      for (const entry of result.events) {
        for (const key of Object.keys(entry)) t.assert(SYNC_FIELDS.has(key), `unexpected member "${key}" in an entry`);
        t.assert(Number.isInteger(entry.version) && typeof entry.state === 'string' && Array.isArray(entry.parents) && Array.isArray(entry.words),
          `entry ${entry.id}: version, state, parents and words`);
        for (const word of entry.words) for (const key of Object.keys(word)) t.assert(ACCOUNT_FIELDS.has(key), `unexpected member "${key}" in a word`);
      }
      const entries = Object.fromEntries(result.events.map((entry) => [entry.id, entry]));
      t.assert(Object.keys(entries).length === 2 && entries[a.id] && entries[b.eventId], `the two Events that gained words, got ${JSON.stringify(Object.keys(entries))}`);
      t.equal(entries[a.id].words.map((word) => word.id), [a.accountId, more.accountId], "A's new words, oldest first");
      t.equal(entries[b.eventId].words.map((word) => word.id), [b.accountId], "B's words");
      t.equal(entries[a.id].version, more.version, "A's current version");
      t.equal(entries[b.eventId].title, title, "B's title");
      t.assert(!('facts' in entries[b.eventId]) && !('refs' in entries[b.eventId]), 'fields that are not set are absent');
      const next = await t.call('event_words_since', { since: result.checkpoint });
      t.equal([next.events, next.remaining, next.checkpoint], [[], 0, result.checkpoint], 'nothing after the checkpoint, which stays where it was');
      await t.fails('VALIDATION_ERROR', () => t.call('event_words_since', {}), 'a call without since');
      await t.fails('VALIDATION_ERROR', () => t.call('event_words_since', { since: 'yesterday' }), 'a since that is not a timestamp');
    },
  },
  {
    id: 'sync.batches', level: 'sync', ref: '§8.3', title: 'Batches follow the checkpoint without gaps or repeats, and count what remains',
    async run(t) {
      const since = await serverNow(t);
      // Words in the order A, A, B, C, A: with one Event per batch, the batches are
      // A (two words), B, C and A again.
      const a = await t.newEvent('Batch A');
      await pause(5);
      const a2 = await t.note(t.unique('Batch A, more'), { eventId: a.id });
      await pause(5);
      const b = await t.newEvent('Batch B');
      await pause(5);
      const c = await t.newEvent('Batch C');
      await pause(5);
      const a3 = await t.note(t.unique('Batch A again'), { eventId: a.id });
      const expected = [[a.id, [a.accountId, a2.accountId]], [b.id, [b.accountId]], [c.id, [c.accountId]], [a.id, [a3.accountId]]];
      const batches = [];
      let cursor = since;
      let left = 5;
      for (let round = 0; round < 10 && left > 0; round += 1) {
        const batch = await t.call('event_words_since', { since: cursor, limit: 1 });
        batches.push(...batch.events.map((entry) => [entry.id, entry.words.map((word) => word.id)]));
        t.assert(batch.events.length === 1, `a batch holds one Event with limit 1, got ${batch.events.length}`);
        left -= batch.events.reduce((sum, entry) => sum + entry.words.length, 0);
        t.equal(batch.remaining, left, `remaining after batch ${round + 1}`);
        cursor = batch.checkpoint;
      }
      t.equal(batches, expected, 'the batches: limit counts Events, and every word comes once, in the order recorded');
    },
  },
  {
    id: 'sync.ties', level: 'sync', ref: '§8.3', title: 'A batch never ends between two Accounts with the same createdAt',
    async run(t) {
      if (!t.tools.has('repository_export') || !t.tools.has('repository_import')) t.skip('needs repository_export and repository_import to set up Accounts with the same createdAt');
      const a = await t.newEvent('Tie A');
      const b = await t.newEvent('Tie B');
      const snapshot = await t.call('repository_export', {});
      t.assert(Array.isArray(snapshot.events), 'an export holds {events} (§8.6)');
      const tied = '2026-03-14T09:30:00.000Z';
      snapshot.events = snapshot.events.filter((item) => item?.event && [a.id, b.id].includes(item.event.id));
      snapshot.entities = [];
      for (const item of snapshot.events) for (const account of item.accounts) account.createdAt = tied;
      const fresh = await t.fresh();
      try {
        await fresh.call('repository_import', { snapshot });
        const batch = await fresh.call('event_words_since', { since: '1970-01-01T00:00:00.000Z', limit: 1 });
        t.assert(Array.isArray(batch.events), 'event_words_since returns {events}');
        t.equal(batch.events.map((entry) => entry.id).sort(), [a.id, b.id].sort(), 'both Events, though limit is 1');
        t.equal([batch.remaining, batch.checkpoint], [0, tied], 'nothing remains; the checkpoint is the shared createdAt');
      } finally {
        await fresh.close();
      }
    },
  },
  {
    id: 'undo.walk', level: 'undo', ref: '§8.4', title: 'Undo restores the latest change, passes over words in between, and walks back',
    async run(t) {
      const event = await t.newEvent('Undo');
      let receipt = await t.record(event.id, event.version, t.unique('Name it'), { title: 'Learn the cello' });
      receipt = await t.record(event.id, receipt.version, t.unique('The aim'), { facts: { goal: 'Play in a quartet.' } });
      receipt = await t.record(event.id, receipt.version, t.unique('A bigger aim'), { facts: { goal: 'Play in an orchestra.' } });
      await t.note(t.unique('Words recorded in between'), { eventId: event.id });
      let revisions = await t.revisions(event.id);
      const latest = undoable(revisions).at(-1);
      t.equal(latest.payload, { field: 'facts.goal', before: 'Play in a quartet.', after: 'Play in an orchestra.' }, 'the latest change');
      const reverted = await undo(t, latest.id);
      t.equal([reverted.type, reverted.payload, reverted.targetEventId, reverted.sourceAccountIds], ['revision.reverted', { revisionId: latest.id }, event.id, []], 'the undo Revision');
      t.equal(reverted.actor, t.actor, 'its actor');
      t.equal(reverted.newVersion, reverted.baseVersion + 1, 'it adds one version');
      let document = (await t.read(event.id)).event;
      t.equal(document.facts, { goal: 'Play in a quartet.' }, 'the goal is restored');
      t.equal(document.version, reverted.newVersion, 'the document version');
      const before = revisions.length;
      revisions = await t.revisions(event.id);
      t.equal(revisions.length, before + 1, 'one Revision was added');
      t.equal(revisions.find((revision) => revision.id === latest.id).revertedByRevisionId, reverted.id, 'the undone Revision names its undo');
      for (const expected of [{ field: 'facts.goal', before: null, after: 'Play in a quartet.' }, { field: 'title', before: null, after: 'Learn the cello' }]) {
        const next = undoable(await t.revisions(event.id)).at(-1);
        t.equal(next.payload, expected, 'the next change back');
        await undo(t, next.id);
      }
      document = (await t.read(event.id)).event;
      t.assert(!('facts' in document) && !('title' in document), 'walking back removed the goal and the title');
      t.equal((await t.read(event.id, { accounts: 'all' })).accounts.length, 5, 'every word is still there');
    },
  },
  {
    id: 'undo.refused', level: 'undo', ref: '§8.4', title: 'Creation, words, undos, undone and earlier changes cannot be undone',
    async run(t) {
      const event = await t.newEvent('Undo refused');
      let receipt = await t.record(event.id, event.version, t.unique('First name'), { title: 'A' });
      receipt = await t.record(event.id, receipt.version, t.unique('Second name'), { title: 'B' });
      const revisions = await t.revisions(event.id);
      const refuse = (revision, label) => t.fails('REVISION_NOT_REVERSIBLE', () => undo(t, revision.id), label);
      await refuse(revisions.find((revision) => revision.type === 'event.created'), 'event.created');
      await refuse(revisions.find((revision) => revision.type === 'account.added'), 'account.added');
      const [earlier, later] = undoable(revisions);
      await refuse(earlier, 'a change that is not the latest');
      const reverted = await undo(t, later.id);
      await refuse(later, 'a change already undone');
      await refuse(reverted, 'an undo');
      await t.fails('NOT_FOUND', () => undo(t, 'rev_does_not_exist_0000'), 'an unknown Revision');
      const document = (await t.read(event.id)).event;
      t.equal([document.title, document.version], ['A', reverted.newVersion], 'only the one undo took effect');
    },
  },
  {
    id: 'undo.parents', level: 'undo', ref: '§8.4', title: 'Undo removes an added link, and will not restore one that would close a cycle',
    async run(t) {
      const a = await t.newEvent('Undo link A');
      const b = await t.newEvent('Undo link B');
      await link(t, a, b, a.version);
      const added = (await t.revisions(a.id)).at(-1);
      t.equal([added.type, added.payload], ['parent.added', { parentEventId: b.id }], 'the link');
      await undo(t, added.id);
      let document = (await t.read(a.id)).event;
      t.equal(document.parents, [], 'undoing parent.added removes the link');
      const relinked = await link(t, a, b, document.version);
      await t.call('event_remove_parent', {
        childEventId: a.id, parentEventId: b.id, actor: t.actor, sourceAccountIds: [a.accountId], expectedVersion: relinked.version,
      });
      const removal = (await t.revisions(a.id)).at(-1);
      t.equal(removal.type, 'parent.removed', 'the removal');
      await link(t, b, a, (await t.read(b.id)).event.version);
      document = (await t.read(a.id)).event;
      await t.fails('PART_OF_CYCLE', () => undo(t, removal.id), 'restoring a link that would close a cycle');
      t.equal((await t.read(a.id)).event, document, 'nothing changed');
    },
  },
];
