// The repository in memory, implementing Protocol Chaos draft 0.2 (Core, Search, Sync
// and Undo here; the Entities level in entities.mjs). store.mjs keeps it in a file.
// Every write validates its whole input first, then builds its changes in a
// transaction (Tx) on copies, and commits them in one step (§5.1). Within a process
// JavaScript runs one call at a time; across processes, store.mjs takes a lock.

import { randomBytes } from 'node:crypto';
import {
  FACT_KEYS, OWNER_ID, REVISION_FIELDS, SET_FIELDS, CLOSED_STATES, OPEN_STATES,
  checkMembers, ci, compareCodePoints, compareTime, fail, has, invalid, isPlainObject, isTimestamp, parseActor, parseCount,
  parseExpectedVersion, parseFactsDocument, parseFactsPatch, parseMetadata, parseProgressPatch, parseRefs, parseSource,
  parseState, parseStateFilter, parseText, parseTimestamp, parseTitle, parseVia, requireString, sameValue,
} from './validate.mjs';
import { entityCreate, entityGet, entityRecord, entitySearch, exportEntities, validateEntitySnapshot } from './entities.mjs';

export const PROTOCOL_VERSION = 'draft-0.2';
export const SCHEMA_VERSION = '0.3.0';

const clone = (v) => structuredClone(v);

function factsOf(doc) {
  const facts = {};
  for (const key of FACT_KEYS) if (doc.facts[key] !== undefined) facts[key] = doc.facts[key];
  return facts;
}

