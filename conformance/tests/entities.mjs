// Entities level: Entities and Statements (§6) and their operations (§8.5), with the refs
// that point at them (§4.6) and their place in exports (§8.6).
// The first test needs a repository without an owner, so the order of this list matters.
import { exportRepository } from './core.mjs';

const ENTITY_FIELDS = new Set(['id', 'kind', 'name', 'aliases', 'owner', 'version', 'createdAt', 'updatedAt']);
const STATEMENT_FIELDS = new Set([
  'id', 'entityId', 'text', 'topic', 'evidence', 'basis', 'saidAt', 'validFrom', 'validTo', 'status', 'reason',
  'supersedes', 'conflictsWith', 'sensitivity', 'inSummary', 'actor', 'createdAt', 'updatedAt',
]);
const CARD_FIELDS = new Set(['id', 'kind', 'name', 'aliases', 'owner', 'version', 'statements']);
const REFERENCE_FIELDS = new Set(['id', 'title', 'state']);

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function checkEntity(t, entity, label) {
  t.assert(entity && typeof entity === 'object', `${label}: an Entity (§6.1)`);
  for (const key of Object.keys(entity)) t.assert(ENTITY_FIELDS.has(key), `${label}: unexpected member "${key}" in an Entity (§6.1)`);
  t.assert(typeof entity.id === 'string' && entity.id.length > 0 && entity.id !== 'current_user', `${label}: id (§4.1)`);
  t.assert(typeof entity.kind === 'string' && entity.kind.length > 0, `${label}: kind (§6.1)`);
  t.assert(typeof entity.name === 'string' && entity.name.length > 0, `${label}: name (§6.1)`);
  t.assert(Array.isArray(entity.aliases), `${label}: aliases is a list, empty when there are none (§6.1)`);
  t.assert(typeof entity.owner === 'boolean', `${label}: owner is a boolean (§6.1)`);
  t.assert(Number.isInteger(entity.version) && entity.version >= 1, `${label}: version (§6.1)`);
  t.assert(typeof entity.createdAt === 'string' && typeof entity.updatedAt === 'string', `${label}: createdAt and updatedAt (§6.1)`);
  return entity;
}

function checkStatement(t, statement, label) {
  t.assert(statement && typeof statement === 'object', `${label}: a Statement (§6.2)`);
  for (const key of Object.keys(statement)) t.assert(STATEMENT_FIELDS.has(key), `${label}: unexpected member "${key}" in a Statement (§6.2)`);
  t.assert(typeof statement.id === 'string' && statement.id.length > 0, `${label}: id (§6.2)`);
  t.assert(typeof statement.text === 'string' && typeof statement.topic === 'string', `${label}: text and topic (§6.2)`);
  t.assert(Array.isArray(statement.evidence) && statement.evidence.length >= 1, `${label}: evidence names at least one Entity account (§6.2)`);
  t.assert(['current', 'outdated', 'disputed'].includes(statement.status), `${label}: status (§6.2)`);
  t.assert(['normal', 'private', 'sensitive'].includes(statement.sensitivity), `${label}: sensitivity, normal by default (§6.2)`);
  t.assert(typeof statement.inSummary === 'boolean', `${label}: inSummary, false by default (§6.2)`);
  t.assert(statement.actor && typeof statement.actor.id === 'string', `${label}: actor (§6.2)`);
  return statement;
}

const create = (t, more = {}) => t.call('entity_create', {
  actor: t.actor, kind: 'person', name: t.unique('Someone'), accountText: t.unique('Words about someone'), accountSource: 'user', ...more,
});
async function get(t, entityId, more = {}) {
  const result = await t.call('entity_get', { entityId, ...more });
  const list = more.view === 'summary' ? 'summary' : 'statements';
  t.assert(result && result.entity && typeof result.entity === 'object' && Array.isArray(result[list]),
    `entity_get with view ${more.view ?? 'full'} returns {entity, ${list}} (§8.5)`);
  return result;
}
async function search(t, args = {}) {
  const result = await t.call('entity_search', args);
  t.assert(result && Array.isArray(result.entities), 'entity_search returns {entities} (§8.5)');
  return result.entities;
}
const write = (t, entityId, expectedVersion, text, change, accountSource = 'user') =>
  t.call('entity_record', { entityId, actor: t.actor, text, accountSource, expectedVersion, ...change });
const card = async (t, entityId) => (await search(t)).find((entry) => entry.id === entityId);
const statementsById = (statements) => Object.fromEntries(statements.map((statement) => [statement.id, statement]));

/** The owner Entity, created when the repository has none yet. */
async function owner(t) {
  try {
    return (await get(t, 'current_user')).entity;
  } catch (error) {
    if (error?.code !== 'NOT_FOUND') throw error;
  }
  const created = await create(t, { name: 'Alex', owner: true, accountText: t.unique('I am Alex') });
  return (await get(t, created.entityId)).entity;
}

