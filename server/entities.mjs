// Entities level of Protocol Chaos draft 0.2 (§6, §8.5): Entities with their
// Entity accounts and Entity revisions, and Statements. Each write validates
// its input, then works on copies, and commits in one step (§5.1).
//
// State kept on the repository:
//   repo.entities        id -> { doc, accounts: [], statementIds: [], revisions: [] }
//   repo.entityAccounts  id -> Entity account
//   repo.statements      id -> Statement (stored status)
//   repo.entityRevisions id -> Entity revision
//   repo.ownerId         the owner Entity's id, or undefined

import {
  OWNER_ID, SENSITIVITIES, STATUSES, TOPICS,
  checkMembers, ci, compareCodePoints, compareTime, fail, fold, has, invalid, isPlainObject,
  parseActor, parseAliases, parseBoolean, parseCount, parseEnum, parseExpectedVersion, parseIdList, parseKind, parseName,
  parseNewStatement, parsePartialTime, parseSource, parseStatementText, parseText, parseTimestamp, parseTopic, parseUpdate,
  parseVia, partialTimeEnd, requireString, sameValue,
} from './validate.mjs';

const clone = (v) => structuredClone(v);

const STATEMENT_ORDER = ['id', 'entityId', 'text', 'topic', 'evidence', 'basis', 'saidAt', 'validFrom', 'validTo', 'status',
  'reason', 'supersedes', 'conflictsWith', 'sensitivity', 'inSummary', 'actor', 'createdAt', 'updatedAt'];
const ENTITY_ORDER = ['id', 'kind', 'name', 'aliases', 'owner', 'version', 'createdAt', 'updatedAt'];
const ACCOUNT_ORDER = ['id', 'entityId', 'text', 'source', 'via', 'actor', 'createdAt'];

const ordered = (obj, order) => {
  const out = {};
  for (const key of order) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
};

// ---- reading ----

// A current Statement whose validTo has passed reads as outdated (§6.2).
export function readStatus(stmt, nowMs) {
  if (stmt.status === 'current' && stmt.validTo !== undefined && nowMs >= partialTimeEnd(stmt.validTo)) return 'outdated';
  return stmt.status;
}

const renderStatement = (stmt, nowMs) => ({ ...ordered(clone(stmt), STATEMENT_ORDER), status: readStatus(stmt, nowMs) });
export const renderEntity = (doc) => ordered(clone(doc), ENTITY_ORDER);

// Statements ordered by topic in the order of §6.2 (other topics after them,
// by code point), then by creation.
function sortStatements(list) {
  const rank = (t) => {
    const i = TOPICS.indexOf(t);
    return i < 0 ? TOPICS.length : i;
  };
  return list
    .map((s, i) => [s, i])
    .sort(([a, i], [b, j]) => rank(a.topic) - rank(b.topic)
      || (rank(a.topic) === TOPICS.length ? compareCodePoints(a.topic, b.topic) : 0)
      || compareTime(a.createdAt, b.createdAt)
      || i - j)
    .map(([s]) => s);
}

const recency = (a, b) => compareTime(b.doc.updatedAt, a.doc.updatedAt) || compareCodePoints(b.doc.id, a.doc.id);

function statementsOf(repo, rec) {
  return rec.statementIds.map((id) => repo.statements.get(id));
}

function card(repo, rec, nowMs) {
  const { doc } = rec;
  const out = { id: doc.id, kind: doc.kind, name: doc.name };
  if (doc.aliases.length > 0) out.aliases = [...doc.aliases];
  if (doc.owner) out.owner = true;
  out.version = doc.version;
  out.statements = statementsOf(repo, rec).filter((s) => readStatus(s, nowMs) !== 'outdated').length;
  return out;
}

// "Saying the same thing again" (§6.2): for the topic accounts the texts are
// compared as written; for other topics ignoring case, punctuation and
// differences in white space.
function sameThingKey(text, topic) {
  if (topic === 'accounts') return text;
  return fold(text).replace(/\p{P}+/gu, '').replace(/\s+/gu, ' ').trim();
}