// The Event document of §4.2, in its field order; optional fields only when set.
function renderEvent(doc) {
  const out = { id: doc.id, version: doc.version, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
  if (doc.title !== undefined) out.title = doc.title;
  out.state = doc.state;
  if (doc.progress !== undefined) out.progress = clone(doc.progress);
  const facts = factsOf(doc);
  if (Object.keys(facts).length > 0) out.facts = facts;
  if (doc.refs !== undefined) out.refs = clone(doc.refs);
  out.parents = [...doc.parents];
  if (doc.metadata !== undefined) out.metadata = clone(doc.metadata);
  return out;
}

// A directory entry of context_pack (§8.1).
function directoryEntry(doc) {
  const entry = { id: doc.id };
  if (doc.title !== undefined) entry.title = doc.title;
  entry.state = doc.state;
  entry.parents = [...doc.parents];
  if (doc.progress !== undefined) entry.progress = clone(doc.progress);
  entry.updatedAt = doc.updatedAt;
  return entry;
}

// Whole values of the Revision fields of §4.8, null when absent.
function getField(doc, field) {
  if (field.startsWith('facts.')) return doc.facts[field.slice(6)] ?? null;
  if (field === 'state') return doc.state;
  return doc[field] ?? null;
}
function putField(doc, field, value) {
  if (field.startsWith('facts.')) {
    const key = field.slice(6);
    if (value === null) delete doc.facts[key];
    else doc.facts[key] = value;
    return;
  }
  if (value === null) delete doc[field];
  else doc[field] = clone(value);
}

// set of event_record_expression (§8.1, §5.3).
function parseSet(value) {
  if (isPlainObject(value) && has(value, 'parents')) {
    invalid('set cannot change parents: links are added and removed only by event_add_parent and event_remove_parent.');
  }
  checkMembers(value, SET_FIELDS, 'set');
  const patch = {};
  if (has(value, 'title')) patch.title = value.title === null ? null : parseTitle(value.title, 'set.title');
  if (has(value, 'state')) patch.state = parseState(value.state, 'set.state');
  if (has(value, 'progress')) patch.progress = value.progress === null ? null : parseProgressPatch(value.progress);
  if (has(value, 'facts')) patch.facts = parseFactsPatch(value.facts);
  // An empty refs list or metadata object removes the field, like null (§5.3).
  if (has(value, 'refs')) patch.refs = value.refs === null ? null : emptyToNull(parseRefs(value.refs));
  if (has(value, 'metadata')) patch.metadata = value.metadata === null ? null : emptyToNull(parseMetadata(value.metadata));
  return patch;
}
function emptyToNull(value) {
  if (Array.isArray(value)) return value.length === 0 ? null : value;
  return Object.keys(value).length === 0 ? null : value;
}

// The field changes a patch makes, in commit order; writing the stored value
// again changes nothing (§5.3).
function diffSet(doc, patch, time) {
  const changes = [];
  const consider = (field, after) => {
    if (!sameValue(getField(doc, field), after)) changes.push({ field, after });
  };
  if (has(patch, 'title')) consider('title', patch.title);
  if (has(patch, 'state')) consider('state', patch.state);
  if (has(patch, 'progress')) {
    const p = patch.progress;
    if (p === null) consider('progress', null);
    else if (p.timestamp !== undefined) consider('progress', { text: p.text, timestamp: p.timestamp });
    else if (!(doc.progress && doc.progress.text === p.text)) changes.push({ field: 'progress', after: { text: p.text, timestamp: time } });
  }
  if (has(patch, 'facts')) {
    for (const key of FACT_KEYS) {
      if (patch.facts === null) consider(`facts.${key}`, null);
      else if (has(patch.facts, key)) consider(`facts.${key}`, patch.facts[key]);
    }
  }
  if (has(patch, 'refs')) consider('refs', patch.refs);
  if (has(patch, 'metadata')) consider('metadata', patch.metadata);
  return changes;
}

class Tx {
  constructor(repo) {
    this.repo = repo;
    this.time = repo.now();
    this.work = new Map(); // eventId -> { doc, accounts, revisions, isNew }
  }

  open(id) {
    let w = this.work.get(id);
    if (!w) {
      const rec = this.repo.events.get(id);
      w = { doc: clone(rec.doc), accounts: [], revisions: [], isNew: false };
      this.work.set(id, w);
    }
    return w;
  }

  create(actor) {
    const id = this.repo.newId('evt');
    const doc = { id, version: 0, createdAt: this.time, updatedAt: this.time, state: 'emerging', facts: {}, parents: [] };
    const w = { doc, accounts: [], revisions: [], isNew: true };
    this.work.set(id, w);
    this.revise(w, 'event.created', {}, actor, []);
    return w;
  }

  revise(w, type, payload, actor, sourceAccountIds) {
    const baseVersion = w.doc.version;
    w.revisions.push({
      id: this.repo.newId('rev'), targetEventId: w.doc.id, type, payload, actor: clone(actor),
      sourceAccountIds: [...sourceAccountIds], occurredAt: this.time, baseVersion, newVersion: baseVersion + 1,
    });
    w.doc.version = baseVersion + 1;
    w.doc.updatedAt = this.time;
  }

  addAccount(w, { text, source, via, actor }) {
    const account = { id: this.repo.newId('acc'), eventId: w.doc.id, text, source };
    if (via !== undefined) account.via = via;
    account.actor = clone(actor);
    account.createdAt = this.time;
    w.accounts.push(account);
    this.revise(w, 'account.added', { accountId: account.id }, actor, [account.id]);
    return account;
  }

  setField(w, field, after, actor, sourceAccountIds) {
    const before = getField(w.doc, field);
    putField(w.doc, field, after);
    this.revise(w, 'field.changed', { field, before: clone(before), after: clone(after) }, actor, sourceAccountIds);
  }

  commit() {
    let changed = false;
    for (const [id, w] of this.work) {
      if (w.revisions.length === 0) continue;
      changed = true;
      let rec = this.repo.events.get(id);
      if (!rec) {
        rec = { doc: w.doc, accounts: [], revisions: [] };
        this.repo.events.set(id, rec);
      }
      rec.doc = w.doc;
      for (const a of w.accounts) { rec.accounts.push(a); this.repo.accounts.set(a.id, a); }
      for (const r of w.revisions) { rec.revisions.push(r); this.repo.revisions.set(r.id, r); }
    }
    if (changed) this.repo.counter += 1;
  }
}

// Directory order (§8.1, most recently updated first) is a function of the
// documents alone, so an imported copy lists Events in the same order (§8.6):
// updatedAt descending, then id in descending code-point order for the same
// instant. This server stamps every commit with a strictly later time, so ties
// arise only in imported data.
const directoryOrder = (a, b) => compareTime(b.doc.updatedAt, a.doc.updatedAt) || compareCodePoints(b.doc.id, a.doc.id);

const encodeCursor = (doc) => `c_${Buffer.from(JSON.stringify({ u: doc.updatedAt, id: doc.id })).toString('base64url')}`;
function decodeCursor(value) {
  if (typeof value === 'string' && value.startsWith('c_')) {
    try {
      const parsed = JSON.parse(Buffer.from(value.slice(2), 'base64url').toString('utf8'));
      if (isPlainObject(parsed) && isTimestamp(parsed.u) && typeof parsed.id === 'string') return parsed;
    } catch { /* fall through */ }
  }
  return invalid('cursor is not one this server returned; pass next from the previous page unchanged.');
}
// Entries that come after the cursor's entry in directory order.
const afterCursor = (cursor) => (rec) => {
  const c = compareTime(rec.doc.updatedAt, cursor.u);
  return c < 0 || (c === 0 && compareCodePoints(rec.doc.id, cursor.id) < 0);
};

const stateMatches = (state, filter) => filter === undefined
  || (filter === 'open' ? OPEN_STATES.includes(state) : filter === 'closed' ? CLOSED_STATES.includes(state) : state === filter);

// §8.2 matching ignores case as §8 defines it (Unicode lowercase mappings of
// both sides); see `ci` in validate.mjs.

// The parent list just before revisions[upto], replayed from the history, so
// that undoing a removal puts the link back where it was (§8.4).
function parentsBefore(revisions, upto) {
  let parents = [];
  const removedAt = new Map();
  const byId = new Map(revisions.map((r) => [r.id, r]));
  for (let i = 0; i < upto; i += 1) {
    const r = revisions[i];
    if (r.type === 'parent.added' && !parents.includes(r.payload.parentEventId)) parents.push(r.payload.parentEventId);
    else if (r.type === 'parent.removed') {
      removedAt.set(r.id, parents.indexOf(r.payload.parentEventId));
      parents = parents.filter((p) => p !== r.payload.parentEventId);
    } else if (r.type === 'revision.reverted') {
      const t = byId.get(r.payload.revisionId);
      if (t?.type === 'parent.added') parents = parents.filter((p) => p !== t.payload.parentEventId);
      else if (t?.type === 'parent.removed' && !parents.includes(t.payload.parentEventId)) {
        const at = removedAt.get(t.id);
        parents.splice(at === undefined || at < 0 ? parents.length : Math.min(at, parents.length), 0, t.payload.parentEventId);
      }
    }
  }
  return parents;
}

const UNDOABLE = ['field.changed', 'parent.added', 'parent.removed'];

export class Repository {
  constructor() {
    this.bootId = randomBytes(4).toString('hex');
    this.counter = 0;
    this.lastTime = 0;
    this.clear();
  }

  clear() {
    this.events = new Map(); // id -> { doc, accounts, revisions }, in creation order
    this.accounts = new Map(); // Event Accounts only
    this.revisions = new Map(); // Event Revisions only
    // Entities level (§6), see entities.mjs.
    this.entities = new Map(); // id -> { doc, accounts, statementIds, revisions }, in creation order
    this.entityAccounts = new Map();
    this.statements = new Map();
    this.entityRevisions = new Map();
    this.ownerId = undefined;
    this.ids = new Set();
    this.nextId = { evt: 0, acc: 0, rev: 0, ent: 0, stm: 0 };
  }

  isEmpty() { return this.events.size === 0 && this.entities.size === 0; }

  // refs (§4.6): a ref names an existing Entity, never the owner.
  checkRefTargets(refs, where = 'set.refs') {
    refs.forEach((entry, i) => {
      if (entry.ref === undefined) return;
      const at = `${where}[${i}].ref`;
      if (entry.ref === OWNER_ID || entry.ref === this.ownerId) {
        invalid(`${at} names the owner's own Entity. Every Event already belongs to the user, so refs never name the owner; leave the user out of refs.`);
      }
      if (!this.entities.has(entry.ref)) {
        invalid(`${at} ${JSON.stringify(entry.ref)} names no Entity. Find it with entity_search, create it with entity_create, or describe it as {"criteria": "..."}.`);
      }
    });
  }

  // Entities named by an Event's refs, as [{id, kind, name}] (§8.1).
  refEntities(doc) {
    const out = [];
    for (const entry of doc.refs ?? []) {
      if (entry.ref === undefined || out.some((e) => e.id === entry.ref)) continue;
      const rec = this.entities.get(entry.ref);
      if (rec) out.push({ id: rec.doc.id, kind: rec.doc.kind, name: rec.doc.name });
    }
    return out;
  }

  // Events whose refs name an Entity, as [{id, title?, state}], in directory order (§8.5).
  referencingEvents(entityId) {
    return [...this.events.values()]
      .filter((rec) => (rec.doc.refs ?? []).some((entry) => entry.ref === entityId))
      .sort(directoryOrder)
      .map(({ doc }) => {
        const out = { id: doc.id };
        if (doc.title !== undefined) out.title = doc.title;
        out.state = doc.state;
        return out;
      });
  }

  // ---- §8.5 Entities ----
  entitySearch(input) { return entitySearch(this, input); }
  entityGet(input) { return entityGet(this, input); }
  entityCreate(input) { return entityCreate(this, input); }
  entityRecord(input) { return entityRecord(this, input); }

  // The repository version (§5.2): opaque, changes with every committed change.
  get version() { return `rv_${this.bootId}_${this.counter}`; }

  // Commit time: strictly later than any time issued before, so that
  // "most recently updated first" is exact (see directoryOrder).
  now() {
    const t = Math.max(Date.now(), this.lastTime + 1);
    this.lastTime = t;
    return new Date(t).toISOString();
  }

  newId(prefix) {
    let id;
    do {
      this.nextId[prefix] += 1;
      id = `${prefix}_${String(this.nextId[prefix]).padStart(4, '0')}`;
    } while (this.ids.has(id));
    this.ids.add(id);
    return id;
  }

  requireEvent(id, where = 'eventId') {
    const rec = this.events.get(id);
    if (!rec) fail('NOT_FOUND', `${where} ${JSON.stringify(id)} names no Event. Read the directory (context_pack) for the ids that exist.`);
    return rec;
  }

  checkVersion(rec, expectedVersion) {
    if (expectedVersion !== undefined && expectedVersion !== rec.doc.version) {
      fail('VERSION_CONFLICT', `expectedVersion ${expectedVersion} is not the current version of Event ${rec.doc.id}: another write came first. Read the Event again (event_get_protocol) and reconsider your change; do not resend it blindly.`);
    }
  }

  receipt(eventId, accountId, changed) {
    const doc = this.events.get(eventId).doc;
    const receipt = { eventId, version: doc.version, state: doc.state, accountId, accountReused: false };
    if (doc.title !== undefined) receipt.title = doc.title;
    receipt.facts = factsOf(doc);
    receipt.changed = changed;
    return receipt;
  }

  // ---- §8.1 event_note ----
  eventNote(input) {
    checkMembers(input, ['actor', 'text', 'accountSource', 'via', 'eventId', 'title', 'parentEventId'], 'event_note input');
    const actor = parseActor(input.actor);
    const text = parseText(input.text);
    const source = has(input, 'accountSource') ? parseSource(input.accountSource) : 'user';
    const via = has(input, 'via') ? parseVia(input.via) : undefined;
    const eventId = has(input, 'eventId') ? requireString(input.eventId, 'eventId') : undefined;
    const title = has(input, 'title') ? parseTitle(input.title) : undefined;
    const parentEventId = has(input, 'parentEventId') ? requireString(input.parentEventId, 'parentEventId') : undefined;
    if (eventId !== undefined && parentEventId !== undefined) {
      invalid('parentEventId applies only when starting a new Event (without eventId). To link an existing Event, call event_add_parent.');
    }
    const changed = [];
    let tx;
    let w;
    let account;
    if (eventId !== undefined) {
      this.requireEvent(eventId);
      tx = new Tx(this);
      w = tx.open(eventId);
      account = tx.addAccount(w, { text, source, via, actor });
      changed.push('account');
      if (title !== undefined && w.doc.title === undefined) {
        tx.setField(w, 'title', title, actor, [account.id]);
        changed.push('title');
      }
    } else {
      if (parentEventId !== undefined) this.requireEvent(parentEventId, 'parentEventId');
      tx = new Tx(this);
      w = tx.create(actor);
      changed.push('created');
      account = tx.addAccount(w, { text, source, via, actor });
      changed.push('account');
      if (parentEventId !== undefined) {
        w.doc.parents.push(parentEventId);
        tx.revise(w, 'parent.added', { parentEventId }, actor, [account.id]);
        changed.push('parent');
      }
      if (title !== undefined) {
        tx.setField(w, 'title', title, actor, [account.id]);
        changed.push('title');
      }
    }
    tx.commit();
    return this.receipt(w.doc.id, account.id, changed);
  }

  // ---- §8.1 event_record_expression ----
  recordExpression(input) {
    checkMembers(input, ['eventId', 'actor', 'text', 'accountSource', 'via', 'expectedVersion', 'accountId', 'set'], 'event_record_expression input');
    const eventId = requireString(input.eventId, 'eventId');
    const actor = parseActor(input.actor);
    const text = parseText(input.text);
    const source = has(input, 'accountSource') ? parseSource(input.accountSource) : 'user';
    const via = has(input, 'via') ? parseVia(input.via) : undefined;
    const expectedVersion = has(input, 'expectedVersion') ? parseExpectedVersion(input.expectedVersion) : undefined;
    const accountId = has(input, 'accountId') ? requireString(input.accountId, 'accountId') : undefined;
    const patch = has(input, 'set') ? parseSet(input.set) : {};
    const rec = this.requireEvent(eventId);
    if (accountId !== undefined) {
      const account = this.accounts.get(accountId);
      if (!account || account.eventId !== eventId) {
        invalid(`accountId ${JSON.stringify(accountId)} is not an Account of Event ${eventId}. Ground the change on words recorded on this Event, or omit accountId to record the words now.`);
      }
      if (account.text !== text) {
        invalid(`text must equal the words of Account ${accountId} exactly (after trimming). Pass that Account's text unchanged, or omit accountId to record new words.`);
      }
    }
    if (patch.refs) this.checkRefTargets(patch.refs);
    this.checkVersion(rec, expectedVersion);
    const tx = new Tx(this);
    const w = tx.open(eventId);
    const changed = [];
    let groundId = accountId;
    if (groundId === undefined) {
      groundId = tx.addAccount(w, { text, source, via, actor }).id;
      changed.push('account');
    }
    for (const { field, after } of diffSet(w.doc, patch, tx.time)) {
      tx.setField(w, field, after, actor, [groundId]);
      changed.push(field);
    }
    tx.commit();
    return this.receipt(eventId, groundId, changed);
  }

  // ---- §8.1 event_add_parent / event_remove_parent ----
  linkInput(input, op) {
    checkMembers(input, ['childEventId', 'parentEventId', 'actor', 'sourceAccountIds', 'expectedVersion'], `${op} input`);
    const childId = requireString(input.childEventId, 'childEventId');
    const parentId = requireString(input.parentEventId, 'parentEventId');
    const actor = parseActor(input.actor);
    if (!Array.isArray(input.sourceAccountIds) || input.sourceAccountIds.length === 0) {
      invalid('sourceAccountIds must list at least one Account of the child or of the parent: the words the link rests on.');
    }
    const sources = [];
    input.sourceAccountIds.forEach((id, i) => {
      const s = requireString(id, `sourceAccountIds[${i}]`);
      if (!sources.includes(s)) sources.push(s);
    });
    const expectedVersion = has(input, 'expectedVersion') ? parseExpectedVersion(input.expectedVersion) : undefined;
    const child = this.requireEvent(childId, 'childEventId');
    this.requireEvent(parentId, 'parentEventId');
    for (const id of sources) {
      const account = this.accounts.get(id);
      if (!account || (account.eventId !== childId && account.eventId !== parentId)) {
        invalid(`sourceAccountIds: ${JSON.stringify(id)} is not an Account of the child or of the parent. A link rests on words recorded on one of the two Events.`);
      }
    }
    this.checkVersion(child, expectedVersion);
    return { childId, parentId, actor, sources, child };
  }

  linkResult(childId) {
    const doc = this.events.get(childId).doc;
    return { eventId: childId, version: doc.version, parents: [...doc.parents] };
  }

  // Does following parent links upward from `from` reach `target`?
  reaches(from, target) {
    const seen = new Set();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const rec = this.events.get(id);
      if (rec) stack.push(...rec.doc.parents);
    }
    return false;
  }

  addParent(input) {
    const { childId, parentId, actor, sources, child } = this.linkInput(input, 'event_add_parent');
    if (childId === parentId) fail('PART_OF_CYCLE', 'An Event cannot be its own parent.');
    if (this.reaches(parentId, childId)) {
      fail('PART_OF_CYCLE', `Linking would close a cycle: ${parentId} is already part of ${childId}, directly or through other Events.`);
    }
    if (!child.doc.parents.includes(parentId)) {
      const tx = new Tx(this);
      const w = tx.open(childId);
      w.doc.parents.push(parentId);
      tx.revise(w, 'parent.added', { parentEventId: parentId }, actor, sources);
      tx.commit();
    }
    return this.linkResult(childId);
  }

  removeParent(input) {
    const { childId, parentId, actor, sources, child } = this.linkInput(input, 'event_remove_parent');
    if (!child.doc.parents.includes(parentId)) {
      fail('NOT_FOUND', `Event ${childId} has no link to parent ${parentId}; there is nothing to remove.`);
    }
    const tx = new Tx(this);
    const w = tx.open(childId);
    w.doc.parents = w.doc.parents.filter((p) => p !== parentId);
    tx.revise(w, 'parent.removed', { parentEventId: parentId }, actor, sources);
    tx.commit();
    return this.linkResult(childId);
  }

  // ---- §8.1 event_get_protocol ----
  getProtocol(input) {
    checkMembers(input, ['eventId', 'accounts'], 'event_get_protocol input');
    const eventId = requireString(input.eventId, 'eventId');
    let count = 20;
    if (has(input, 'accounts')) {
      count = input.accounts === 'all' ? Infinity : parseCount(input.accounts, 'accounts (how many recent Accounts, or "all")', 0);
    }
    const rec = this.requireEvent(eventId);
    const accounts = count >= rec.accounts.length ? rec.accounts : rec.accounts.slice(rec.accounts.length - count);
    const out = { event: renderEvent(rec.doc), accounts: clone(accounts) };
    const entities = this.refEntities(rec.doc);
    if (entities.length > 0) out.entities = entities;
    return out;
  }

  // ---- §8.1 context_pack ----
  contextPack(input) {
    checkMembers(input, ['sinceVersion', 'state', 'limit', 'cursor'], 'context_pack input');
    if (has(input, 'sinceVersion') && (typeof input.sinceVersion !== 'string' || input.sinceVersion.trim() === '')) {
      invalid('sinceVersion must be the repository version string from an earlier context_pack.');
    }
    const state = has(input, 'state') ? parseStateFilter(input.state) : undefined;
    const limit = has(input, 'limit') ? parseCount(input.limit, 'limit', 1) : undefined;
    const cursor = has(input, 'cursor') ? decodeCursor(input.cursor) : undefined;
    if (has(input, 'sinceVersion') && input.sinceVersion === this.version) {
      return { protocolVersion: PROTOCOL_VERSION, version: this.version, unchanged: true };
    }
    let list = [...this.events.values()].filter((r) => stateMatches(r.doc.state, state)).sort(directoryOrder);
    if (cursor !== undefined) list = list.filter(afterCursor(cursor));
    let next;
    if (limit !== undefined && list.length > limit) {
      list = list.slice(0, limit);
      next = encodeCursor(list[list.length - 1].doc);
    }
    const out = { protocolVersion: PROTOCOL_VERSION, version: this.version, events: list.map((r) => directoryEntry(r.doc)) };
    if (next !== undefined) out.next = next;
    return out;
  }

  // ---- §8.1 event_get_revisions ----
  getRevisions(input) {
    checkMembers(input, ['eventId', 'after', 'limit'], 'event_get_revisions input');
    const eventId = requireString(input.eventId, 'eventId');
    const after = has(input, 'after') ? requireString(input.after, 'after') : undefined;
    const limit = has(input, 'limit') ? parseCount(input.limit, 'limit', 1) : undefined;
    const rec = this.requireEvent(eventId);
    let start = 0;
    if (after !== undefined) {
      const index = rec.revisions.findIndex((r) => r.id === after);
      if (index < 0) invalid(`after ${JSON.stringify(after)} is not a Revision of Event ${eventId}; pass next from the previous page.`);
      start = index + 1;
    }
    const end = limit === undefined ? rec.revisions.length : Math.min(rec.revisions.length, start + limit);
    const page = rec.revisions.slice(start, end);
    const out = { revisions: clone(page) };
    if (end < rec.revisions.length) out.next = page[page.length - 1].id;
    return out;
  }

  // ---- §8.2 event_search ----
  // Matching is by words, never by meaning. Best matches first:
  //   0 title equals the query, 1 title starts with it, 2 title contains it
  //     (these three are the Events §8.2 requires, so they always rank first);
  //   3 the query (or the query trimmed) appears in the title, a fact, the
  //     progress, a ref or an Account;
  //   4 every whitespace-separated word of the query appears somewhere there.
  // All comparisons ignore case. Ties follow directory order.
  search(input) {
    checkMembers(input, ['query', 'state', 'limit'], 'event_search input');
    if (!has(input, 'query')) invalid('query is required: the words to look for, such as the name of a matter.');
    if (typeof input.query !== 'string' || input.query.trim() === '') {
      invalid('query must be a non-blank string: the words to look for, such as the name of a matter. To list every Event, read the directory (context_pack).');
    }
    const query = input.query;
    const state = has(input, 'state') ? parseStateFilter(input.state) : undefined;
    const limit = has(input, 'limit') ? parseCount(input.limit, 'limit', 1) : undefined;
    const trimmed = query.trim();
    const words = trimmed.split(/\s+/u);
    const hits = [];
    for (const rec of this.events.values()) {
      if (!stateMatches(rec.doc.state, state)) continue;
      const tier = this.searchTier(rec, query, trimmed, words);
      if (tier !== undefined) hits.push({ rec, tier });
    }
    hits.sort((a, b) => a.tier - b.tier || directoryOrder(a.rec, b.rec));
    const page = limit === undefined ? hits : hits.slice(0, limit);
    return { events: page.map(({ rec }) => directoryEntry(rec.doc)) };
  }

  searchTier(rec, query, trimmed, words) {
    const { doc } = rec;
    const title = doc.title;
    if (title !== undefined && ci.includes(title, query)) {
      if (ci.equals(title, query)) return 0;
      return ci.startsWith(title, query) ? 1 : 2;
    }
    const texts = [];
    if (title !== undefined) texts.push(title);
    for (const key of FACT_KEYS) if (doc.facts[key] !== undefined) texts.push(doc.facts[key]);
    if (doc.progress !== undefined) texts.push(doc.progress.text);
    for (const ref of doc.refs ?? []) {
      if (ref.criteria !== undefined) texts.push(ref.criteria);
      const entity = ref.ref !== undefined ? this.entities.get(ref.ref) : undefined;
      if (entity) texts.push(entity.doc.name, ...entity.doc.aliases);
    }
    for (const account of rec.accounts) texts.push(account.text);
    if (texts.some((t) => ci.includes(t, query) || ci.includes(t, trimmed))) return 3;
    if (words.length > 1 && words.every((w) => texts.some((t) => ci.includes(t, w)))) return 4;
    return undefined;
  }

  // ---- §8.3 event_words_since ----
  // The Accounts created after `since`, oldest first (ties in commit order),
  // form one stream; a batch is a prefix of it, cut before the Account that
  // would bring in Event number limit + 1, but never between two Accounts with
  // the same createdAt (so a batch can then hold more than limit Events).
  wordsSince(input) {
    checkMembers(input, ['since', 'limit'], 'event_words_since input');
    if (!has(input, 'since')) {
      invalid('since is required: a timestamp such as 2026-03-14T09:30:00.000Z. Pass the checkpoint of your previous call, or an early time such as 1970-01-01T00:00:00.000Z to read every word.');
    }
    const since = parseTimestamp(input.since, 'since');
    const limit = has(input, 'limit') ? parseCount(input.limit, 'limit (the number of Events per batch)', 1) : undefined;
    const stream = [...this.accounts.values()].filter((a) => compareTime(a.createdAt, since) > 0);
    stream.sort((a, b) => compareTime(a.createdAt, b.createdAt)); // stable: ties keep commit order
    const groups = new Map(); // eventId -> Accounts in this batch
    let last;
    for (const account of stream) {
      const isNewEvent = !groups.has(account.eventId);
      const tied = last !== undefined && compareTime(account.createdAt, last.createdAt) === 0;
      if (limit !== undefined && isNewEvent && groups.size >= limit && !tied) break;
      if (isNewEvent) groups.set(account.eventId, []);
      groups.get(account.eventId).push(account);
      last = account;
    }
    const returned = [...groups.values()].reduce((n, list) => n + list.length, 0);
    const events = [...groups].map(([id, words]) => {
      const doc = this.events.get(id).doc;
      const entry = { id, version: doc.version };
      if (doc.title !== undefined) entry.title = doc.title;
      entry.state = doc.state;
      const facts = factsOf(doc);
      if (Object.keys(facts).length > 0) entry.facts = facts;
      if (doc.refs !== undefined) entry.refs = clone(doc.refs);
      if (doc.progress !== undefined) entry.progress = clone(doc.progress);
      entry.parents = [...doc.parents];
      entry.words = clone(words);
      return entry;
    });
    return {
      version: this.version,
      checkpoint: last === undefined ? since : last.createdAt,
      remaining: stream.length - returned,
      events,
    };
  }

  // ---- §8.4 event_undo_revision ----
  undoRevision(input) {
    checkMembers(input, ['revisionId', 'actor'], 'event_undo_revision input');
    const revisionId = requireString(input.revisionId, 'revisionId');
    const actor = parseActor(input.actor);
    const target = this.revisions.get(revisionId);
    if (!target && this.entityRevisions.has(revisionId)) {
      fail('REVISION_NOT_REVERSIBLE', `Revision ${revisionId} is an Entity revision. Entity writes are kept for audit and reversed by later writes (entity_record); there is no undo.`);
    }
    if (!target) {
      fail('NOT_FOUND', `revisionId ${JSON.stringify(revisionId)} names no Revision. Read the Event's history (event_get_revisions) for the ids.`);
    }
    const rec = this.events.get(target.targetEventId);
    const notReversible = (why) => fail('REVISION_NOT_REVERSIBLE', `Revision ${revisionId} cannot be undone: ${why}`);
    if (target.type === 'event.created' || target.type === 'account.added') {
      notReversible('Events and words are never removed; only changes (field.changed, parent.added, parent.removed) can be undone. To correct the Event, write the change with event_record_expression, or close a mistaken Event as cancelled.');
    }
    if (target.type === 'revision.reverted') {
      notReversible('an undo cannot be undone. Make the change again with a write.');
    }
    if (target.revertedByRevisionId !== undefined) {
      notReversible(`it was already undone by ${target.revertedByRevisionId}. To go further back, undo the latest change that has not been undone.`);
    }
    const latest = [...rec.revisions].reverse().find((r) => UNDOABLE.includes(r.type) && r.revertedByRevisionId === undefined);
    if (latest.id !== revisionId) {
      notReversible(`only the latest change of Event ${rec.doc.id} that has not been undone can be undone, and that is ${latest.id}. Read the Event again (event_get_protocol, event_get_revisions) and reconsider: someone may have changed it since.`);
    }
    const tx = new Tx(this);
    const w = tx.open(rec.doc.id);
    if (target.type === 'field.changed') {
      const { field, before } = target.payload;
      if (field === 'state' && before === null) notReversible('an Event always has a state, and this change has none to restore.');
      putField(w.doc, field, clone(before));
    } else if (target.type === 'parent.added') {
      w.doc.parents = w.doc.parents.filter((p) => p !== target.payload.parentEventId);
    } else {
      const parentId = target.payload.parentEventId;
      if (!this.events.has(parentId)) fail('NOT_FOUND', `The parent ${parentId} named by Revision ${revisionId} does not exist.`);
      if (parentId === rec.doc.id || this.reaches(parentId, rec.doc.id)) {
        fail('PART_OF_CYCLE', `Restoring the link to ${parentId} would now close a cycle: ${parentId} has since become part of ${rec.doc.id}. Remove that link first, or leave this one removed.`);
      }
      if (!w.doc.parents.includes(parentId)) {
        const before = parentsBefore(rec.revisions, rec.revisions.indexOf(target));
        const at = before.indexOf(parentId);
        w.doc.parents.splice(at < 0 ? w.doc.parents.length : Math.min(at, w.doc.parents.length), 0, parentId);
      }
    }
    tx.revise(w, 'revision.reverted', { revisionId }, actor, []);
    const revision = w.revisions[w.revisions.length - 1];
    tx.commit();
    target.revertedByRevisionId = revision.id;
    return clone(revision);
  }

  // ---- §8.6 export ----
  exportRepository(input) {
    checkMembers(input, [], 'repository_export input');
    return {
      schemaVersion: SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      exportedAt: this.now(),
      events: [...this.events.values()].map((rec) => ({
        event: renderEvent(rec.doc), accounts: clone(rec.accounts), revisions: clone(rec.revisions),
      })),
      entities: exportEntities(this),
    };
  }

  // ---- §8.6 import ----
  importRepository(input) {
    checkMembers(input, ['snapshot'], 'repository_import input');
    if (!has(input, 'snapshot')) invalid('snapshot is required: pass an export produced by repository_export.');
    if (!this.isEmpty()) {
      fail('REPOSITORY_NOT_EMPTY', 'This repository already holds data; an export can be imported only into an empty repository. Nothing was imported.');
    }
    const { items, entityItems } = validateSnapshot(input.snapshot);
    this.clear();
    const seeTime = (t) => { this.lastTime = Math.max(this.lastTime, Date.parse(t)); };
    for (const item of items) {
      this.events.set(item.doc.id, { doc: item.doc, accounts: item.accounts, revisions: item.revisions });
      this.ids.add(item.doc.id);
      for (const a of item.accounts) { this.accounts.set(a.id, a); this.ids.add(a.id); }
      for (const r of item.revisions) { this.revisions.set(r.id, r); this.ids.add(r.id); }
      // Later writes must sort after every imported Event, and their Accounts
      // after every imported Account (event_words_since reads by createdAt).
      [item.doc.updatedAt, ...item.accounts.map((a) => a.createdAt), ...item.revisions.map((r) => r.occurredAt)].forEach(seeTime);
    }
    for (const item of entityItems) {
      this.entities.set(item.doc.id, {
        doc: item.doc, accounts: item.accounts, statementIds: item.statements.map((s) => s.id), revisions: item.revisions,
      });
      this.ids.add(item.doc.id);
      if (item.doc.owner) this.ownerId = item.doc.id;
      for (const a of item.accounts) { this.entityAccounts.set(a.id, a); this.ids.add(a.id); }
      for (const s of item.statements) { this.statements.set(s.id, s); this.ids.add(s.id); }
      for (const r of item.revisions) { this.entityRevisions.set(r.id, r); this.ids.add(r.id); }
      [item.doc.updatedAt, ...item.accounts.map((a) => a.createdAt), ...item.statements.map((s) => s.updatedAt), ...item.revisions.map((r) => r.occurredAt)].forEach(seeTime);
    }
    this.counter += 1;
    return { imported: true };
  }
}