export default [
  {
    id: 'entities.owner.absent', level: 'entities', ref: '§6.1', title: 'Before an owner exists, current_user fails with NOT_FOUND',
    async run(t) {
      const entities = await search(t);
      if (entities.some((entry) => entry.owner === true)) t.skip('the repository already has an owner');
      await t.fails('NOT_FOUND', () => get(t, 'current_user'), 'entity_get current_user before an owner exists');
    },
  },
  {
    id: 'entities.create', level: 'entities', ref: '§8.5', title: 'entity_create makes an Entity at version 1; its words are the evidence of its Statements',
    async run(t) {
      const name = t.unique('Sam');
      const created = await create(t, { name, accountText: t.unique('My sister Sam is a nurse'), statements: [{ text: 'Works as a nurse.', topic: 'work' }] });
      t.assert(typeof created.entityId === 'string' && created.entityId.length > 0, 'entityId');
      t.equal(created.version, 1, 'the version after creation (§6.1)');
      t.assert(typeof created.accountId === 'string' && created.accountId.length > 0, 'accountId');
      t.assert(Array.isArray(created.added) && created.added.length === 1, 'added lists the Statement created');
      const { entity, statements } = await get(t, created.entityId);
      checkEntity(t, entity, 'entity_get');
      t.equal([entity.name, entity.kind, entity.aliases, entity.owner, entity.version], [name, 'person', [], false, 1], 'name, kind, aliases, owner, version');
      t.equal(statements.length, 1, 'one Statement');
      const statement = checkStatement(t, statements[0], 'the Statement');
      t.equal(statement.id, created.added[0], 'its id is the one in added');
      t.equal(statement.entityId, created.entityId, 'entityId');
      t.equal([statement.text, statement.topic, statement.status], ['Works as a nurse.', 'work', 'current'], 'text, topic, status');
      t.equal(statement.evidence, [created.accountId], 'it rests on the words of its call (§6.1)');
      t.equal([statement.sensitivity, statement.inSummary], ['normal', false], 'the defaults');
      t.equal(statement.actor, t.actor, 'actor');
      const bare = await create(t, { kind: 'place', name: t.unique('The harbour'), accountText: t.unique('We walk at the harbour') });
      t.equal(bare.added, [], 'added is empty without Statements');
    },
  },
  {
    id: 'entities.owner', level: 'entities', ref: '§6.1', title: 'current_user names the one owner; a second owner is rejected',
    async run(t) {
      const mine = await owner(t);
      t.equal(mine.owner, true, 'the owner Entity has owner: true');
      t.equal((await get(t, 'current_user', { view: 'summary' })).entity.id, mine.id, 'current_user names the owner');
      await t.fails('VALIDATION_ERROR', () => create(t, { name: t.unique('Another me'), owner: true }), 'a second owner');
      const entities = await search(t);
      t.equal(entities.filter((entry) => entry.owner === true).map((entry) => entry.id), [mine.id], 'owners listed');
    },
  },
  {
    id: 'entities.kinds', level: 'entities', ref: '§11', title: 'Unknown kinds and topics are kept as written; a blank kind or name is rejected',
    async run(t) {
      const created = await create(t, { kind: 'organisation', name: t.unique('The choir'), statements: [{ text: 'Rehearses on Thursdays.', topic: 'schedule' }] });
      const { entity, statements } = await get(t, created.entityId);
      t.equal(entity.kind, 'organisation', 'the kind as written');
      t.equal(statements.map((statement) => statement.topic), ['schedule'], 'the topic as written');
      await t.fails('VALIDATION_ERROR', () => create(t, { kind: '' }), 'an empty kind');
      await t.fails('VALIDATION_ERROR', () => create(t, { name: '   ' }), 'a blank name');
    },
  },
  {
    id: 'entities.aliases', level: 'entities', ref: '§6.1', title: 'Aliases are trimmed and distinct, never the name, and replaced as a whole',
    async run(t) {
      const name = t.unique('Samuel');
      const created = await create(t, { name, aliases: ['  Sam ', 'Sammy'] });
      t.assert(sameSet((await get(t, created.entityId)).entity.aliases, ['Sam', 'Sammy']), 'aliases are trimmed');
      const other = t.unique('Robert');
      for (const [label, aliases] of [['an alias equal to the name', [other]], ['a blank alias', ['  ']], ['a repeated alias', ['Rob', ' Rob ']]]) {
        await t.fails('VALIDATION_ERROR', () => create(t, { name: other, aliases }), `entity_create with ${label}`);
      }
      await t.fails('VALIDATION_ERROR', () => write(t, created.entityId, created.version, t.unique('his names'), { aliases: ['Sam', name] }), 'entity_record with an alias equal to the name');
      await t.fails('VALIDATION_ERROR', () => write(t, created.entityId, created.version, t.unique('his names'), { aliases: [name.toUpperCase()] }), 'an alias equal to the name, ignoring case');
      await t.fails('VALIDATION_ERROR', () => write(t, created.entityId, created.version, t.unique('his names'), { aliases: ['sammy', 'SAMMY'] }), 'aliases repeated, ignoring case');
      const renamed = await write(t, created.entityId, created.version, t.unique('he goes by Sammy now'), { aliases: ['Sammy'] });
      const { entity } = await get(t, created.entityId);
      t.equal(entity.aliases, ['Sammy'], 'the new list replaces the old one');
      t.equal(entity.version, renamed.version, 'the version');
    },
  },
  {
    id: 'entities.statements.rules', level: 'entities', ref: '§6.2', title: 'Statement text is 1 to 200 characters, times are partial times, and unknown members are rejected',
    async run(t) {
      const created = await create(t);
      const { version } = created;
      const add = (statements, label) => t.fails('VALIDATION_ERROR', () => write(t, created.entityId, version, t.unique('words'), { add: statements }), label);
      await add([{ text: 'a'.repeat(201), topic: 'details' }], 'a text of 201 characters');
      await add([{ text: '', topic: 'details' }], 'an empty text');
      await add([{ text: 'Has no topic.' }], 'a Statement without a topic');
      for (const value of ['next spring', '14/03/2026', '2026-3']) {
        await add([{ text: 'Holds for a while.', topic: 'details', validFrom: value }], `validFrom "${value}"`);
      }
      await add([{ text: 'Is a secret.', topic: 'details', sensitivity: 'secret' }], 'an unknown sensitivity');
      await add([{ text: 'Is certain.', topic: 'details', confidence: 0.9 }], 'an unknown member in a Statement');
      await t.fails('VALIDATION_ERROR', () => write(t, created.entityId, version, t.unique('words'), { add: [{ text: 'Fine.', topic: 'details' }], colour: 'blue' }), 'an unknown member in entity_record');
      await t.fails('VALIDATION_ERROR', () => create(t, { colour: 'blue' }), 'an unknown member in entity_create');
      t.equal((await get(t, created.entityId)).entity.version, version, 'the rejected writes changed nothing');
      const accepted = await write(t, created.entityId, version, t.unique('words that hold'), { add: [
        { text: 'a'.repeat(200), topic: 'details' },
        { text: 'Holds since 2026.', topic: 'details', validFrom: '2026' },
        { text: 'Holds since March 2026.', topic: 'details', validFrom: '2026-03', saidAt: '2026-03-14' },
        { text: 'Was said at a moment.', topic: 'details', saidAt: '2026-03-14T09:30:00.000Z', validTo: '2099-12-31' },
      ] });
      t.equal(accepted.version, version + 1, 'one write, one version');
      t.equal(accepted.added?.length, 4, 'four Statements added');
      const texts = Object.fromEntries((await get(t, created.entityId)).statements.map((statement) => [statement.text, statement]));
      t.equal(texts['Holds since March 2026.']?.validFrom, '2026-03', 'a partial time is kept as written');
      t.equal(texts['Was said at a moment.']?.saidAt, '2026-03-14T09:30:00.000Z', 'a date-time is kept as written');
    },
  },
  {
    id: 'entities.validity', level: 'entities', ref: '§6.2', title: 'A Statement whose validTo has passed reads as outdated',
    async run(t) {
      const year = String(new Date().getUTCFullYear());
      const created = await create(t, { statements: [
        { text: 'Lived in Porto.', topic: 'home', validTo: '2020-01' },
        { text: 'Lives in Lisbon.', topic: 'home', validFrom: '2020-02' },
        { text: 'Rents until the end of the year.', topic: 'home', validTo: year },
      ] });
      const plain = await get(t, created.entityId);
      t.equal(plain.statements.map((statement) => statement.text), ['Lives in Lisbon.', 'Rents until the end of the year.'],
        `statements leaves out what reads as outdated; validTo "${year}" covers the whole year`);
      t.assert(!('history' in plain), 'history comes only with includeHistory');
      const full = await get(t, created.entityId, { includeHistory: true });
      t.equal(full.history?.map((statement) => [statement.text, statement.status]), [['Lived in Porto.', 'outdated']], 'history holds it, as outdated');
      t.equal((await card(t, created.entityId))?.statements, 2, 'the card counts the Statements that do not read as outdated');
    },
  },
  {
    id: 'entities.summary', level: 'entities', ref: '§6.2', title: 'The summary holds the inSummary Statements that read as current, never sensitive ones',
    async run(t) {
      const created = await create(t, { statements: [
        { text: 'Prefers to be called Jo.', topic: 'identity', inSummary: true },
        { text: 'Keeps a diary.', topic: 'habits', inSummary: true, sensitivity: 'private' },
        { text: 'Has a heart condition.', topic: 'health', inSummary: true, sensitivity: 'sensitive' },
        { text: 'Likes figs.', topic: 'food' },
        { text: 'Worked at the bakery.', topic: 'work', inSummary: true, validTo: '2020-01' },
      ] });
      const [jo] = created.added;
      await write(t, created.entityId, created.version, 'Inferred: prefers to be called Joanna (basis: an email signature)', {
        add: [{ text: 'Prefers to be called Joanna.', topic: 'identity', basis: 'an email signature', inSummary: true, conflictsWith: [jo] }],
      }, 'agent_response');
      const result = await get(t, created.entityId, { view: 'summary' });
      checkEntity(t, result.entity, 'the summary view');
      t.assert(Array.isArray(result.summary), 'the summary view returns {entity, summary} (§8.5)');
      result.summary.forEach((statement, index) => checkStatement(t, statement, `summary ${index + 1}`));
      const texts = result.summary.map((statement) => statement.text);
      t.assert(sameSet(texts, ['Prefers to be called Jo.', 'Keeps a diary.']), `the summary leaves out what is sensitive, outdated, disputed or not inSummary, got ${JSON.stringify(texts)}`);
      const flagged = await get(t, created.entityId, { view: 'summary', includeHistory: true, includeEvents: true });
      t.assert(!('history' in flagged) && !('referencedBy' in flagged), 'includeHistory and includeEvents apply to the full view only');
    },
  },
  {
    id: 'entities.full.order', level: 'entities', ref: '§8.5', title: 'The full view orders Statements by topic, then by creation; topics restricts it',
    async run(t) {
      const created = await create(t, { statements: [
        { text: 'Loves dumplings.', topic: 'food' },
        { text: 'Is called Mei.', topic: 'identity' },
        { text: 'Teaches maths.', topic: 'work' },
        { text: 'Also loves noodles.', topic: 'food' },
      ] });
      const { statements } = await get(t, created.entityId);
      t.equal(statements.map((statement) => statement.text), ['Is called Mei.', 'Teaches maths.', 'Loves dumplings.', 'Also loves noodles.'], 'the order');
      const food = await get(t, created.entityId, { topics: ['food'] });
      t.equal(food.statements.map((statement) => statement.text), ['Loves dumplings.', 'Also loves noodles.'], 'only the topics asked for');
    },
  },
  {
    id: 'entities.version', level: 'entities', ref: '§5.2', title: 'Each Entity write adds one to its version; a stale expectedVersion fails with VERSION_CONFLICT',
    async run(t) {
      const created = await create(t);
      const moved = await write(t, created.entityId, created.version, t.unique('She moved to Leeds'), { add: [{ text: 'Lives in Leeds.', topic: 'home' }] });
      t.equal([moved.entityId, moved.version], [created.entityId, 2], 'entityId and version after one write');
      t.assert(typeof moved.accountId === 'string' && moved.accountId !== created.accountId, 'each write has its own Entity account');
      await t.fails('VERSION_CONFLICT', () => write(t, created.entityId, created.version, t.unique('stale'), { add: [{ text: 'Lives in York.', topic: 'home' }] }), 'a stale expectedVersion');
      await t.fails('VALIDATION_ERROR', () => write(t, created.entityId, moved.version, t.unique('nothing to change'), {}), 'a write with none of name, aliases, add, update and support');
      await t.fails('VALIDATION_ERROR', () => write(t, created.entityId, moved.version, t.unique('nothing to change'), { add: [], update: [], support: [] }), 'a write with only empty lists');
      const name = t.unique('Lou');
      const renamed = await write(t, created.entityId, moved.version, t.unique('Her name is Lou'), { name });
      t.equal(renamed.version, 3, 'a rename is one write');
      const { entity, statements } = await get(t, created.entityId);
      t.equal([entity.version, entity.name], [3, name], 'the Entity version and its new name');
      t.assert(!statements.some((statement) => statement.text === 'Lives in York.'), 'the stale write added nothing');
      await t.fails('NOT_FOUND', () => write(t, 'ent_does_not_exist_0000', 1, 'x', { name: 'x' }), 'writing an unknown Entity');
      await t.fails('NOT_FOUND', () => get(t, 'ent_does_not_exist_0000'), 'reading an unknown Entity');
    },
  },
  {
    id: 'entities.evidence', level: 'entities', ref: '§6.2', title: "A write's words are the evidence of what it adds and supports, within one Entity",
    async run(t) {
      const created = await create(t, { statements: [{ text: 'Plays the cello.', topic: 'interests' }] });
      const other = await create(t, { statements: [{ text: 'Plays the drums.', topic: 'interests' }] });
      const [cello] = created.added;
      const [drums] = other.added;
      const supported = await write(t, created.entityId, created.version, t.unique('She played the cello at the wedding'), {
        support: [cello], add: [{ text: 'Played at a wedding in May 2026.', topic: 'details' }],
      });
      t.equal(supported.supported, [cello], 'supported lists the Statement');
      const statements = statementsById((await get(t, created.entityId)).statements);
      t.assert(sameSet(statements[cello].evidence, [created.accountId, supported.accountId]), 'the supported Statement gains the new words as evidence');
      t.equal(statements[supported.added[0]]?.evidence, [supported.accountId], 'a new Statement rests on the words of its call');
      await t.fails('VALIDATION_ERROR', () => write(t, created.entityId, supported.version, t.unique('x'), { support: [drums] }), "supporting another Entity's Statement");
      await t.fails('VALIDATION_ERROR', () => write(t, created.entityId, supported.version, t.unique('x'), { update: [{ statementId: drums, inSummary: true }] }), "updating another Entity's Statement");
      await t.fails('VALIDATION_ERROR', () => write(t, created.entityId, supported.version, t.unique('x'), { add: [{ text: 'Replaces drums.', topic: 'interests', supersedes: [drums] }] }), "superseding another Entity's Statement");
    },
  },
  {
    id: 'entities.protected', level: 'entities', ref: '§6.3', title: "Only the user's own words can supersede or re-status what rests on them",
    async run(t) {
      const created = await create(t, { statements: [{ text: 'Is vegetarian.', topic: 'food' }] });
      const [vegetarian] = created.added;
      await t.fails('USER_WORDS_PROTECTED', () => write(t, created.entityId, created.version, 'Inferred: eats fish (basis: ordered salmon)', {
        add: [{ text: 'Eats fish.', topic: 'food', basis: 'ordered salmon', supersedes: [vegetarian] }],
      }, 'agent_response'), 'an agent superseding it');
      await t.fails('USER_WORDS_PROTECTED', () => write(t, created.entityId, created.version, 'This no longer seems to hold.', {
        update: [{ statementId: vegetarian, status: 'outdated' }],
      }, 'agent_response'), 'an agent marking it outdated');
      await t.fails('USER_WORDS_PROTECTED', () => write(t, created.entityId, created.version, 'Relayed: now eats fish', {
        add: [{ text: 'Eats fish.', topic: 'food', supersedes: [vegetarian] }],
      }, 'authorized_external'), 'words relayed from another application superseding it');
      const after = await get(t, created.entityId);
      t.equal(after.entity.version, created.version, 'the refused writes changed nothing');
      t.equal(statementsById(after.statements)[vegetarian]?.status, 'current', 'it is still current');
      const replaced = await write(t, created.entityId, created.version, t.unique('I eat fish now'), {
        add: [{ text: 'Eats fish since 2026.', topic: 'food', supersedes: [vegetarian] }],
      });
      const full = await get(t, created.entityId, { includeHistory: true });
      t.equal(full.history?.find((statement) => statement.id === vegetarian)?.status, 'outdated', "the user's own words can supersede it");
      const [fish] = replaced.added;
      t.equal(statementsById(full.statements)[fish]?.status, 'current', 'the new Statement is current');
      await write(t, created.entityId, replaced.version, t.unique('Actually that is not true any more'), {
        update: [{ statementId: fish, status: 'outdated', reason: 'No longer holds.' }],
      });
      const history = (await get(t, created.entityId, { includeHistory: true })).history ?? [];
      t.equal(history.find((statement) => statement.id === fish)?.status, 'outdated', "the user's own words can change its status");
    },
  },
  {
    id: 'entities.conflicts', level: 'entities', ref: '§6.3', title: 'A contradicting Statement is disputed and linked back; only unprotected ones it names become disputed',
    async run(t) {
      const created = await create(t, { statements: [{ text: 'Lives in Madrid.', topic: 'home' }] });
      const [madrid] = created.added;
      const inferred = await write(t, created.entityId, created.version, 'Inferred: works in Seville (basis: an invoice)', {
        add: [{ text: 'Works in Seville.', topic: 'work', basis: 'an invoice' }],
      }, 'agent_response');
      const [seville] = inferred.added;
      const first = await write(t, created.entityId, inferred.version, 'Inferred: lives in Valencia (basis: a delivery address)', {
        add: [{ text: 'Lives in Valencia.', topic: 'home', basis: 'a delivery address', conflictsWith: [madrid] }],
      }, 'agent_response');
      const second = await write(t, created.entityId, first.version, 'Inferred: works from home (basis: calendar)', {
        add: [{ text: 'Works from home.', topic: 'work', basis: 'calendar', conflictsWith: [seville] }],
      }, 'agent_response');
      const expired = await write(t, created.entityId, second.version, 'Inferred: had a studio (basis: an old lease)', {
        add: [{ text: 'Had a studio in Toledo.', topic: 'work', basis: 'an old lease', validTo: '2020-01' }],
      }, 'agent_response');
      await write(t, created.entityId, expired.version, 'Inferred: never had a studio (basis: tax records)', {
        add: [{ text: 'Never had a studio.', topic: 'work', basis: 'tax records', conflictsWith: [expired.added[0]] }],
      }, 'agent_response');
      const history = (await get(t, created.entityId, { includeHistory: true })).history ?? [];
      t.equal(history.find((statement) => statement.id === expired.added[0])?.status, 'outdated', 'a named Statement that reads as outdated is not disputed');
      const statements = statementsById((await get(t, created.entityId)).statements);
      const valencia = statements[first.added[0]];
      t.equal(valencia?.status, 'disputed', 'a Statement added with conflictsWith is disputed');
      t.equal(valencia?.conflictsWith, [madrid], 'its conflictsWith');
      t.equal(valencia?.basis, 'a delivery address', 'its basis');
      t.assert(statements[madrid]?.conflictsWith?.includes(first.added[0]), 'the named Statement links back');
      t.equal(statements[madrid]?.status, 'current', "a Statement resting on the user's words stays current");
      t.equal(statements[seville]?.status, 'disputed', 'a current Statement that does not rest on them becomes disputed');
      t.assert(statements[seville]?.conflictsWith?.includes(second.added[0]), 'and links back');
    },
  },
  {
    id: 'entities.confirmation', level: 'entities', ref: '§6.3', title: "Making a disputed Statement current again needs the user's words",
    async run(t) {
      const created = await create(t);
      const inferred = await write(t, created.entityId, created.version, 'Inferred: has a cat (basis: cat food orders)', {
        add: [{ text: 'Has a cat.', topic: 'family', basis: 'cat food orders' }],
      }, 'agent_response');
      const [cat] = inferred.added;
      const disputing = await write(t, created.entityId, inferred.version, 'Inferred: has no pets (basis: a rental form)', {
        add: [{ text: 'Has no pets.', topic: 'family', basis: 'a rental form', conflictsWith: [cat] }],
      }, 'agent_response');
      await t.fails('USER_CONFIRMATION_REQUIRED', () => write(t, created.entityId, disputing.version, 'Restoring this.', {
        update: [{ statementId: cat, status: 'current' }],
      }, 'agent_response'), 'an agent making it current');
      const confirmed = await write(t, created.entityId, disputing.version, t.unique('Yes, I have a cat'), {
        update: [{ statementId: cat, status: 'current', reason: 'Confirmed in conversation.' }],
      });
      t.equal(confirmed.changed, [cat], 'changed lists the Statement');
      const statement = statementsById((await get(t, created.entityId)).statements)[cat];
      t.equal([statement?.status, statement?.reason], ['current', 'Confirmed in conversation.'], 'it is current again, with the reason');
      // The user's own words can be disputed too: added with conflictsWith, they rest on the user and still need the user.
      const own = await write(t, created.entityId, confirmed.version, t.unique('Actually we have two cats'), {
        add: [{ text: 'Has two cats.', topic: 'family', conflictsWith: [cat] }],
      });
      await t.fails('USER_CONFIRMATION_REQUIRED', () => write(t, created.entityId, own.version, 'Restoring this.', {
        update: [{ statementId: own.added[0], status: 'current' }],
      }, 'agent_response'), "an agent making a disputed Statement current that rests on the user's words");
    },
  },
  {
    id: 'entities.supersedes', level: 'entities', ref: '§6.3', title: 'supersedes marks the replaced Statements outdated',
    async run(t) {
      const created = await create(t);
      const old = await write(t, created.entityId, created.version, 'Inferred: drives a Golf (basis: a parking receipt)', {
        add: [{ text: 'Drives a Golf.', topic: 'details', basis: 'a parking receipt' }],
      }, 'agent_response');
      const [golf] = old.added;
      const replaced = await write(t, created.entityId, old.version, 'Inferred: drives an electric car now (basis: charging receipts)', {
        add: [{ text: 'Drives an electric car.', topic: 'details', basis: 'charging receipts', supersedes: [golf] }],
      }, 'agent_response');
      const full = await get(t, created.entityId, { includeHistory: true });
      t.equal(full.history?.find((statement) => statement.id === golf)?.status, 'outdated', 'the replaced Statement is outdated');
      t.equal(statementsById(full.statements)[replaced.added[0]]?.supersedes, [golf], 'the new one names what it replaces');
      t.equal((await card(t, created.entityId))?.statements, 1, 'the card no longer counts the replaced one');
    },
  },
  {
    id: 'entities.refs', level: 'entities', ref: '§4.6', title: 'Events refer to Entities by id, never to the owner; reads name the Entities both ways',
    async run(t) {
      const me = await owner(t);
      const sam = await create(t, { name: t.unique('Sam') });
      const event = await t.newEvent('Trip with Sam');
      for (const [label, ref] of [['the owner', me.id], ['current_user', 'current_user'], ['an Entity that does not exist', 'ent_does_not_exist_0000']]) {
        await t.fails('VALIDATION_ERROR', () => t.record(event.id, event.version, 'x', { refs: [{ ref }] }), `a ref to ${label}`);
      }
      const title = t.unique('Coast trip with Sam');
      await t.record(event.id, event.version, t.unique('Sam is coming too'), { title, state: 'active', refs: [{ ref: sam.entityId }, { criteria: 'the coast' }] });
      const read = await t.read(event.id);
      t.equal(read.event.refs, [{ ref: sam.entityId }, { criteria: 'the coast' }], 'the refs');
      const entity = (await get(t, sam.entityId)).entity;
      t.equal(read.entities, [{ id: entity.id, kind: entity.kind, name: entity.name }], 'event_get_protocol names the Entities its refs name (§8.1)');
      const { referencedBy } = await get(t, sam.entityId, { includeEvents: true });
      t.assert(Array.isArray(referencedBy), 'includeEvents returns referencedBy (§8.5)');
      for (const entry of referencedBy) for (const key of Object.keys(entry)) t.assert(REFERENCE_FIELDS.has(key), `unexpected member "${key}" in referencedBy`);
      t.equal(referencedBy.find((entry) => entry.id === event.id), { id: event.id, title, state: 'active' }, 'the Event that names it');
      t.assert(!('entities' in (await t.read((await t.newEvent('No Entity refs')).id))), 'entities appears only when refs name Entities');
    },
  },
  {
    id: 'entities.search', level: 'entities', ref: '§8.5', title: 'entity_search finds Entities by name or alias ignoring case, filters by kind, and lists every Entity',
    async run(t) {
      const name = t.unique('Biscuit');
      const alias = t.unique('Bix');
      const dog = await create(t, { kind: 'animal', name, aliases: [alias], accountText: t.unique('Our dog Biscuit'), statements: [{ text: 'A beagle.', topic: 'identity' }] });
      const ids = async (args) => (await search(t, args)).map((entry) => entry.id);
      t.assert((await ids({ query: alias.toUpperCase() })).includes(dog.entityId), 'found by alias, ignoring case');
      t.assert((await ids({ query: name.toLowerCase() })).includes(dog.entityId), 'found by name, ignoring case');
      t.assert((await ids({ query: name, kind: 'animal' })).includes(dog.entityId), 'found within its kind');
      t.assert(!(await ids({ query: name, kind: 'place' })).includes(dog.entityId), 'kind filters it out');
      const animals = await search(t, { kind: 'animal' });
      t.assert(animals.length > 0 && animals.every((entry) => entry.kind === 'animal'), 'kind alone lists that kind');
      const all = await search(t);
      for (const entry of all) {
        for (const key of Object.keys(entry)) t.assert(CARD_FIELDS.has(key), `unexpected member "${key}" in a card`);
        t.assert(typeof entry.id === 'string' && typeof entry.name === 'string' && Number.isInteger(entry.version) && Number.isInteger(entry.statements),
          `card ${entry.id}: id, name, version and the count of Statements`);
      }
      const mine = all.find((entry) => entry.id === dog.entityId);
      t.assert(mine, 'without a query every Entity is listed');
      t.equal([mine.kind, mine.name, mine.version, mine.statements], ['animal', name, 1, 1], 'the card');
      for (const suffix of ['junior', 'the second']) await create(t, { kind: 'animal', name: `${name} ${suffix}` });
      t.equal(await ids({ query: name, limit: 1 }), [dog.entityId], 'an exact match is not crowded out by limit');
    },
  },
  {
    id: 'entities.export', level: 'entities', ref: '§8.6', title: 'An export holds every Entity, with one account and one revision per write',
    async run(t) {
      if (!t.tools.has('repository_export')) t.skip('the server offers no repository_export operation; check the export by hand');
      const words = t.unique('My aunt collects stamps');
      const created = await create(t, { accountText: `  ${words} \n`, statements: [{ text: 'Collects stamps.', topic: 'interests' }] });
      await write(t, created.entityId, created.version, t.unique('She still collects stamps'), { support: created.added });
      const snapshot = await exportRepository(t);
      t.assert(Array.isArray(snapshot.entities), 'the export lists entities');
      const listed = (await search(t)).map((entry) => entry.id);
      t.assert(sameSet(snapshot.entities.map((item) => item.entity?.id), listed), 'the export holds every Entity');
      for (const item of snapshot.entities) {
        const id = item.entity.id;
        t.assert(Array.isArray(item.accounts) && Array.isArray(item.statements) && Array.isArray(item.revisions), `${id}: accounts, statements and revisions`);
        t.equal(item.accounts.length, item.entity.version, `${id}: one Entity account per write`);
        t.equal(item.revisions.map((revision) => revision.type),
          ['entity.created', ...Array(item.entity.version - 1).fill('entity.recorded')], `${id}: one Entity revision per write`);
        t.assert(item.accounts.every((account) => account.entityId === id), `${id}: its accounts belong to it`);
        const own = new Set(item.accounts.map((account) => account.id));
        t.assert(item.statements.every((statement) => statement.entityId === id && statement.evidence.every((account) => own.has(account))),
          `${id}: its Statements rest on its own accounts`);
      }
      const mine = snapshot.entities.find((item) => item.entity.id === created.entityId);
      t.equal(mine.revisions.map((revision) => [revision.targetEntityId, revision.baseVersion, revision.newVersion]),
        [[created.entityId, 0, 1], [created.entityId, 1, 2]], 'targetEntityId, baseVersion and newVersion');
      t.equal(mine.revisions.map((revision) => revision.sourceAccountIds), mine.accounts.map((account) => [account.id]), 'each revision names its Entity account');
      t.equal(mine.accounts[0].text, words, 'Entity account text is trimmed (§4.1)');
      t.equal(mine.accounts[0].source, 'user', 'its source');
    },
  },
  {
    id: 'entities.import', level: 'entities', ref: '§8.6', title: 'Entities, Statements and the owner survive an export and import',
    async run(t) {
      if (!t.tools.has('repository_export') || !t.tools.has('repository_import')) t.skip('the server offers no repository_export and repository_import operations');
      const snapshot = await exportRepository(t);
      const fresh = await t.fresh();
      try {
        t.equal(await fresh.call('repository_import', { snapshot }), { imported: true }, 'the import result');
        const cards = async (context) => (await search(context)).sort(byId);
        const original = await cards(t);
        t.equal(await cards(fresh), original, 'the same Entities');
        for (const entry of original) {
          const args = { entityId: entry.id, includeHistory: true, includeEvents: true };
          t.equal(await fresh.call('entity_get', args), await t.call('entity_get', args), `${entry.id} reads the same`);
        }
        const ownerId = original.find((entry) => entry.owner === true)?.id;
        if (ownerId) t.equal((await fresh.call('entity_get', { entityId: 'current_user' })).entity.id, ownerId, 'current_user names the same owner');
      } finally {
        await fresh.close();
      }
      const onlyEntities = await t.fresh();
      try {
        await create(onlyEntities, { kind: 'place', name: 'The allotment' });
        await t.fails('REPOSITORY_NOT_EMPTY', () => onlyEntities.call('repository_import', { snapshot }), 'importing into a repository that holds only an Entity');
      } finally {
        await onlyEntities.close();
      }
    },
  },
  {
    id: 'entities.import.invalid', level: 'entities', ref: '§8.6', title: 'An export with two owners, a stray Statement or a dangling ref is rejected whole',
    async run(t) {
      if (!t.tools.has('repository_export') || !t.tools.has('repository_import')) t.skip('the server offers no repository_export and repository_import operations');
      const me = await owner(t);
      const first = await create(t, { statements: [{ text: 'Grows tomatoes.', topic: 'interests' }, { text: 'Grows beans.', topic: 'interests' }] });
      const second = await create(t, { statements: [{ text: 'Keeps bees.', topic: 'interests' }] });
      // A rename leaves an Entity account that no Statement rests on, so that moving it breaks one rule only.
      await write(t, second.entityId, second.version, t.unique('She goes by another name now'), { name: t.unique('Renamed') });
      const event = await t.newEvent('Import refs');
      const snapshot = await exportRepository(t);
      const entity = (copy, id) => copy.entities.find((item) => item.entity.id === id);
      const eventItem = (copy) => copy.events.find((item) => item.event.id === event.id);
      const broken = [
        ['two owners', (copy) => { entity(copy, second.entityId).entity.owner = true; }],
        ["a Statement resting on another Entity's account", (copy) => {
          entity(copy, first.entityId).statements[0].evidence = [entity(copy, second.entityId).accounts[0].id];
        }],
        ['a ref to an Entity missing from the export', (copy) => { eventItem(copy).event.refs = [{ ref: 'ent_missing_from_export_0000' }]; }],
        ['a ref to the owner', (copy) => { eventItem(copy).event.refs = [{ ref: me.id }]; }],
        ['a repeated Statement id', (copy) => {
          const statements = entity(copy, first.entityId).statements;
          statements[1].id = statements[0].id;
        }],
        ['an Entity account listed under another Entity', (copy) => {
          entity(copy, first.entityId).accounts.push(...entity(copy, second.entityId).accounts.splice(1, 1));
        }],
        ['an Entity version that does not count its revisions', (copy) => { entity(copy, second.entityId).entity.version += 1; }],
        ["conflictsWith naming another Entity's Statement", (copy) => {
          entity(copy, first.entityId).statements[0].conflictsWith = [entity(copy, second.entityId).statements[0].id];
        }],
      ];
      const fresh = await t.fresh();
      try {
        for (const [label, breakIt] of broken) {
          const copy = structuredClone(snapshot);
          breakIt(copy);
          await t.fails('VALIDATION_ERROR', () => fresh.call('repository_import', { snapshot: copy }), `an export with ${label}`);
        }
        t.equal(await search(fresh), [], 'no Entity was imported');
        t.equal((await fresh.call('context_pack', {})).events, [], 'no Event was imported');
      } finally {
        await fresh.close();
      }
    },
  },
];