export function resolveEntity(repo, value, where = 'entityId') {
  const id = requireString(value, where);
  if (id === OWNER_ID) {
    if (repo.ownerId === undefined) {
      fail('NOT_FOUND', `${where} "current_user" names the owner's own Entity, but none exists yet. Create it with entity_create and owner: true.`);
    }
    return repo.entities.get(repo.ownerId);
  }
  const rec = repo.entities.get(id);
  if (!rec) fail('NOT_FOUND', `${where} ${JSON.stringify(id)} names no Entity. Find Entities with entity_search.`);
  return rec;
}

// ---- entity_search (§8.5) ----
// Best matches first:
//   0 the name equals the query, 1 an alias equals it (ignoring case): the
//     Entities §8.5 requires, so they always rank first;
//   2 the name or an alias starts with it, 3 contains it;
//   4 a Statement that is not sensitive contains it;
//   5 every whitespace-separated word of the query appears in those texts.
// Ties, and the list without a query, are most recently updated first.
export function entitySearch(repo, input) {
  checkMembers(input, ['query', 'kind', 'limit'], 'entity_search input');
  let query;
  if (has(input, 'query')) {
    if (typeof input.query !== 'string' || input.query.trim() === '') {
      invalid('query, when given, must be a non-blank string such as a name; omit it to list every Entity.');
    }
    query = input.query;
  }
  const kind = has(input, 'kind') ? parseKind(input.kind) : undefined;
  const limit = has(input, 'limit') ? parseCount(input.limit, 'limit', 1) : undefined;
  const nowMs = Date.now();
  const candidates = [...repo.entities.values()].filter((rec) => kind === undefined || rec.doc.kind === kind);
  let hits;
  if (query === undefined) {
    hits = candidates.sort(recency);
  } else {
    const trimmed = query.trim();
    const words = trimmed.split(/\s+/u);
    const scored = [];
    for (const rec of candidates) {
      const tier = searchTier(repo, rec, query, trimmed, words);
      if (tier !== undefined) scored.push({ rec, tier });
    }
    scored.sort((a, b) => a.tier - b.tier || recency(a.rec, b.rec));
    hits = scored.map(({ rec }) => rec);
  }
  if (limit !== undefined) hits = hits.slice(0, limit);
  return { entities: hits.map((rec) => card(repo, rec, nowMs)) };
}

function searchTier(repo, rec, query, trimmed, words) {
  const { name, aliases } = rec.doc;
  const eq = (s) => ci.equals(s, query) || ci.equals(s.trim(), trimmed);
  if (eq(name)) return 0;
  if (aliases.some(eq)) return 1;
  const names = [name, ...aliases];
  if (names.some((s) => ci.startsWith(s.trim(), trimmed))) return 2;
  if (names.some((s) => ci.includes(s, trimmed))) return 3;
  const texts = statementsOf(repo, rec).filter((s) => s.sensitivity !== 'sensitive').map((s) => s.text);
  if (texts.some((t) => ci.includes(t, trimmed))) return 4;
  const all = [...names, ...texts];
  if (words.length > 1 && words.every((w) => all.some((t) => ci.includes(t, w)))) return 5;
  return undefined;
}

// ---- entity_get (§8.5) ----
export function entityGet(repo, input) {
  checkMembers(input, ['entityId', 'view', 'topics', 'includeHistory', 'includeEvents'], 'entity_get input');
  if (!has(input, 'entityId')) invalid('entityId is required: an Entity id, or "current_user" for the owner.');
  requireString(input.entityId, 'entityId');
  let view = 'full';
  if (has(input, 'view')) view = parseEnum(input.view, ['summary', 'full'], 'view');
  let topics;
  if (has(input, 'topics')) {
    if (!Array.isArray(input.topics) || input.topics.length === 0) {
      invalid('topics, when given, must list at least one topic, such as ["work", "family"]; omit it for every topic.');
    }
    topics = input.topics.map((t, i) => parseTopic(t, `topics[${i}]`));
  }
  const includeHistory = has(input, 'includeHistory') ? parseBoolean(input.includeHistory, 'includeHistory') : false;
  const includeEvents = has(input, 'includeEvents') ? parseBoolean(input.includeEvents, 'includeEvents') : false;
  const rec = resolveEntity(repo, input.entityId);
  const nowMs = Date.now();
  let list = sortStatements(statementsOf(repo, rec));
  if (topics !== undefined) list = list.filter((s) => topics.includes(s.topic));
  const out = { entity: renderEntity(rec.doc) };
  if (view === 'summary') {
    out.summary = list
      .filter((s) => s.inSummary && readStatus(s, nowMs) === 'current' && s.sensitivity !== 'sensitive')
      .map((s) => renderStatement(s, nowMs));
  } else {
    out.statements = list.filter((s) => readStatus(s, nowMs) !== 'outdated').map((s) => renderStatement(s, nowMs));
  }
  // §8.5: includeHistory and includeEvents apply to the full view only.
  if (view !== 'summary' && includeHistory) out.history = list.filter((s) => readStatus(s, nowMs) === 'outdated').map((s) => renderStatement(s, nowMs));
  if (view !== 'summary' && includeEvents) out.referencedBy = repo.referencingEvents(rec.doc.id);
  return out;
}

