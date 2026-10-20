// Core level: principles (§3), Events (§4), writing (§5), the core operations (§8.1),
// export and import (§8.6), the MCP binding (§9.1) and versioning (§11).
import { ToolError } from '../lib.mjs';

export const STATES = ['emerging', 'active', 'waiting', 'dormant', 'done', 'cancelled'];
const CORE_TOOLS = ['event_note', 'event_record_expression', 'event_add_parent', 'event_remove_parent', 'event_get_protocol', 'context_pack', 'event_get_revisions'];
const READ_TOOLS = ['event_get_protocol', 'context_pack', 'event_get_revisions', 'event_search', 'event_words_since', 'entity_search', 'entity_get', 'repository_export'];
const DOCUMENT_FIELDS = new Set(['id', 'version', 'createdAt', 'updatedAt', 'title', 'state', 'progress', 'facts', 'refs', 'parents', 'metadata']);
const ENTRY_FIELDS = new Set(['id', 'title', 'state', 'parents', 'progress', 'updatedAt']);
const ACCOUNT_FIELDS = new Set(['id', 'eventId', 'text', 'source', 'via', 'actor', 'createdAt']);

export function checkReceipt(t, receipt, label) {
  t.assert(receipt && typeof receipt === 'object', `${label}: the receipt is an object (§8.1)`);
  t.assert(typeof receipt.eventId === 'string' && receipt.eventId.length > 0, `${label}: receipt.eventId (§8.1)`);
  t.assert(Number.isInteger(receipt.version) && receipt.version >= 1, `${label}: receipt.version is an integer ≥ 1 (§8.1)`);
  t.assert(STATES.includes(receipt.state), `${label}: receipt.state is one of the six states (§8.1)`);
  t.assert(typeof receipt.accountId === 'string' && receipt.accountId.length > 0, `${label}: receipt.accountId (§8.1)`);
  t.assert(receipt.facts && typeof receipt.facts === 'object' && !Array.isArray(receipt.facts), `${label}: receipt.facts is an object (§8.1)`);
  t.assert(Array.isArray(receipt.changed), `${label}: receipt.changed is a list (§8.1)`);
  return receipt;
}

export function checkDocument(t, result, label) {
  t.assert(result && result.event && typeof result.event === 'object', `${label}: event_get_protocol returns {event} (§8.1)`);
  t.assert(Array.isArray(result.accounts), `${label}: event_get_protocol returns {accounts} (§8.1)`);
  const event = result.event;
  for (const key of Object.keys(event)) t.assert(DOCUMENT_FIELDS.has(key), `${label}: unexpected member "${key}" in the Event document (§4.2)`);
  t.assert(typeof event.id === 'string' && event.id.length > 0, `${label}: document.id (§4.2)`);
  t.assert(Number.isInteger(event.version) && event.version >= 1, `${label}: document.version (§4.2)`);
  t.assert(typeof event.createdAt === 'string' && typeof event.updatedAt === 'string', `${label}: createdAt and updatedAt (§4.2)`);
  t.assert(STATES.includes(event.state), `${label}: document.state is one of the six states (§4.3)`);
  t.assert(Array.isArray(event.parents), `${label}: document.parents is a list, empty when none (§4.2)`);
  for (const account of result.accounts) {
    for (const key of Object.keys(account)) t.assert(ACCOUNT_FIELDS.has(key), `${label}: unexpected member "${key}" in an Account (§4.4)`);
  }
  return event;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** Compares two strings by Unicode code points: negative, zero or positive. */
function compareText(a, b) {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index].codePointAt(0) - right[index].codePointAt(0);
    if (difference) return difference;
  }
  return left.length - right.length;
}

/** A timestamp as a string that sorts by instant, whatever the number of fraction digits. */
function instant(timestamp) {
  const match = /^(.*?)(?:\.(\d+))?Z$/.exec(timestamp ?? '');
  const whole = match ? Date.parse(`${match[1]}Z`) : Number.NaN;
  if (Number.isNaN(whole)) return `invalid ${timestamp}`;
  return `${String(whole).padStart(16, '0')}.${(match[2] ?? '').padEnd(9, '0').slice(0, 9)}`;
}

/** Reads the export and checks the outline of §8.6 before a test looks inside it. */
export async function exportRepository(t) {
  const snapshot = await t.call('repository_export', {});
  t.assert(snapshot && Array.isArray(snapshot.events), 'an export holds {events} (§8.6)');
  for (const item of snapshot.events) {
    t.assert(item && item.event && typeof item.event.id === 'string' && Array.isArray(item.accounts) && Array.isArray(item.revisions),
      'each item of events is {event, accounts, revisions} (§8.6)');
  }
  for (const item of snapshot.entities ?? []) {
    t.assert(item && item.entity && typeof item.entity.id === 'string' && Array.isArray(item.accounts) && Array.isArray(item.statements) && Array.isArray(item.revisions),
      'each item of entities is {entity, accounts, statements, revisions} (§8.6)');
  }
  return snapshot;
}

async function directory(t, args = {}) {
  const result = await t.call('context_pack', args);
  t.assert(Array.isArray(result.events), 'context_pack returns {events} (§8.1)');
  return result;
}

async function fullDirectory(t, args = {}) {
  const events = [];
  let cursor;
  for (let page = 0; page < 1000; page += 1) {
    const result = await directory(t, { ...args, ...(cursor ? { cursor } : {}) });
    events.push(...result.events);
    if (!result.next) return events;
    cursor = result.next;
  }
  throw new Error('context_pack never ended its pages');
}