// ---- snapshot checks (§8.6): everything is checked before anything changes ----

const REVISION_TYPES = ['event.created', 'account.added', 'field.changed', 'parent.added', 'parent.removed', 'revision.reverted'];
const PAYLOAD_MEMBERS = {
  'event.created': [],
  'account.added': ['accountId'],
  'field.changed': ['field', 'before', 'after'],
  'parent.added': ['parentEventId'],
  'parent.removed': ['parentEventId'],
  'revision.reverted': ['revisionId'],
};

function validateSnapshot(s) {
  checkMembers(s, ['schemaVersion', 'protocolVersion', 'exportedAt', 'events', 'entities'], 'snapshot');
  if (s.schemaVersion !== SCHEMA_VERSION) {
    invalid(`snapshot.schemaVersion must be "${SCHEMA_VERSION}" (draft-0.2 exports); this server imports no other schema.`);
  }
  if (has(s, 'protocolVersion') && s.protocolVersion !== PROTOCOL_VERSION) invalid(`snapshot.protocolVersion must be "${PROTOCOL_VERSION}".`);
  if (has(s, 'exportedAt')) parseTimestamp(s.exportedAt, 'snapshot.exportedAt');
  if (!Array.isArray(s.events)) invalid('snapshot.events must be an array.');
  if (has(s, 'entities') && !Array.isArray(s.entities)) invalid('snapshot.entities must be an array.');
  const ids = new Set();
  const unique = (id, where) => {
    if (ids.has(id)) invalid(`${where}: the id ${JSON.stringify(id)} appears more than once in the snapshot.`);
    ids.add(id);
  };
  const items = s.events.map((item, i) => {
    const at = `snapshot.events[${i}]`;
    checkMembers(item, ['event', 'accounts', 'revisions'], at);
    const doc = validateEventDoc(item.event, `${at}.event`);
    unique(doc.id, `${at}.event.id`);
    if (!Array.isArray(item.accounts)) invalid(`${at}.accounts must be an array.`);
    if (!Array.isArray(item.revisions)) invalid(`${at}.revisions must be an array.`);
    const accounts = item.accounts.map((a, j) => validateAccount(a, `${at}.accounts[${j}]`, doc.id));
    accounts.forEach((a, j) => unique(a.id, `${at}.accounts[${j}].id`));
    const revisions = item.revisions.map((r, j) => validateRevision(r, `${at}.revisions[${j}]`, doc.id));
    revisions.forEach((r, j) => unique(r.id, `${at}.revisions[${j}].id`));
    if (doc.version !== revisions.length) {
      invalid(`${at}: event.version is ${doc.version} but ${revisions.length} Revisions are listed; each version must equal the number of Revisions.`);
    }
    return { doc, accounts, revisions };
  });
  const entityItems = validateEntitySnapshot(has(s, 'entities') ? s.entities : [], unique);
  // refs name Entities in the export, never the owner (§4.6, §8.6).
  const entityById = new Map(entityItems.map((item) => [item.doc.id, item]));
  items.forEach((item, i) => {
    (item.doc.refs ?? []).forEach((entry, j) => {
      if (entry.ref === undefined) return;
      const at = `snapshot.events[${i}].event.refs[${j}].ref`;
      const target = entityById.get(entry.ref);
      if (!target) invalid(`${at} ${JSON.stringify(entry.ref)} names no Entity in the snapshot.`);
      if (target.doc.owner) invalid(`${at} names the owner's Entity; refs never name the owner.`);
    });
  });
  const byId = new Map(items.map((item) => [item.doc.id, item]));
  for (const item of items) {
    for (const p of item.doc.parents) {
      if (!byId.has(p)) invalid(`Event ${item.doc.id} names parent ${JSON.stringify(p)}, which is not in the snapshot.`);
    }
  }
  const mark = new Map(); // 1 = on the current path, 2 = done
  const visit = (id) => {
    if (mark.get(id) === 2) return;
    if (mark.get(id) === 1) invalid(`The parent links in the snapshot form a cycle through Event ${id}.`);
    mark.set(id, 1);
    for (const p of byId.get(id).doc.parents) visit(p);
    mark.set(id, 2);
  };
  for (const item of items) visit(item.doc.id);
  return { items, entityItems };
}