// ---- writes ----

function makeAccount(repo, entityId, { text, source, via, actor }, time) {
  return ordered({ id: repo.newId('acc'), entityId, text, source, via, actor: clone(actor), createdAt: time }, ACCOUNT_ORDER);
}

function makeStatement(repo, entityId, s, accountId, actor, time, status = 'current') {
  return ordered({
    id: repo.newId('stm'),
    entityId,
    text: s.text,
    topic: s.topic,
    evidence: [accountId],
    basis: s.basis,
    saidAt: s.saidAt,
    validFrom: s.validFrom,
    validTo: s.validTo,
    status,
    supersedes: s.supersedes?.length ? [...s.supersedes] : undefined,
    conflictsWith: s.conflictsWith?.length ? [...s.conflictsWith] : undefined,
    sensitivity: s.sensitivity ?? 'normal',
    inSummary: s.inSummary ?? false,
    actor: clone(actor),
    createdAt: time,
    updatedAt: time,
  }, STATEMENT_ORDER);
}

function parseWords(input, textKey) {
  return {
    actor: parseActor(input.actor),
    text: parseText(input[textKey], textKey),
    source: has(input, 'accountSource') ? parseSource(input.accountSource) : 'user',
    via: has(input, 'via') ? parseVia(input.via) : undefined,
  };
}

// ---- entity_create (§8.5) ----
export function entityCreate(repo, input) {
  checkMembers(input, ['actor', 'kind', 'name', 'accountText', 'accountSource', 'via', 'aliases', 'owner', 'statements'], 'entity_create input');
  const words = parseWords(input, 'accountText');
  const kind = parseKind(input.kind);
  const name = parseName(input.name);
  const aliases = has(input, 'aliases') ? parseAliases(input.aliases, name) : [];
  const owner = has(input, 'owner') ? parseBoolean(input.owner, 'owner') : false;
  let statements = [];
  if (has(input, 'statements')) {
    if (!Array.isArray(input.statements)) invalid('statements, when given, must be an array of new Statements {text, topic, ...}.');
    statements = input.statements.map((s, i) => parseNewStatement(s, `statements[${i}]`, false));
  }
  if (owner && repo.ownerId !== undefined) {
    invalid(`The owner's Entity already exists (${repo.ownerId}); at most one Entity is the owner. Read it with entity_get and entityId "current_user", and add to it with entity_record.`);
  }
  const time = repo.now();
  const id = repo.newId('ent');
  const account = makeAccount(repo, id, words, time);
  const created = [];
  for (const s of statements) {
    const key = sameThingKey(s.text, s.topic);
    if (created.some((c) => c.topic === s.topic && sameThingKey(c.text, c.topic) === key)) continue; // the same thing twice
    created.push(makeStatement(repo, id, s, account.id, words.actor, time));
  }
  const doc = { id, kind, name, aliases, owner, version: 1, createdAt: time, updatedAt: time };
  const revision = {
    id: repo.newId('rev'), targetEntityId: id, type: 'entity.created',
    payload: { kind, name, aliases: [...aliases], owner, added: created.map((s) => s.id) },
    actor: clone(words.actor), sourceAccountIds: [account.id], occurredAt: time, baseVersion: 0, newVersion: 1,
  };
  // commit
  repo.entities.set(id, { doc, accounts: [account], statementIds: created.map((s) => s.id), revisions: [revision] });
  repo.entityAccounts.set(account.id, account);
  for (const s of created) repo.statements.set(s.id, s);
  repo.entityRevisions.set(revision.id, revision);
  if (owner) repo.ownerId = id;
  repo.counter += 1;
  return { entityId: id, version: 1, accountId: account.id, added: created.map((s) => s.id) };
}