export default [
  {
    id: 'mcp.tools', level: 'core', ref: '§9.1', title: 'The core operations are listed as MCP tools',
    async run(t) {
      const missing = CORE_TOOLS.filter((name) => !t.tools.has(name));
      t.assert(missing.length === 0, `not listed: ${missing.join(', ')}`);
    },
  },
  {
    id: 'mcp.annotations', level: 'core', ref: '§9.1', title: 'Reads carry readOnlyHint; removing a parent and undo carry destructiveHint',
    async run(t) {
      for (const tool of t.toolList) {
        if (READ_TOOLS.includes(tool.name)) t.assert(tool.annotations?.readOnlyHint === true, `${tool.name}: readOnlyHint should be true`);
        if (['event_remove_parent', 'event_undo_revision'].includes(tool.name)) {
          t.assert(tool.annotations?.destructiveHint === true, `${tool.name}: destructiveHint should be true`);
        }
      }
    },
  },
  {
    id: 'core.note.creates', level: 'core', ref: '§3.1', title: 'One Account is enough for an Event; it starts emerging, with no optional fields',
    async run(t) {
      const text = t.unique('Thinking about street photography');
      const receipt = checkReceipt(t, await t.note(text), 'event_note');
      const result = await t.read(receipt.eventId);
      const event = checkDocument(t, result, 'event_get_protocol');
      t.equal(event.id, receipt.eventId, 'the document id');
      t.equal(event.state, 'emerging', 'the initial state (§4.3)');
      t.equal(event.parents, [], 'parents of a new Event');
      t.equal(event.version, receipt.version, 'the document version equals the receipt version');
      for (const key of ['title', 'progress', 'facts', 'refs', 'metadata']) t.assert(!(key in event), `"${key}" must be absent until set (§4.2)`);
      t.equal(result.accounts.map((account) => account.text), [text], 'the Accounts');
    },
  },
  {
    id: 'core.receipt', level: 'core', ref: '§8.1', title: 'A write answers with a receipt: id, version, state, Account, facts, changes',
    async run(t) {
      const receipt = checkReceipt(t, await t.note(t.unique('Receipt check')), 'event_note');
      t.assert(receipt.changed.includes('created') && receipt.changed.includes('account'), `a new Event reports "created" and "account", got ${JSON.stringify(receipt.changed)}`);
      t.equal(receipt.facts, {}, 'facts of a new Event');
      t.assert(!('title' in receipt), 'title is absent from the receipt until set');
      t.assert(receipt.accountReused === undefined || receipt.accountReused === false, 'accountReused is not true for new words');
      const titled = checkReceipt(t, await t.note(t.unique('Titled receipt'), { title: t.unique('Titled') }), 'event_note with title');
      t.assert(typeof titled.title === 'string' && titled.changed.includes('title'), 'a title given on creation is in the receipt and in changed');
    },
  },
  {
    id: 'core.words.verbatim', level: 'core', ref: '§3.2', title: 'Words are kept as given, only trimmed',
    async run(t) {
      const inner = `Two  spaces, 标点！ émoji 🙂 and a\nline break ${t.unique('verbatim')}`;
      const receipt = await t.note(`  \n ${inner} \t `);
      const { accounts } = await t.read(receipt.eventId);
      t.equal(accounts.length, 1, 'one Account');
      t.equal(accounts[0].text, inner, 'the stored text');
      t.equal(accounts[0].source, 'user', 'the source');
      t.equal(accounts[0].actor, t.actor, 'the actor');
      t.equal(accounts[0].eventId, receipt.eventId, 'the Account belongs to the Event');
      t.assert(typeof accounts[0].createdAt === 'string', 'createdAt');
    },
  },
  {
    id: 'core.words.sources', level: 'core', ref: '§4.4', title: 'An Account keeps its source and where it came from',
    async run(t) {
      const event = await t.newEvent('Sources');
      await t.note('Inferred: starts in Lisbon (basis: Alex lives there)', { eventId: event.id, accountSource: 'agent_response' });
      await t.note('Imported from another app', { eventId: event.id, accountSource: 'authorized_external', via: 'example-export' });
      const { accounts } = await t.read(event.id, { accounts: 'all' });
      t.equal(accounts.map((account) => account.source), ['user', 'agent_response', 'authorized_external'], 'sources in order');
      t.equal(accounts[2].via, 'example-export', 'via');
      await t.fails('VALIDATION_ERROR', () => t.note('x', { eventId: event.id, accountSource: 'someone' }), 'an unknown source');
      await t.fails('VALIDATION_ERROR', () => t.note('x', { eventId: event.id, via: '  ' }), 'a blank via (§4.1)');
      const { version } = (await t.read(event.id)).event;
      await t.call('event_record_expression', { eventId: event.id, actor: t.actor, text: t.unique('No source given'), expectedVersion: version });
      t.equal((await t.read(event.id, { accounts: 'all' })).accounts.at(-1).source, 'user', 'accountSource is user when omitted (§8)');
    },
  },
  {
    id: 'core.actor', level: 'core', ref: '§4.1', title: 'An actor is kept as written; an unknown kind or a blank id is rejected',
    async run(t) {
      const actor = { kind: 'agent', id: t.actor.id, label: 'Conformance tests' };
      const receipt = await t.call('event_note', { actor, accountSource: 'user', text: t.unique('Labelled writer') });
      t.equal((await t.read(receipt.eventId)).accounts[0].actor, actor, 'the actor with its label');
      for (const [label, bad] of [
        ['an unknown kind', { kind: 'robot', id: t.actor.id }], ['a blank id', { kind: 'agent', id: '  ' }], ['no id', { kind: 'agent' }],
        ['a blank label', { kind: 'agent', id: t.actor.id, label: ' ' }],
      ]) {
        await t.fails('VALIDATION_ERROR', () => t.call('event_note', { actor: bad, accountSource: 'user', text: t.unique('x') }), label);
      }
    },
  },
  {
    id: 'core.note.title', level: 'core', ref: '§8.1', title: 'event_note sets a title on creation, or later only when there is none',
    async run(t) {
      const titled = await t.note(t.unique('Titled'), { title: 'Lisbon trip, spring 2027' });
      await t.note(t.unique('more words'), { eventId: titled.eventId, title: 'Something else' });
      t.equal((await t.read(titled.eventId)).event.title, 'Lisbon trip, spring 2027', 'an existing title is kept');
      const untitled = await t.newEvent('Untitled');
      const receipt = await t.note(t.unique('naming words'), { eventId: untitled.id, title: 'Moving house, autumn 2026' });
      t.equal((await t.read(untitled.id)).event.title, 'Moving house, autumn 2026', 'a title is set when there is none');
      t.assert(receipt.changed.includes('title'), 'changed reports the title');
    },
  },
  {
    id: 'core.title.rules', level: 'core', ref: '§4.2', title: 'A title is 1 to 80 characters, counted as code points, and not blank',
    async run(t) {
      const event = await t.newEvent('Title rules');
      const longest = '🙂'.repeat(80);
      const receipt = await t.record(event.id, event.version, t.unique('An 80-character title'), { title: longest });
      t.equal((await t.read(event.id)).event.title, longest, 'an 80-character title, whatever its UTF-16 length');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, receipt.version, 'x', { title: 'a'.repeat(81) }), 'an 81-character title');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, receipt.version, 'x', { title: '   ' }), 'a blank title');
      await t.fails('VALIDATION_ERROR', () => t.note(t.unique('x'), { title: 'a'.repeat(81) }), 'an 81-character title on a new Event');
    },
  },
  {
    id: 'core.note.parent', level: 'core', ref: '§8.1', title: 'event_note can start an Event under a parent, which keeps its version',
    async run(t) {
      const parent = await t.newEvent('Parent');
      const child = await t.note(t.unique('Child'), { title: t.unique('Child'), parentEventId: parent.id });
      t.assert(child.changed.includes('parent'), `changed reports the parent, got ${JSON.stringify(child.changed)}`);
      t.equal((await t.read(child.eventId)).event.parents, [parent.id], 'the new Event is under the parent');
      t.equal((await t.read(parent.id)).event.version, parent.version, "the parent's version is unchanged (§4.7)");
      t.equal((await t.revisions(child.eventId)).map((revision) => revision.type), ['event.created', 'account.added', 'parent.added', 'field.changed'],
        'the Revisions of one call, in commit order (§4.8)');
      t.equal(child.changed, ['created', 'account', 'parent', 'title'], 'changed, in commit order');
    },
  },
  {
    id: 'core.note.errors', level: 'core', ref: '§8.1', title: 'event_note rejects eventId with parentEventId, and unknown ids, creating nothing',
    async run(t) {
      const event = await t.newEvent('Note errors');
      const before = (await fullDirectory(t)).length;
      await t.fails('VALIDATION_ERROR', () => t.note('x', { eventId: event.id, parentEventId: event.id }), 'eventId with parentEventId');
      await t.fails('NOT_FOUND', () => t.note(t.unique('orphan'), { parentEventId: 'evt_does_not_exist_0000' }), 'an unknown parent');
      await t.fails('NOT_FOUND', () => t.note('x', { eventId: 'evt_does_not_exist_0000' }), 'an unknown eventId');
      t.equal((await fullDirectory(t)).length, before, 'no Event was created (§5.1)');
    },
  },
  {
    id: 'core.unknown.members', level: 'core', ref: '§4.2', title: 'Unknown members are rejected, not dropped',
    async run(t) {
      const event = await t.newEvent('Unknown members');
      await t.fails('VALIDATION_ERROR', () => t.note('x', { eventId: event.id, colour: 'blue' }), 'an unknown input member');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, 'x', { colour: 'blue' }), 'an unknown field in set');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, 'x', { progress: { text: 'ok', timestamp: '2026-03-14T09:30:00.000Z', source: 'self_report' } }), 'an unknown member inside progress');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, 'x', { refs: [{ criteria: 'the old town', role: 'about' }] }), 'an unknown member inside a ref');
      await t.fails('VALIDATION_ERROR', () => t.note('x', { eventId: event.id, via: null }), 'null for an optional input (§8)');
      t.equal((await t.read(event.id)).event.version, event.version, 'nothing changed');
    },
  },
  {
    id: 'core.progress', level: 'core', ref: '§4.2', title: 'progress needs a text; its timestamp is kept as written, or set by the server',
    async run(t) {
      const event = await t.newEvent('Progress');
      for (const [label, progress] of [
        ['progress without a text', { timestamp: '2026-03-14T09:30:00.000Z' }],
        ['a blank progress text', { text: '  ', timestamp: '2026-03-14T09:30:00.000Z' }],
        ['a timestamp that is not a date-time', { text: 'Halfway', timestamp: 'last Tuesday' }],
      ]) {
        await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, 'x', { progress }), label);
      }
      const given = { text: 'Halfway', timestamp: '2026-03-14T09:30:00Z' };
      const receipt = await t.record(event.id, event.version, t.unique('Halfway there'), { progress: given });
      t.equal((await t.read(event.id)).event.progress, given, 'progress, its timestamp as written');
      const before = (await t.read(event.id)).event.updatedAt;
      await t.record(event.id, receipt.version, t.unique('Nearly done'), { progress: { text: 'Nearly done' } });
      const after = (await t.read(event.id)).event;
      t.equal(after.progress?.text, 'Nearly done', 'progress without a timestamp');
      const set = instant(after.progress?.timestamp);
      t.assert(!set.startsWith('invalid') && set >= instant(before) && set <= instant(after.updatedAt),
        `the server sets the time of the write, got ${after.progress?.timestamp}`);
    },
  },
  {
    id: 'core.set.fields', level: 'core', ref: '§8.1', title: 'event_record_expression writes every field of the document',
    async run(t) {
      const event = await t.newEvent('All fields');
      const set = {
        title: 'Learn street photography',
        state: 'active',
        progress: { text: 'First photo walk done', timestamp: '2026-03-21T18:02:11.000Z' },
        facts: { goal: 'Get good at street photography.', constraint: 'Only at weekends.', plan: 'Saturday-morning walks.' },
        refs: [{ criteria: 'the old town' }],
        metadata: { 'dev.example/source': 'conformance' },
      };
      const receipt = checkReceipt(t, await t.record(event.id, event.version, t.unique('All fields words'), set), 'event_record_expression');
      for (const label of ['account', 'title', 'state', 'progress', 'facts.goal', 'facts.constraint', 'facts.plan', 'refs', 'metadata']) {
        t.assert(receipt.changed.includes(label), `changed should include "${label}", got ${JSON.stringify(receipt.changed)}`);
      }
      t.equal(receipt.facts, set.facts, 'facts in the receipt');
      t.equal(receipt.title, set.title, 'title in the receipt');
      t.equal(receipt.state, 'active', 'state in the receipt');
      const document = checkDocument(t, await t.read(event.id), 'after the write');
      for (const key of Object.keys(set)) t.equal(document[key], set[key], `document.${key}`);
      t.equal(document.version, receipt.version, 'the receipt version is the current version');
    },
  },
  {
    id: 'core.set.facts', level: 'core', ref: '§5.3', title: 'Each supplied fact replaces that fact only; null removes it',
    async run(t) {
      let event = await t.newEvent('Facts per key');
      let receipt = await t.record(event.id, event.version, t.unique('goal words'), { facts: { goal: 'A' } });
      receipt = await t.record(event.id, receipt.version, t.unique('plan words'), { facts: { plan: 'B' } });
      t.equal((await t.read(event.id)).event.facts, { goal: 'A', plan: 'B' }, 'both facts');
      receipt = await t.record(event.id, receipt.version, t.unique('drop goal'), { facts: { goal: null } });
      t.equal((await t.read(event.id)).event.facts, { plan: 'B' }, 'goal removed, plan kept');
      t.equal(receipt.facts, { plan: 'B' }, 'the receipt shows the current facts');
      receipt = await t.record(event.id, receipt.version, t.unique('drop plan'), { facts: { plan: null } });
      t.assert(!('facts' in (await t.read(event.id)).event), 'with no facts left, "facts" is absent');
      receipt = await t.record(event.id, receipt.version, t.unique('two facts'), { facts: { goal: 'C', constraint: 'D' } });
      receipt = await t.record(event.id, receipt.version, t.unique('drop all'), { facts: null });
      t.equal(receipt.changed.filter((label) => label.startsWith('facts.')), ['facts.goal', 'facts.constraint'], 'facts: null removes every fact, one Revision each');
      t.assert(!('facts' in (await t.read(event.id)).event), 'no facts left');
    },
  },
  {
    id: 'core.set.replace', level: 'core', ref: '§5.3', title: 'A field is replaced as a whole; null removes it',
    async run(t) {
      const event = await t.newEvent('Whole fields');
      let receipt = await t.record(event.id, event.version, t.unique('refs one'), {
        title: 'First title', refs: [{ criteria: 'the old town' }, { criteria: 'my sister' }],
        progress: { text: 'Started', timestamp: '2026-03-14T09:30:00.000Z' },
      });
      receipt = await t.record(event.id, receipt.version, t.unique('refs two'), {
        refs: [{ criteria: 'the harbour' }], progress: { text: 'Halfway', timestamp: '2026-03-15T09:30:00.000Z' },
      });
      let document = (await t.read(event.id)).event;
      t.equal(document.refs, [{ criteria: 'the harbour' }], 'refs replaced as a whole');
      t.equal(document.progress, { text: 'Halfway', timestamp: '2026-03-15T09:30:00.000Z' }, 'progress replaced');
      receipt = await t.record(event.id, receipt.version, t.unique('remove'), { title: null, progress: null, refs: null });
      document = (await t.read(event.id)).event;
      for (const key of ['title', 'progress', 'refs']) t.assert(!(key in document), `"${key}" removed by null`);
      receipt = await t.record(event.id, receipt.version, t.unique('refs and metadata'), { refs: [{ criteria: 'the pier' }], metadata: { 'dev.example/a': 1 } });
      await t.record(event.id, receipt.version, t.unique('empty them'), { refs: [], metadata: {} });
      document = (await t.read(event.id)).event;
      for (const key of ['refs', 'metadata']) t.assert(!(key in document), `an empty "${key}" removes it`);
    },
  },
  {
    id: 'core.set.unchanged', level: 'core', ref: '§5.2', title: 'Writing the stored value again changes nothing',
    async run(t) {
      const event = await t.newEvent('No-op');
      const first = await t.record(event.id, event.version, t.unique('set title'), { title: 'Same title' });
      const { accounts } = await t.read(event.id, { accounts: 'all' });
      const last = accounts[accounts.length - 1];
      const again = await t.record(event.id, first.version, last.text, { title: 'Same title' }, { accountId: last.id });
      t.equal(again.version, first.version, 'the version is unchanged');
      t.equal(again.changed, [], 'changed is empty');
    },
  },
  {
    id: 'core.facts.rules', level: 'core', ref: '§4.5', title: 'Only goal, constraint and plan, each a non-blank string',
    async run(t) {
      const event = await t.newEvent('Fact rules');
      for (const [label, facts] of [
        ['another key', { budget: 'under 5,000' }],
        ['a blank value', { goal: '   ' }],
        ['an object', { goal: { text: 'x' } }],
        ['a list', { plan: ['a', 'b'] }],
        ['a number', { constraint: 5000 }],
      ]) {
        await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, 'x', { facts }), label);
      }
    },
  },
  {
    id: 'core.refs.shape', level: 'core', ref: '§4.6', title: 'A ref has exactly one of criteria and ref, and a ref names an existing Entity',
    async run(t) {
      const event = await t.newEvent('Ref shapes');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, 'x', { refs: [{ criteria: 'a', ref: 'ent_0000' }] }), 'both members');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, 'x', { refs: [{}] }), 'neither member');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, 'x', { refs: [{ ref: 'ent_does_not_exist_0000' }] }),
        t.levels.has('entities') ? 'a ref to an Entity that does not exist' : 'a ref on a server without the Entities level');
    },
  },
  {
    id: 'core.states', level: 'core', ref: '§4.3', title: 'Six states; a closed Event can be reopened; other values are rejected',
    async run(t) {
      const event = await t.newEvent('States');
      let version = event.version;
      for (const state of ['active', 'waiting', 'dormant', 'done', 'active', 'cancelled', 'emerging']) {
        const receipt = await t.record(event.id, version, t.unique(`to ${state}`), { state });
        t.equal(receipt.state, state, `receipt state after setting ${state}`);
        t.equal((await t.read(event.id)).event.state, state, `document state after setting ${state}`);
        version = receipt.version;
      }
      for (const state of ['fulfilled', 'closed', 'blocked', '', null]) {
        await t.fails('VALIDATION_ERROR', () => t.record(event.id, version, 'x', { state }), `state ${JSON.stringify(state)}`);
      }
    },
  },
  {
    id: 'core.atomic', level: 'core', ref: '§5.1', title: 'A rejected call leaves no Account and no Revision',
    async run(t) {
      const event = await t.newEvent('Atomic');
      const before = await t.revisions(event.id);
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, t.unique('words that must not stay'), { title: 'ok', facts: { budget: 'x' } }), 'a write with one bad part');
      const after = await t.read(event.id, { accounts: 'all' });
      t.equal(after.accounts.length, 1, 'no Account was added');
      t.equal((await t.revisions(event.id)).length, before.length, 'no Revision was added');
      t.assert(!('title' in after.event), 'the valid part was not applied either');
    },
  },
  {
    id: 'core.version.conflict', level: 'core', ref: '§5.2', title: 'A stale expectedVersion fails with VERSION_CONFLICT and changes nothing',
    async run(t) {
      const event = await t.newEvent('Conflict');
      const moved = await t.record(event.id, event.version, t.unique('first writer'), { title: 'First' });
      await t.fails('VERSION_CONFLICT', () => t.record(event.id, event.version, t.unique('second writer'), { title: 'Second' }), 'the second writer');
      const after = await t.read(event.id, { accounts: 'all' });
      t.equal(after.event.title, 'First', 'the first write stands');
      t.equal(after.event.version, moved.version, 'the version is unchanged');
      t.equal(after.accounts.length, 2, "the second writer's words were not added");
      const words = after.accounts.at(-1);
      await t.fails('VERSION_CONFLICT', () => t.record(event.id, event.version, words.text, { title: 'First' }, { accountId: words.id }),
        'a stale expectedVersion on a call that would change nothing');
    },
  },
  {
    id: 'core.version.repository', level: 'core', ref: '§5.2', title: 'The repository version is not accepted as expectedVersion',
    async run(t) {
      const event = await t.newEvent('Repository version');
      const { version } = await directory(t);
      t.assert(typeof version === 'string' && version.length > 0, 'the repository version is a string');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, version, 'x', { title: 'x' }), 'the repository version as expectedVersion');
    },
  },
  {
    id: 'core.concurrent', level: 'core', ref: '§5.1', title: 'Writes are serialised: of two on the same version one wins, and no words are lost',
    async run(t) {
      const event = await t.newEvent('Concurrent');
      const race = await Promise.allSettled(['First', 'Second'].map((title) => t.record(event.id, event.version, t.unique(`${title} writer`), { title })));
      const won = race.filter((outcome) => outcome.status === 'fulfilled');
      const lost = race.filter((outcome) => outcome.status === 'rejected');
      t.equal(won.length, 1, 'writes that succeed out of two sent at once on the same version');
      const reason = lost[0]?.reason;
      t.assert(reason instanceof ToolError && reason.code === 'VERSION_CONFLICT', `the other fails with VERSION_CONFLICT, got ${reason?.message}`);
      const notes = await Promise.all([1, 2, 3, 4, 5].map((n) => t.note(t.unique(`parallel words ${n}`), { eventId: event.id })));
      const after = await t.read(event.id, { accounts: 'all' });
      t.equal(after.accounts.length, 2 + notes.length, 'every Account of the writes that succeeded is kept');
      t.equal(after.event.title, won[0].value.title, "the winner's title stands");
      t.equal(after.event.version, (await t.revisions(event.id)).length, 'the version still counts the Revisions');
    },
  },
  {
    id: 'core.revisions.versions', level: 'core', ref: '§4.8', title: 'One Revision per change; the version counts them',
    async run(t) {
      const event = await t.newEvent('Versions');
      let receipt = await t.record(event.id, event.version, t.unique('two fields'), { title: 'T', state: 'active' });
      receipt = await t.record(event.id, receipt.version, t.unique('one fact'), { facts: { goal: 'G' } });
      const revisions = await t.revisions(event.id);
      t.equal(revisions.length, receipt.version, 'the version equals the number of Revisions');
      revisions.forEach((revision, index) => {
        t.equal(revision.baseVersion, index, `Revision ${index + 1}: baseVersion`);
        t.equal(revision.newVersion, index + 1, `Revision ${index + 1}: newVersion`);
        t.equal(revision.targetEventId, event.id, `Revision ${index + 1}: targetEventId`);
      });
      t.equal(revisions.map((revision) => revision.type), ['event.created', 'account.added', 'account.added', 'field.changed', 'field.changed', 'account.added', 'field.changed'], 'types in commit order');
      t.equal(new Set(revisions.map((revision) => revision.id)).size, revisions.length, 'Revision ids are unique');
    },
  },
  {
    id: 'core.revisions.payloads', level: 'core', ref: '§4.8', title: 'Revisions name the writer, the Accounts and what changed',
    async run(t) {
      const event = await t.newEvent('Payloads');
      const first = await t.record(event.id, event.version, t.unique('name it'), { title: 'Before' });
      await t.record(event.id, first.version, t.unique('rename it'), { title: 'After' });
      const revisions = await t.revisions(event.id);
      const created = revisions[0];
      t.equal(created.type, 'event.created', 'the first Revision');
      t.equal(created.payload, {}, 'event.created payload');
      t.equal(created.sourceAccountIds, [], 'event.created rests on no Account');
      const added = revisions[1];
      t.equal(added.type, 'account.added', 'the second Revision');
      t.equal(added.payload, { accountId: event.accountId }, 'account.added payload');
      t.equal(added.sourceAccountIds, [event.accountId], 'account.added rests on its Account');
      const titles = revisions.filter((revision) => revision.type === 'field.changed');
      t.equal(titles.map((revision) => revision.payload), [
        { field: 'title', before: null, after: 'Before' },
        { field: 'title', before: 'Before', after: 'After' },
      ], 'field.changed payloads');
      t.equal(titles[0].sourceAccountIds, [first.accountId], 'a field change rests on the words of its call');
      for (const revision of revisions) {
        t.equal(revision.actor, t.actor, `${revision.type}: actor`);
        t.assert(typeof revision.occurredAt === 'string', `${revision.type}: occurredAt`);
      }
    },
  },
  {
    id: 'core.account.grounding', level: 'core', ref: '§8.1', title: 'accountId grounds changes on existing words, which must be quoted exactly',
    async run(t) {
      const event = await t.newEvent('Grounding');
      const other = await t.newEvent('Other');
      const { accounts } = await t.read(event.id);
      const words = accounts[0];
      const receipt = await t.record(event.id, event.version, words.text, { facts: { goal: 'Folded in later' } }, { accountId: words.id });
      t.equal((await t.read(event.id, { accounts: 'all' })).accounts.length, 1, 'no Account was added');
      const change = (await t.revisions(event.id)).at(-1);
      t.equal(change.sourceAccountIds, [words.id], 'the change rests on the existing Account');
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, receipt.version, `${words.text} (edited)`, { title: 'x' }, { accountId: words.id }), 'text that differs from the Account');
      // Quoted exactly, so that the only fault is whose words they are.
      const theirs = (await t.read(other.id)).accounts[0];
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, receipt.version, theirs.text, { title: 'x' }, { accountId: theirs.id }), "another Event's Account");
      await t.fails('VALIDATION_ERROR', () => t.record(event.id, receipt.version, words.text, { title: 'x' }, { accountId: 'acc_does_not_exist_0000' }), 'an Account that does not exist');
      t.equal((await t.read(event.id)).event.version, receipt.version, 'the rejected writes changed nothing');
    },
  },
  {
    id: 'core.parents.add', level: 'core', ref: '§4.7', title: 'A parent link changes the child only; adding it twice changes nothing; several parents are allowed',
    async run(t) {
      const child = await t.newEvent('Child');
      const parent = await t.newEvent('Parent');
      const second = await t.newEvent('Second parent');
      const linked = await t.call('event_add_parent', { childEventId: child.id, parentEventId: parent.id, actor: t.actor, sourceAccountIds: [child.accountId], expectedVersion: child.version });
      t.equal(linked.eventId, child.id, 'the result names the child');
      t.equal(linked.version, child.version + 1, "the child's version goes up by one");
      t.equal(linked.parents, [parent.id], 'the parents');
      t.equal((await t.read(parent.id)).event.version, parent.version, "the parent's version is unchanged");
      const again = await t.call('event_add_parent', { childEventId: child.id, parentEventId: parent.id, actor: t.actor, sourceAccountIds: [child.accountId], expectedVersion: linked.version });
      t.equal(again.version, linked.version, 'adding an existing link changes nothing');
      const both = await t.call('event_add_parent', { childEventId: child.id, parentEventId: second.id, actor: t.actor, sourceAccountIds: [second.accountId], expectedVersion: again.version });
      t.assert(sameSet(both.parents, [parent.id, second.id]), `two parents, got ${JSON.stringify(both.parents)}`);
      t.assert(sameSet((await t.read(child.id)).event.parents, [parent.id, second.id]), 'the document lists both parents');
      const added = (await t.revisions(child.id)).filter((revision) => revision.type === 'parent.added').map((revision) => revision.payload);
      t.equal(added, [{ parentEventId: parent.id }, { parentEventId: second.id }], 'parent.added payloads');
    },
  },
  {
    id: 'core.parents.cycle', level: 'core', ref: '§4.7', title: 'Parent links never form a cycle',
    async run(t) {
      const a = await t.newEvent('Cycle A');
      const b = await t.newEvent('Cycle B');
      const c = await t.newEvent('Cycle C');
      const link = (child, parent, expectedVersion) => t.call('event_add_parent', { childEventId: child.id, parentEventId: parent.id, actor: t.actor, sourceAccountIds: [child.accountId], expectedVersion });
      await t.fails('PART_OF_CYCLE', () => link(a, a, a.version), 'an Event under itself');
      const ab = await link(a, b, a.version);
      await link(b, c, b.version);
      await t.fails('PART_OF_CYCLE', () => link(c, a, c.version), 'a link that closes A → B → C → A');
      t.equal((await t.read(a.id)).event.version, ab.version, 'nothing changed');
    },
  },
  {
    id: 'core.parents.remove', level: 'core', ref: '§4.7', title: 'Removing a link works once; removing a missing link fails with NOT_FOUND',
    async run(t) {
      const child = await t.newEvent('Remove child');
      const parent = await t.newEvent('Remove parent');
      const linked = await t.call('event_add_parent', { childEventId: child.id, parentEventId: parent.id, actor: t.actor, sourceAccountIds: [child.accountId], expectedVersion: child.version });
      const removed = await t.call('event_remove_parent', { childEventId: child.id, parentEventId: parent.id, actor: t.actor, sourceAccountIds: [child.accountId], expectedVersion: linked.version });
      t.equal(removed.parents, [], 'no parents left');
      t.equal(removed.version, linked.version + 1, 'the version goes up by one');
      t.equal((await t.revisions(child.id)).at(-1).payload, { parentEventId: parent.id }, 'parent.removed payload');
      await t.fails('NOT_FOUND', () => t.call('event_remove_parent', { childEventId: child.id, parentEventId: parent.id, actor: t.actor, sourceAccountIds: [child.accountId], expectedVersion: removed.version }), 'removing it again');
    },
  },
  {
    id: 'core.parents.grounding', level: 'core', ref: '§4.7', title: "A link rests on an Account of the child or the parent",
    async run(t) {
      const child = await t.newEvent('Grounded child');
      const parent = await t.newEvent('Grounded parent');
      const stranger = await t.newEvent('Stranger');
      const link = (sourceAccountIds, expectedVersion) => t.call('event_add_parent', { childEventId: child.id, parentEventId: parent.id, actor: t.actor, sourceAccountIds, expectedVersion });
      await t.fails('VALIDATION_ERROR', () => link([], child.version), 'no Account');
      await t.fails('VALIDATION_ERROR', () => link([stranger.accountId], child.version), 'an Account of another Event');
      const linked = await link([parent.accountId], child.version);
      t.equal(linked.parents, [parent.id], "an Account of the parent grounds the link");
      t.equal((await t.revisions(child.id)).at(-1).sourceAccountIds, [parent.accountId], 'the Revision names that Account');
    },
  },
  {
    id: 'core.no.reorganising', level: 'core', ref: '§3.5', title: 'Two Events with the same words stay two',
    async run(t) {
      const text = t.unique('Repaint the kitchen');
      const first = await t.note(text);
      const second = await t.note(text);
      t.assert(first.eventId !== second.eventId, 'two Events');
      const entries = await fullDirectory(t);
      for (const id of [first.eventId, second.eventId]) {
        const entry = entries.find((candidate) => candidate.id === id);
        t.assert(entry, `${id} is in the directory`);
        t.equal(entry.parents, [], `${id} was not linked by the server`);
      }
    },
  },
  {
    id: 'core.read.accounts', level: 'core', ref: '§8.1', title: 'Reading an Event returns its 20 most recent Accounts, oldest first, or all',
    async run(t) {
      const event = await t.newEvent('Many words');
      const texts = [(await t.read(event.id)).accounts[0].text];
      for (let index = 2; index <= 22; index += 1) {
        const text = t.unique(`words ${index}`);
        texts.push(text);
        await t.note(text, { eventId: event.id });
      }
      t.equal((await t.read(event.id)).accounts.map((account) => account.text), texts.slice(-20), 'the default 20');
      t.equal((await t.read(event.id, { accounts: 'all' })).accounts.map((account) => account.text), texts, 'all');
      t.equal((await t.read(event.id, { accounts: 3 })).accounts.map((account) => account.text), texts.slice(-3), 'the last 3');
    },
  },
  {
    id: 'core.directory.shape', level: 'core', ref: '§8.1', title: 'The directory lists every Event in brief, most recently updated first',
    async run(t) {
      const event = await t.newEvent('Directory entry');
      await t.record(event.id, event.version, t.unique('directory words'), { title: 'Directory entry', progress: { text: 'Started', timestamp: '2026-03-14T09:30:00.000Z' } });
      const result = await directory(t);
      t.equal(result.protocolVersion, 'draft-0.2', 'protocolVersion (§11)');
      t.assert(typeof result.version === 'string' && result.version.length > 0, 'the repository version');
      const entries = await fullDirectory(t);
      for (const entry of entries) {
        for (const key of Object.keys(entry)) t.assert(ENTRY_FIELDS.has(key), `unexpected member "${key}" in a directory entry`);
        t.assert(typeof entry.id === 'string' && STATES.includes(entry.state) && Array.isArray(entry.parents) && typeof entry.updatedAt === 'string', `entry ${entry.id}: id, state, parents, updatedAt`);
      }
      for (let index = 1; index < entries.length; index += 1) {
        const [newer, older] = [entries[index - 1], entries[index]];
        const order = compareText(instant(newer.updatedAt), instant(older.updatedAt)) || compareText(newer.id, older.id);
        t.assert(order > 0, `entries are ordered by updatedAt, newest first, then by id in descending code-point order: ${newer.id} before ${older.id}`);
      }
      const mine = entries.find((entry) => entry.id === event.id);
      t.equal(mine.title, 'Directory entry', 'title in the entry');
      t.equal(mine.progress, { text: 'Started', timestamp: '2026-03-14T09:30:00.000Z' }, 'progress in the entry');
    },
  },
  {
    id: 'core.directory.version', level: 'core', ref: '§5.2', title: 'The repository version changes with every write, and answers "unchanged" when current',
    async run(t) {
      const before = (await directory(t)).version;
      await t.newEvent('Version bump');
      const after = await directory(t);
      t.assert(after.version !== before, 'a write changes the repository version');
      const same = await t.call('context_pack', { sinceVersion: after.version });
      t.equal(same.unchanged, true, 'unchanged when sinceVersion is current');
      const stale = await t.call('context_pack', { sinceVersion: before });
      t.assert(Array.isArray(stale.events), 'the full directory when sinceVersion is stale');
    },
  },
  {
    id: 'core.directory.state', level: 'core', ref: '§8.1', title: 'The directory filters by state, open or closed',
    async run(t) {
      const open = await t.newEvent('Open one');
      const done = await t.newEvent('Done one');
      await t.record(done.id, done.version, t.unique('finished'), { state: 'done' });
      const ids = async (state) => (await fullDirectory(t, { state })).map((entry) => entry.id);
      const closedIds = await ids('closed');
      const openIds = await ids('open');
      const doneIds = await ids('done');
      t.assert(closedIds.includes(done.id) && !closedIds.includes(open.id), 'closed');
      t.assert(openIds.includes(open.id) && !openIds.includes(done.id), 'open');
      t.assert(doneIds.includes(done.id) && !doneIds.includes(open.id), 'done');
    },
  },
  {
    id: 'core.directory.paging', level: 'core', ref: '§8.1', title: 'The directory pages with limit and cursor, without gaps or repeats',
    async run(t) {
      for (let index = 0; index < 3; index += 1) await t.newEvent('Paging');
      const all = (await fullDirectory(t)).map((entry) => entry.id);
      const first = await directory(t, { limit: 2 });
      t.assert(first.events.length === 2 && typeof first.next === 'string', 'the first page has two entries and a cursor');
      for (const limit of [0, -1, 1.5]) {
        await t.fails('VALIDATION_ERROR', () => t.call('context_pack', { limit }), `limit ${limit} (§8)`);
      }
      const paged = (await fullDirectory(t, { limit: 2 })).map((entry) => entry.id);
      t.equal(new Set(paged).size, paged.length, 'no entry appears twice');
      t.assert(sameSet(paged, all), 'the pages together list every Event');
    },
  },
  {
    id: 'core.revisions.paging', level: 'core', ref: '§8.1', title: 'History pages with after and limit, in commit order',
    async run(t) {
      const event = await t.newEvent('History pages');
      let receipt = await t.record(event.id, event.version, t.unique('h1'), { title: 'One' });
      receipt = await t.record(event.id, receipt.version, t.unique('h2'), { title: 'Two' });
      const all = await t.revisions(event.id);
      const pages = [];
      let after;
      for (let page = 0; page < 20; page += 1) {
        const result = await t.call('event_get_revisions', { eventId: event.id, limit: 2, ...(after ? { after } : {}) });
        t.assert(result.revisions.length <= 2, 'a page holds at most limit Revisions');
        pages.push(...result.revisions);
        if (!result.next) break;
        after = result.next;
      }
      t.equal(pages.map((revision) => revision.id), all.map((revision) => revision.id), 'the pages together, in order');
    },
  },
  {
    id: 'core.errors', level: 'core', ref: '§5.4', title: 'Unknown ids fail with NOT_FOUND and a message',
    async run(t) {
      const event = await t.newEvent('Errors');
      const error = await t.fails('NOT_FOUND', () => t.read('evt_does_not_exist_0000'), 'reading an unknown Event');
      t.assert(error.serverMessage.trim().length > 0, 'the message is not empty');
      await t.fails('NOT_FOUND', () => t.record('evt_does_not_exist_0000', 1, 'x', { title: 'x' }), 'writing an unknown Event');
      await t.fails('NOT_FOUND', () => t.call('event_add_parent', { childEventId: event.id, parentEventId: 'evt_does_not_exist_0000', actor: t.actor, sourceAccountIds: [event.accountId], expectedVersion: event.version }), 'an unknown parent');
      await t.fails('NOT_FOUND', () => t.call('event_get_revisions', { eventId: 'evt_does_not_exist_0000' }), 'the history of an unknown Event');
    },
  },
  {
    id: 'core.metadata', level: 'core', ref: '§11', title: 'metadata is kept exactly as written',
    async run(t) {
      const event = await t.newEvent('Metadata');
      const metadata = { 'dev.example/flag': true, 'dev.example/nested': { list: [1, 2.5, { deep: null }], text: 'é 🙂' } };
      await t.record(event.id, event.version, t.unique('metadata'), { metadata });
      t.equal((await t.read(event.id)).event.metadata, metadata, 'metadata');
    },
  },
  {
    id: 'core.export.shape', level: 'core', ref: '§8.6', title: 'An export holds every Event with its Accounts and Revisions',
    async run(t) {
      if (!t.tools.has('repository_export')) t.skip('the server offers no repository_export operation; check the export by hand');
      const event = await t.newEvent('Exported');
      const snapshot = await exportRepository(t);
      t.equal(snapshot.schemaVersion, '0.3.0', 'schemaVersion');
      t.equal(snapshot.protocolVersion, 'draft-0.2', 'protocolVersion');
      t.assert(typeof snapshot.exportedAt === 'string' && Array.isArray(snapshot.events), 'exportedAt and events');
      const entries = (await fullDirectory(t)).map((entry) => entry.id);
      t.assert(sameSet(snapshot.events.map((item) => item.event?.id), entries), 'the export holds every Event in the directory');
      for (const item of snapshot.events) {
        t.assert(Array.isArray(item.accounts) && Array.isArray(item.revisions), `${item.event.id}: accounts and revisions`);
        t.equal(item.event.version, item.revisions.length, `${item.event.id}: version equals the number of Revisions`);
        t.assert(item.accounts.every((account) => account.eventId === item.event.id), `${item.event.id}: its Accounts belong to it`);
      }
      t.assert(snapshot.events.some((item) => item.event.id === event.id), 'the new Event is in the export');
    },
  },
  {
    id: 'core.import', level: 'core', ref: '§8.6', title: 'An export imports into an empty repository, and only into an empty one',
    async run(t) {
      if (!t.tools.has('repository_export') || !t.tools.has('repository_import')) t.skip('the server offers no repository_export and repository_import operations');
      const snapshot = await exportRepository(t);
      const fresh = await t.fresh();
      try {
        t.equal(await fresh.call('repository_import', { snapshot }), { imported: true }, 'the import result');
        const original = await fullDirectory(t);
        const copy = await fullDirectory(fresh);
        t.equal(copy, original, 'the imported directory equals the original');
        const sample = original[0].id;
        t.equal((await fresh.read(sample, { accounts: 'all' })), (await t.read(sample, { accounts: 'all' })), 'an imported Event reads the same');
        await t.fails('REPOSITORY_NOT_EMPTY', () => fresh.call('repository_import', { snapshot }), 'importing into a repository that holds data');
      } finally {
        await fresh.close();
      }
    },
  },
  {
    id: 'core.import.invalid', level: 'core', ref: '§8.6', title: 'An invalid export is rejected whole',
    async run(t) {
      if (!t.tools.has('repository_export') || !t.tools.has('repository_import')) t.skip('the server offers no repository_export and repository_import operations');
      const a = await t.newEvent('Import A');
      const b = await t.newEvent('Import B');
      const snapshot = await exportRepository(t);
      const item = (copy, id) => copy.events.find((candidate) => candidate.event.id === id);
      const broken = [
        ['parents that form a cycle', (copy) => {
          item(copy, a.id).event.parents = [b.id];
          item(copy, b.id).event.parents = [a.id];
        }],
        ['a repeated Event', (copy) => copy.events.push(structuredClone(copy.events[0]))],
        ['an Account listed under another Event', (copy) => {
          item(copy, b.id).accounts.push(...item(copy, a.id).accounts.splice(0));
        }],
        ['a version that does not count the Revisions', (copy) => {
          item(copy, a.id).event.version += 1;
        }],
        ['a parent missing from the export', (copy) => {
          item(copy, a.id).event.parents = ['evt_missing_from_export_0000'];
        }],
        ['an Account that shares the id of an Event', (copy) => {
          item(copy, a.id).accounts[0].id = b.id;
        }],
      ];
      if (!t.levels.has('entities')) {
        broken.push(['Entities, on a server without the Entities level', (copy) => {
          copy.entities = [{ entity: { id: 'ent_0001', kind: 'person', name: 'Sam', aliases: [], owner: false, version: 1, createdAt: copy.exportedAt, updatedAt: copy.exportedAt }, accounts: [], statements: [], revisions: [] }];
        }]);
      }
      const fresh = await t.fresh();
      try {
        for (const [label, breakIt] of broken) {
          const copy = structuredClone(snapshot);
          breakIt(copy);
          await t.fails('VALIDATION_ERROR', () => fresh.call('repository_import', { snapshot: copy }), `an export with ${label}`);
        }
        t.equal((await fullDirectory(fresh)).length, 0, 'nothing was imported');
      } finally {
        await fresh.close();
      }
    },
  },
];