function validateEventDoc(e, at) {
  checkMembers(e, ['id', 'version', 'createdAt', 'updatedAt', 'title', 'state', 'progress', 'facts', 'refs', 'parents', 'metadata'], at);
  const doc = { id: requireString(e.id, `${at}.id`) };
  doc.version = parseCount(e.version, `${at}.version`, 1);
  doc.createdAt = parseTimestamp(e.createdAt, `${at}.createdAt`);
  doc.updatedAt = parseTimestamp(e.updatedAt, `${at}.updatedAt`);
  if (has(e, 'title')) doc.title = parseTitle(e.title, `${at}.title`);
  doc.state = parseState(e.state, `${at}.state`);
  if (has(e, 'progress')) {
    const p = parseProgressPatch(e.progress, `${at}.progress`);
    if (p.timestamp === undefined) invalid(`${at}.progress.timestamp is required in an Event document.`);
    doc.progress = p;
  }
  doc.facts = has(e, 'facts') ? parseFactsDocument(e.facts, `${at}.facts`) : {};
  // refs and metadata are absent rather than empty (§4.2): an empty one is read as absent.
  if (has(e, 'refs')) {
    const refs = parseRefs(e.refs, `${at}.refs`);
    if (refs.length > 0) doc.refs = refs;
  }
  if (!Array.isArray(e.parents)) invalid(`${at}.parents must be an array of Event ids, empty when there are none.`);
  doc.parents = e.parents.map((p, i) => requireString(p, `${at}.parents[${i}]`));
  if (new Set(doc.parents).size !== doc.parents.length) invalid(`${at}.parents lists the same parent twice.`);
  if (has(e, 'metadata')) {
    const metadata = parseMetadata(e.metadata, `${at}.metadata`);
    if (Object.keys(metadata).length > 0) doc.metadata = metadata;
  }
  return doc;
}