// ---- entity_record (§8.5, §6.3) ----
export function entityRecord(repo, input) {
  checkMembers(input, ['entityId', 'actor', 'text', 'accountSource', 'via', 'expectedVersion', 'name', 'aliases', 'add', 'update', 'support'], 'entity_record input');
  if (!has(input, 'entityId')) invalid('entityId is required: an Entity id, or "current_user" for the owner.');
  requireString(input.entityId, 'entityId');
  const words = parseWords(input, 'text');
  const expectedVersion = has(input, 'expectedVersion') ? parseExpectedVersion(input.expectedVersion) : undefined;
  const name = has(input, 'name') ? parseName(input.name) : undefined;
  if (has(input, 'aliases') && !Array.isArray(input.aliases)) invalid('aliases must be the complete new list of aliases, an array of strings (empty to remove them all).');
  const list = (key, parse) => {
    if (!has(input, key)) return [];
    if (!Array.isArray(input[key])) invalid(`${key} must be an array.`);
    return input[key].map((v, i) => parse(v, `${key}[${i}]`));
  };
  const add = list('add', (v, at) => parseNewStatement(v, at, true));
  const update = list('update', parseUpdate);
  const support = has(input, 'support') ? parseIdList(input.support, 'support') : [];
  if (name === undefined && !has(input, 'aliases') && add.length === 0 && update.length === 0 && support.length === 0) {
    invalid('entity_record changes nothing: give at least one of name, aliases (the complete new list), add (new Statements), update (changes to Statements) and support (Statements these words also support).');
  }
  const seenUpdates = new Set();
  for (const [i, u] of update.entries()) {
    if (seenUpdates.has(u.statementId)) invalid(`update[${i}] names Statement ${u.statementId} again; put every change to one Statement in one entry.`);
    seenUpdates.add(u.statementId);
  }
  for (const [i, item] of add.entries()) {
    const both = (item.supersedes ?? []).filter((id) => (item.conflictsWith ?? []).includes(id));
    if (both.length > 0) invalid(`add[${i}] both supersedes and conflicts with ${both.join(', ')}; a Statement either replaces another or contradicts it.`);
  }

  const rec = resolveEntity(repo, input.entityId);
  const entityId = rec.doc.id;
  const finalName = name ?? rec.doc.name;
  let aliases;
  if (has(input, 'aliases')) aliases = parseAliases(input.aliases, finalName);
  else if (name !== undefined) parseAliases(rec.doc.aliases, finalName, 'aliases (the stored ones, against the new name)');
  const own = (sid, where) => {
    const s = repo.statements.get(sid);
    if (!s || s.entityId !== entityId) {
      invalid(`${where} ${JSON.stringify(sid)} is not a Statement of Entity ${entityId}. Read the Entity (entity_get) for its Statement ids.`);
    }
  };
  add.forEach((item, i) => {
    (item.supersedes ?? []).forEach((sid, j) => own(sid, `add[${i}].supersedes[${j}]`));
    (item.conflictsWith ?? []).forEach((sid, j) => own(sid, `add[${i}].conflictsWith[${j}]`));
  });
  update.forEach((u, i) => own(u.statementId, `update[${i}].statementId`));
  support.forEach((sid, i) => own(sid, `support[${i}]`));
  if (expectedVersion !== undefined && expectedVersion !== rec.doc.version) {
    fail('VERSION_CONFLICT', `expectedVersion ${expectedVersion} is not the current version of Entity ${entityId} (${rec.doc.version}): another write came first. Read the Entity again (entity_get) and reconsider your change; do not resend it blindly.`);
  }

  // Build the change on copies; nothing below touches stored state until commit.
  const time = repo.now();
  const nowMs = Date.parse(time);
  const account = makeAccount(repo, entityId, words, time);
  const userWords = words.source === 'user';
  const isUserAccount = (id) => (id === account.id ? userWords : repo.entityAccounts.get(id)?.source === 'user');
  const restsOnUser = (s) => s.evidence.some(isUserAccount);
  const work = new Map();
  const get = (sid) => {
    if (!work.has(sid)) work.set(sid, clone(repo.statements.get(sid)));
    return work.get(sid);
  };
  const peek = (sid) => work.get(sid) ?? repo.statements.get(sid);
  const doc = clone(rec.doc);
  const payload = {};
  if (name !== undefined && name !== doc.name) {
    payload.name = { before: doc.name, after: name };
    doc.name = name;
  }
  if (aliases !== undefined && !sameValue(aliases, doc.aliases)) {
    payload.aliases = { before: doc.aliases, after: aliases };
    doc.aliases = aliases;
  }
  const created = [];
  const added = [];
  const merged = [];
  const changed = [];
  const supported = [];
  const touch = (s) => { s.updatedAt = time; };

  add.forEach((item, i) => {
    const links = (item.supersedes?.length ?? 0) + (item.conflictsWith?.length ?? 0);
    if (links === 0) {
      const key = sameThingKey(item.text, item.topic);
      const same = (s) => s.topic === item.topic && readStatus(s, nowMs) !== 'outdated' && sameThingKey(s.text, s.topic) === key;
      const existing = rec.statementIds.find((sid) => same(peek(sid)));
      if (existing !== undefined) {
        const s = get(existing);
        if (!s.evidence.includes(account.id)) { s.evidence.push(account.id); touch(s); }
        if (!merged.includes(existing)) merged.push(existing);
        return;
      }
      if (created.some(same)) return; // said twice in this call
    }
    for (const [j, sid] of (item.supersedes ?? []).entries()) {
      const s = peek(sid);
      if (!userWords && restsOnUser(s)) {
        fail('USER_WORDS_PROTECTED', `add[${i}].supersedes[${j}]: Statement ${sid} rests on the user's own words, and these words are not the user's (accountSource ${words.source}), so they cannot replace it. Add your version with conflictsWith: [${JSON.stringify(sid)}] instead.`);
      }
    }
    const stmt = makeStatement(repo, entityId, item, account.id, words.actor, time, item.conflictsWith?.length ? 'disputed' : 'current');
    created.push(stmt);
    added.push(stmt.id);
    for (const sid of item.supersedes ?? []) {
      const s = get(sid);
      if (s.status !== 'outdated') { s.status = 'outdated'; touch(s); }
    }
    for (const sid of item.conflictsWith ?? []) {
      const s = get(sid);
      s.conflictsWith = [...(s.conflictsWith ?? []), stmt.id];
      if (readStatus(s, nowMs) === 'current' && !restsOnUser(s)) s.status = 'disputed';
      touch(s);
    }
  });

  update.forEach((u, i) => {
    const s = get(u.statementId);
    if (u.status !== undefined && u.status !== s.status) {
      if (!userWords && s.status === 'disputed' && u.status === 'current') {
        fail('USER_CONFIRMATION_REQUIRED', `update[${i}]: Statement ${s.id} is disputed; only the user's own words (accountSource user) can make it current again. Ask the user, and record their answer.`);
      }
      if (!userWords && restsOnUser(s)) {
        fail('USER_WORDS_PROTECTED', `update[${i}]: Statement ${s.id} rests on the user's own words, and these words are not the user's (accountSource ${words.source}), so they cannot change its status. Add your version with conflictsWith instead.`);
      }
    }
    let did = false;
    for (const key of ['status', 'reason', 'sensitivity', 'inSummary']) {
      if (u[key] !== undefined && u[key] !== s[key]) { s[key] = u[key]; did = true; }
    }
    if (did) { touch(s); changed.push(s.id); }
  });

  for (const sid of support) {
    const s = get(sid);
    if (!s.evidence.includes(account.id)) { s.evidence.push(account.id); touch(s); }
    supported.push(sid);
  }

  if (added.length) payload.added = added;
  if (merged.length) payload.merged = merged;
  if (changed.length) payload.changed = changed;
  if (supported.length) payload.supported = supported;
  const revision = {
    id: repo.newId('rev'), targetEntityId: entityId, type: 'entity.recorded', payload,
    actor: clone(words.actor), sourceAccountIds: [account.id], occurredAt: time,
    baseVersion: doc.version, newVersion: doc.version + 1,
  };
  doc.version += 1;
  doc.updatedAt = time;

  // commit
  rec.doc = doc;
  rec.accounts.push(account);
  repo.entityAccounts.set(account.id, account);
  for (const s of work.values()) repo.statements.set(s.id, ordered(s, STATEMENT_ORDER));
  for (const s of created) {
    repo.statements.set(s.id, s);
    rec.statementIds.push(s.id);
  }
  rec.revisions.push(revision);
  repo.entityRevisions.set(revision.id, revision);
  repo.counter += 1;

  const out = { entityId, version: doc.version, accountId: account.id };
  if (added.length) out.added = added;
  if (merged.length) out.merged = merged;
  if (changed.length) out.changed = changed;
  if (supported.length) out.supported = supported;
  return out;
}

// ---- export (§8.6) ----
export function exportEntities(repo) {
  return [...repo.entities.values()].map((rec) => ({
    entity: renderEntity(rec.doc),
    accounts: clone(rec.accounts),
    statements: statementsOf(repo, rec).map((s) => ordered(clone(s), STATEMENT_ORDER)),
    revisions: clone(rec.revisions),
  }));
}

// ---- import checks (§8.6) ----
export function validateEntitySnapshot(list, unique) {
  if (!Array.isArray(list)) invalid('snapshot.entities must be an array.');
  const items = list.map((item, i) => {
    const at = `snapshot.entities[${i}]`;
    checkMembers(item, ['entity', 'accounts', 'statements', 'revisions'], at);
    const doc = validateEntityDoc(item.entity, `${at}.entity`);
    unique(doc.id, `${at}.entity.id`);
    for (const key of ['accounts', 'statements', 'revisions']) if (!Array.isArray(item[key])) invalid(`${at}.${key} must be an array.`);
    const accounts = item.accounts.map((a, j) => validateEntityAccount(a, `${at}.accounts[${j}]`, doc.id));
    accounts.forEach((a, j) => unique(a.id, `${at}.accounts[${j}].id`));
    const accountIds = new Set(accounts.map((a) => a.id));
    const statements = item.statements.map((s, j) => validateStatement(s, `${at}.statements[${j}]`, doc.id, accountIds));
    statements.forEach((s, j) => unique(s.id, `${at}.statements[${j}].id`));
    const statementIds = new Set(statements.map((s) => s.id));
    statements.forEach((s, j) => {
      for (const key of ['supersedes', 'conflictsWith']) {
        for (const sid of s[key] ?? []) {
          if (!statementIds.has(sid)) invalid(`${at}.statements[${j}].${key} names ${JSON.stringify(sid)}, which is not a Statement of Entity ${doc.id}.`);
        }
      }
    });
    const revisions = item.revisions.map((r, j) => validateEntityRevision(r, `${at}.revisions[${j}]`, doc.id));
    revisions.forEach((r, j) => unique(r.id, `${at}.revisions[${j}].id`));
    if (doc.version !== revisions.length) {
      invalid(`${at}: entity.version is ${doc.version} but ${revisions.length} Entity revisions are listed; each version must equal the number of Revisions.`);
    }
    return { doc, accounts, statements, revisions };
  });
  const owners = items.filter((item) => item.doc.owner);
  if (owners.length > 1) {
    invalid(`The snapshot has ${owners.length} owner Entities (${owners.map((o) => o.doc.id).join(', ')}); at most one Entity is the owner.`);
  }
  return items;
}