function validateAccount(a, at, eventId) {
  checkMembers(a, ['id', 'eventId', 'text', 'source', 'via', 'actor', 'createdAt'], at);
  const account = { id: requireString(a.id, `${at}.id`), eventId: requireString(a.eventId, `${at}.eventId`) };
  if (account.eventId !== eventId) invalid(`${at} belongs to Event ${account.eventId} but is listed under Event ${eventId}.`);
  if (typeof a.text !== 'string' || a.text.trim().length === 0) invalid(`${at}.text must be a non-empty string.`);
  account.text = a.text;
  account.source = parseSource(a.source, `${at}.source`);
  if (has(a, 'via')) account.via = parseVia(a.via, `${at}.via`);
  account.actor = parseActor(a.actor, `${at}.actor`);
  account.createdAt = parseTimestamp(a.createdAt, `${at}.createdAt`);
  return account;
}

function validateRevision(r, at, eventId) {
  checkMembers(r, ['id', 'targetEventId', 'type', 'payload', 'actor', 'sourceAccountIds', 'occurredAt', 'baseVersion', 'newVersion', 'revertedByRevisionId'], at);
  const rev = { id: requireString(r.id, `${at}.id`), targetEventId: requireString(r.targetEventId, `${at}.targetEventId`) };
  if (rev.targetEventId !== eventId) invalid(`${at} targets Event ${rev.targetEventId} but is listed under Event ${eventId}.`);
  if (!REVISION_TYPES.includes(r.type)) invalid(`${at}.type must be one of ${REVISION_TYPES.join(', ')}.`);
  rev.type = r.type;
  const members = PAYLOAD_MEMBERS[r.type];
  checkMembers(r.payload, members, `${at}.payload`);
  for (const m of members) if (!has(r.payload, m)) invalid(`${at}.payload.${m} is required for a ${r.type} Revision.`);
  for (const m of ['accountId', 'parentEventId', 'revisionId']) if (has(r.payload, m)) requireString(r.payload[m], `${at}.payload.${m}`);
  if (r.type === 'field.changed' && !REVISION_FIELDS.includes(r.payload.field)) {
    invalid(`${at}.payload.field must be one of ${REVISION_FIELDS.join(', ')}.`);
  }
  rev.payload = clone(r.payload);
  rev.actor = parseActor(r.actor, `${at}.actor`);
  if (!Array.isArray(r.sourceAccountIds)) invalid(`${at}.sourceAccountIds must be an array of Account ids.`);
  rev.sourceAccountIds = r.sourceAccountIds.map((id, i) => requireString(id, `${at}.sourceAccountIds[${i}]`));
  rev.occurredAt = parseTimestamp(r.occurredAt, `${at}.occurredAt`);
  rev.baseVersion = parseCount(r.baseVersion, `${at}.baseVersion`, 0);
  rev.newVersion = parseCount(r.newVersion, `${at}.newVersion`, 1);
  if (rev.newVersion !== rev.baseVersion + 1) invalid(`${at}.newVersion must be baseVersion + 1.`);
  if (has(r, 'revertedByRevisionId')) rev.revertedByRevisionId = requireString(r.revertedByRevisionId, `${at}.revertedByRevisionId`);
  return rev;
}