function validateEntityDoc(e, at) {
  checkMembers(e, ENTITY_ORDER, at);
  const id = requireString(e.id, `${at}.id`);
  if (id === OWNER_ID) invalid(`${at}.id must not be "current_user", which always refers to the owner Entity.`);
  const name = parseName(e.name, `${at}.name`);
  return {
    id,
    kind: parseKind(e.kind, `${at}.kind`),
    name,
    aliases: has(e, 'aliases') ? parseAliases(e.aliases, name, `${at}.aliases`) : [],
    owner: has(e, 'owner') ? parseBoolean(e.owner, `${at}.owner`) : false,
    version: parseCount(e.version, `${at}.version`, 1),
    createdAt: parseTimestamp(e.createdAt, `${at}.createdAt`),
    updatedAt: parseTimestamp(e.updatedAt, `${at}.updatedAt`),
  };
}

function validateEntityAccount(a, at, entityId) {
  checkMembers(a, ACCOUNT_ORDER, at);
  const account = { id: requireString(a.id, `${at}.id`), entityId: requireString(a.entityId, `${at}.entityId`) };
  if (account.entityId !== entityId) invalid(`${at} belongs to Entity ${account.entityId} but is listed under Entity ${entityId}.`);
  if (typeof a.text !== 'string' || a.text.trim().length === 0) invalid(`${at}.text must be a non-empty string.`);
  account.text = a.text;
  account.source = parseSource(a.source, `${at}.source`);
  if (has(a, 'via')) account.via = parseVia(a.via, `${at}.via`);
  account.actor = parseActor(a.actor, `${at}.actor`);
  account.createdAt = parseTimestamp(a.createdAt, `${at}.createdAt`);
  return account;
}

function validateStatement(s, at, entityId, accountIds) {
  checkMembers(s, STATEMENT_ORDER, at);
  const out = { id: requireString(s.id, `${at}.id`), entityId: requireString(s.entityId, `${at}.entityId`) };
  if (out.entityId !== entityId) invalid(`${at} belongs to Entity ${out.entityId} but is listed under Entity ${entityId}.`);
  out.text = parseStatementText(s.text, `${at}.text`);
  out.topic = parseTopic(s.topic, `${at}.topic`);
  if (!Array.isArray(s.evidence) || s.evidence.length === 0) invalid(`${at}.evidence must list at least one Entity account.`);
  out.evidence = s.evidence.map((id, i) => {
    const accountId = requireString(id, `${at}.evidence[${i}]`);
    if (!accountIds.has(accountId)) {
      invalid(`${at}.evidence[${i}] ${JSON.stringify(accountId)} is not an Entity account of Entity ${entityId}; Statements rest on Entity accounts of their own Entity.`);
    }
    return accountId;
  });
  if (has(s, 'basis')) out.basis = requireString(s.basis, `${at}.basis`);
  for (const key of ['saidAt', 'validFrom', 'validTo']) if (has(s, key)) out[key] = parsePartialTime(s[key], `${at}.${key}`);
  out.status = parseEnum(s.status, STATUSES, `${at}.status`);
  if (has(s, 'reason')) out.reason = requireString(s.reason, `${at}.reason`);
  for (const key of ['supersedes', 'conflictsWith']) {
    if (has(s, key)) {
      const ids = parseIdList(s[key], `${at}.${key}`);
      if (ids.length > 0) out[key] = ids;
    }
  }
  out.sensitivity = has(s, 'sensitivity') ? parseEnum(s.sensitivity, SENSITIVITIES, `${at}.sensitivity`) : 'normal';
  out.inSummary = has(s, 'inSummary') ? parseBoolean(s.inSummary, `${at}.inSummary`) : false;
  out.actor = parseActor(s.actor, `${at}.actor`);
  out.createdAt = parseTimestamp(s.createdAt, `${at}.createdAt`);
  out.updatedAt = parseTimestamp(s.updatedAt, `${at}.updatedAt`);
  return ordered(out, STATEMENT_ORDER);
}

function validateEntityRevision(r, at, entityId) {
  checkMembers(r, ['id', 'targetEntityId', 'type', 'payload', 'actor', 'sourceAccountIds', 'occurredAt', 'baseVersion', 'newVersion'], at);
  const rev = { id: requireString(r.id, `${at}.id`), targetEntityId: requireString(r.targetEntityId, `${at}.targetEntityId`) };
  if (rev.targetEntityId !== entityId) invalid(`${at} targets Entity ${rev.targetEntityId} but is listed under Entity ${entityId}.`);
  rev.type = parseEnum(r.type, ['entity.created', 'entity.recorded'], `${at}.type`);
  if (!isPlainObject(r.payload)) invalid(`${at}.payload must be an object.`);
  rev.payload = clone(r.payload);
  rev.actor = parseActor(r.actor, `${at}.actor`);
  if (!Array.isArray(r.sourceAccountIds)) invalid(`${at}.sourceAccountIds must be an array of Entity account ids.`);
  rev.sourceAccountIds = r.sourceAccountIds.map((id, i) => requireString(id, `${at}.sourceAccountIds[${i}]`));
  rev.occurredAt = parseTimestamp(r.occurredAt, `${at}.occurredAt`);
  rev.baseVersion = parseCount(r.baseVersion, `${at}.baseVersion`, 0);
  rev.newVersion = parseCount(r.newVersion, `${at}.newVersion`, 1);
  if (rev.newVersion !== rev.baseVersion + 1) invalid(`${at}.newVersion must be baseVersion + 1.`);
  return rev;
}
