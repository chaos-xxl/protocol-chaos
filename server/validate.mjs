// Input validation shared by every operation. Every failure is a ProtocolError
// carrying one of the codes of §5.4. Messages are written for agents and say how
// to fix the call; they are never logged (§5.4).

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export const fail = (code, message) => {
  throw new ProtocolError(code, message);
};
export const invalid = (message) => fail('VALIDATION_ERROR', message);

export const STATES = ['emerging', 'active', 'waiting', 'dormant', 'done', 'cancelled'];
export const OPEN_STATES = ['emerging', 'active', 'waiting', 'dormant'];
export const CLOSED_STATES = ['done', 'cancelled'];
export const ACTOR_KINDS = ['user', 'agent', 'authorized_external', 'system'];
export const ACCOUNT_SOURCES = ['user', 'agent_response', 'authorized_external'];
export const FACT_KEYS = ['goal', 'constraint', 'plan'];
export const SET_FIELDS = ['title', 'state', 'progress', 'facts', 'refs', 'metadata'];
export const REVISION_FIELDS = [
  'title', 'state', 'progress', 'facts.goal', 'facts.constraint', 'facts.plan', 'refs', 'metadata',
];

export const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBlank = (s) => s.trim().length === 0;

// Rejects anything that is not an object, and any member not listed (§4.2, §8).
export function checkMembers(value, allowed, where) {
  if (!isPlainObject(value)) invalid(`${where} must be a JSON object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const list = allowed.length ? allowed.join(', ') : 'none';
      invalid(`${where} has an unknown member "${key}". Allowed members: ${list}. Unknown members are rejected, not dropped.`);
    }
  }
}

// Every string the protocol defines is not blank (§4.1), ids included.
export function requireString(value, where) {
  if (typeof value !== 'string' || isBlank(value)) invalid(`${where} must be a non-blank string.`);
  return value;
}

export function parseActor(value, where = 'actor') {
  if (value === undefined) {
    invalid(`${where} is required: give your own identity, for example {"kind": "agent", "id": "laptop"}. Never write as the owner or as another writer.`);
  }
  checkMembers(value, ['kind', 'id', 'label'], where);
  if (!ACTOR_KINDS.includes(value.kind)) invalid(`${where}.kind must be one of ${ACTOR_KINDS.join(', ')}.`);
  if (typeof value.id !== 'string' || isBlank(value.id)) invalid(`${where}.id must be a non-empty string naming the writer.`);
  if (has(value, 'label') && (typeof value.label !== 'string' || isBlank(value.label))) {
    invalid(`${where}.label, when given, must be a non-blank string; omit it otherwise.`);
  }
  const actor = { kind: value.kind, id: value.id };
  if (has(value, 'label')) actor.label = value.label;
  return actor;
}

// Account text: trimmed and otherwise unchanged (§3.2, §4.4).
export function parseText(value, where = 'text') {
  if (typeof value !== 'string') invalid(`${where} must be a string holding the user's own words, verbatim.`);
  const text = value.trim();
  if (text.length === 0) invalid(`${where} is empty. Pass the user's actual words, verbatim.`);
  return text;
}

export function parseSource(value, where = 'accountSource') {
  if (!ACCOUNT_SOURCES.includes(value)) {
    invalid(`${where} must be one of ${ACCOUNT_SOURCES.join(', ')}: "user" for the user's own words, "agent_response" for your own sentence (such as an inference), "authorized_external" for words relayed from an application the user authorized.`);
  }
  return value;
}

export function parseVia(value, where = 'via') {
  if (typeof value !== 'string' || isBlank(value)) invalid(`${where}, when given, must be a non-blank string naming where the words came from; omit it otherwise.`);
  return value;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/;
export function isTimestamp(value) {
  if (typeof value !== 'string') return false;
  const m = TIMESTAMP.exec(value);
  if (!m) return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  // Reject dates that Date silently rolls over (2026-02-30).
  return new Date(t).toISOString().slice(0, 19) === `${m[1]}T${m[2]}`;
}
export function parseTimestamp(value, where) {
  if (!isTimestamp(value)) invalid(`${where} must be an RFC 3339 UTC timestamp written with Z, such as 2026-03-14T09:30:00.000Z.`);
  return value;
}

// Exact chronological comparison of two valid timestamps, sub-millisecond
// digits included ("the same instant", §8.1, §8.3). All are UTC with Z, so the
// fixed-width date-time part compares as text and the fraction as a decimal.
function splitTime(t) {
  const m = TIMESTAMP.exec(t);
  return [`${m[1]}T${m[2]}`, m[3] ? m[3].slice(1).replace(/0+$/, '') : ''];
}
export function compareTime(a, b) {
  const [da, fa] = splitTime(a);
  const [db, fb] = splitTime(b);
  if (da !== db) return da < db ? -1 : 1;
  const n = Math.max(fa.length, fb.length);
  const pa = fa.padEnd(n, '0');
  const pb = fb.padEnd(n, '0');
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

// Code-point order (§8.1), which differs from JavaScript's UTF-16 order.
export function compareCodePoints(a, b) {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0);
    const cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export function parseTitle(value, where = 'title') {
  if (typeof value !== 'string') invalid(`${where} must be a string of 1 to 80 characters.`);
  const length = [...value].length;
  if (length < 1 || length > 80 || isBlank(value)) {
    invalid(`${where} must be 1 to 80 characters and not blank (got ${length}). A title names the Event on its own: what it is, plus when or which, e.g. "Lisbon trip, spring 2027".`);
  }
  return value;
}

export function parseState(value, where = 'state') {
  if (!STATES.includes(value)) {
    const extra = value === null ? ' state cannot be removed; every Event has one.' : '';
    invalid(`${where} must be one of ${STATES.join(', ')}.${extra}`);
  }
  return value;
}

export function parseStateFilter(value, where = 'state') {
  if (!STATES.includes(value) && value !== 'open' && value !== 'closed') {
    invalid(`${where} must be one of ${STATES.join(', ')}, or "open" or "closed".`);
  }
  return value;
}

export function parseCount(value, where, min) {
  if (!Number.isInteger(value) || value < min) invalid(`${where} must be an integer of at least ${min}.`);
  return value;
}

// "expectedVersion, an integer" (§5.2): any integer is compared; a mismatch,
// even an impossible one such as -1, is VERSION_CONFLICT.
export function parseExpectedVersion(value, where = 'expectedVersion') {
  if (!Number.isInteger(value)) {
    invalid(`${where} must be the integer version of the Event you last read (a receipt's version). The repository version is not accepted here.`);
  }
  return value;
}

// Where information belongs when a writer invents a fact key (§4.5: the message
// SHOULD say where it belongs instead).
function misplacedFact(key) {
  const k = key.toLowerCase();
  const constraintish = ['budget', 'budgets', 'deadline', 'deadlines', 'limit', 'limits', 'constraints', 'preference',
    'preferences', 'wish', 'wishes', 'location', 'place', 'time', 'time_window', 'timewindow', 'when', 'where', 'date', 'dates'];
  const planish = ['plans', 'decision', 'decisions', 'schedule', 'itinerary', 'booking', 'bookings', 'arrangement', 'option'];
  const goalish = ['goals', 'aim', 'objective', 'purpose', 'done', 'completion', 'criterion'];
  if (constraintish.includes(k)) return `limits, deadlines, budgets, wishes and preferences (even about a place or a time) go in facts.constraint, as a sentence; once decided, the arrangement goes in facts.plan.`;
  if (planish.includes(k)) return `the arrangement as currently decided goes in facts.plan, as a sentence.`;
  if (goalish.includes(k)) return `what the Event is meant to achieve, including what would count as done, goes in facts.goal.`;
  if (['progress', 'status', 'state'].includes(k)) return `where the Event stands goes in set.progress ({text}), and its lifecycle in set.state, never in a fact.`;
  if (['title', 'name'].includes(k)) return `the name goes in set.title.`;
  if (['people', 'participants', 'refs', 'who', 'with', 'places'].includes(k)) return `the people, places and things it involves go in set.refs as [{"criteria": "..."}].`;
  return `facts holds only goal (what it is meant to achieve), constraint (limits, deadlines, budgets, wishes, preferences) and plan (the arrangement as decided); write it as a sentence in one of them, or put extension data in set.metadata under a namespaced key.`;
}

export function parseFactValue(value, where, allowNull) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || isBlank(value)) {
    invalid(`${where} must be a non-blank string: natural-language text that is clear on its own, a sentence or a paragraph, never an object or a list.${allowNull ? ' null removes it.' : ''}`);
  }
  return value;
}

// set.facts: each supplied key replaces that fact; null removes one (§8.1).
// null for the whole object removes every fact (§5.3).
export function parseFactsPatch(value, where = 'set.facts') {
  if (value === null) return null;
  if (!isPlainObject(value)) invalid(`${where} must be an object with any of goal, constraint and plan, each a sentence or null.`);
  const patch = {};
  for (const key of Object.keys(value)) {
    if (!FACT_KEYS.includes(key)) invalid(`${where} has an unknown key "${key}": ${misplacedFact(key)}`);
  }
  for (const key of FACT_KEYS) {
    if (has(value, key)) patch[key] = parseFactValue(value[key], `${where}.${key}`, true);
  }
  return patch;
}

export function parseFactsDocument(value, where) {
  if (!isPlainObject(value)) invalid(`${where} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!FACT_KEYS.includes(key)) invalid(`${where} has an unknown key "${key}": ${misplacedFact(key)}`);
  }
  const facts = {};
  for (const key of FACT_KEYS) if (has(value, key)) facts[key] = parseFactValue(value[key], `${where}.${key}`, false);
  return facts;
}

// Refs (§4.6): each entry has exactly one member, criteria (a description in
// the user's terms) or ref (the id of an existing Entity). Whether a ref names
// an Entity, and not the owner, is checked by the repository.
export function parseRefs(value, where = 'set.refs') {
  if (!Array.isArray(value)) invalid(`${where} must be an array of {"criteria": "..."} or {"ref": "<Entity id>"} entries; an empty list or null removes refs.`);
  return value.map((entry, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(entry)) invalid(`${at} must be an object with exactly one member: criteria (a description in the user's terms) or ref (an Entity id).`);
    const keys = Object.keys(entry);
    if (keys.length !== 1 || (keys[0] !== 'criteria' && keys[0] !== 'ref')) {
      invalid(`${at} must have exactly one member, criteria (a description in the user's terms, such as "my sister") or ref (the id of an existing Entity); found ${keys.length ? keys.join(', ') : 'none'}.`);
    }
    if (keys[0] === 'criteria') {
      if (typeof entry.criteria !== 'string' || isBlank(entry.criteria)) invalid(`${at}.criteria must be a non-blank string.`);
      return { criteria: entry.criteria };
    }
    if (typeof entry.ref !== 'string' || isBlank(entry.ref)) invalid(`${at}.ref must be the id of an existing Entity (from entity_search or entity_create).`);
    return { ref: entry.ref };
  });
}

// "Ignoring case" (§8): comparing the Unicode lowercase mappings of both sides.
export const fold = (s) => s.toLowerCase();
export const ci = {
  equals: (a, b) => fold(a) === fold(b),
  includes: (hay, needle) => fold(hay).includes(fold(needle)),
  startsWith: (hay, needle) => fold(hay).startsWith(fold(needle)),
};

export function parseBoolean(value, where) {
  if (typeof value !== 'boolean') invalid(`${where} must be true or false.`);
  return value;
}

export function parseEnum(value, allowed, where) {
  if (!allowed.includes(value)) invalid(`${where} must be one of ${allowed.join(', ')}.`);
  return value;
}

// A list of ids: non-blank strings, repeats dropped (order kept).
export function parseIdList(value, where) {
  if (!Array.isArray(value)) invalid(`${where} must be an array of Statement ids.`);
  const out = [];
  value.forEach((id, i) => {
    const s = requireString(id, `${where}[${i}]`);
    if (!out.includes(s)) out.push(s);
  });
  return out;
}

// ---- Entities (§6) ----

export const OWNER_ID = 'current_user';
export const ENTITY_KINDS = ['person', 'animal', 'thing', 'place'];
export const TOPICS = ['identity', 'home', 'family', 'work', 'skills', 'education', 'personality', 'beliefs', 'preferences',
  'interests', 'taste', 'food', 'habits', 'health', 'finance', 'accounts', 'relationship', 'details'];
export const STATUSES = ['current', 'outdated', 'disputed'];
export const SENSITIVITIES = ['normal', 'private', 'sensitive'];

export function parseKind(value, where = 'kind') {
  if (typeof value !== 'string' || isBlank(value)) invalid(`${where} must be a non-blank string: person, animal, thing or place (other kinds are kept as written).`);
  return value;
}

export function parseName(value, where = 'name') {
  if (typeof value !== 'string' || isBlank(value)) invalid(`${where} must be a non-blank string: what the user calls it.`);
  return value;
}

// Aliases (§6.1): each trimmed; a blank one, a repeated one or one equal to the
// name fails. Repeats and the name are compared ignoring case (§8).
export function parseAliases(value, name, where = 'aliases') {
  if (!Array.isArray(value)) invalid(`${where} must be an array of strings: the other names the user uses, empty when there are none.`);
  const nameKey = fold(name.trim());
  const seen = new Set();
  return value.map((alias, i) => {
    if (typeof alias !== 'string' || isBlank(alias)) invalid(`${where}[${i}] must be a non-blank string.`);
    const a = alias.trim();
    const key = fold(a);
    if (key === nameKey) invalid(`${where}[${i}] ${JSON.stringify(a)} equals the name ${JSON.stringify(name)}; an alias is another name. Leave it out.`);
    if (seen.has(key)) invalid(`${where}[${i}] ${JSON.stringify(a)} is listed twice (aliases are compared ignoring case). List each alias once.`);
    seen.add(key);
    return a;
  });
}

const utc = (y, mo, d, h = 0, mi = 0, s = 0) => {
  const t = new Date(0);
  t.setUTCFullYear(y, mo, d);
  t.setUTCHours(h, mi, s, 0);
  return t.getTime();
};
const daysIn = (y, mo) => new Date(utc(y, mo, 0)).getUTCDate();
const okDate = (y, mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
const PARTIAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

// A partial time (§6.2): YYYY, YYYY-MM, YYYY-MM-DD or an ISO 8601 date-time
// (extended format). Returns the instant (ms) from which it has passed: the end
// of the year, month or day it names, read in UTC, or just after the
// date-time (UTC when it has no offset). undefined when it is not one.
export function partialTimeEnd(value) {
  if (typeof value !== 'string') return undefined;
  let m = /^(\d{4})$/.exec(value);
  if (m) return utc(+m[1] + 1, 0, 1);
  m = /^(\d{4})-(\d{2})$/.exec(value);
  if (m) return +m[2] >= 1 && +m[2] <= 12 ? utc(+m[1], +m[2], 1) : undefined;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return okDate(+m[1], +m[2], +m[3]) ? utc(+m[1], +m[2] - 1, +m[3] + 1) : undefined;
  m = PARTIAL_DATE_TIME.exec(value);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s = '0', frac = '', zone = 'Z'] = m;
  if (!okDate(+y, +mo, +d) || +h > 23 || +mi > 59 || +s > 59) return undefined;
  let t = utc(+y, +mo - 1, +d, +h, +mi, +s) + Math.floor(Number(`0${frac || '.0'}`) * 1000);
  if (zone !== 'Z') {
    const hh = +zone.slice(1, 3);
    const mm = +zone.slice(-2);
    if (hh > 23 || mm > 59) return undefined;
    t -= (zone[0] === '-' ? -1 : 1) * (hh * 60 + mm) * 60000;
  }
  return t + 1;
}

export function parsePartialTime(value, where) {
  if (partialTimeEnd(value) === undefined) {
    invalid(`${where} must be a partial time: YYYY, YYYY-MM, YYYY-MM-DD or an ISO 8601 date-time such as 2026-03-14T09:30:00Z.`);
  }
  return value;
}

export function parseStatementText(value, where) {
  if (typeof value !== 'string' || isBlank(value)) invalid(`${where} must be a non-blank string: one fact in natural language, with absolute dates.`);
  const length = [...value].length;
  if (length > 200) invalid(`${where} is ${length} characters; a Statement holds one fact in 1 to 200 characters. Split it into several Statements.`);
  return value;
}

export function parseTopic(value, where) {
  if (typeof value !== 'string' || isBlank(value)) {
    invalid(`${where} must be a non-blank string, one of ${TOPICS.join(', ')} (other topics are accepted).`);
  }
  return value;
}

const NEW_STATEMENT = ['text', 'topic', 'basis', 'saidAt', 'validFrom', 'validTo', 'sensitivity', 'inSummary'];

// A new Statement (§8.5); in entity_record add it may also carry supersedes and
// conflictsWith.
export function parseNewStatement(value, where, allowLinks) {
  if (isPlainObject(value) && !allowLinks && (has(value, 'supersedes') || has(value, 'conflictsWith'))) {
    invalid(`${where}: supersedes and conflictsWith name existing Statements of the Entity, so they are accepted only in entity_record add.`);
  }
  if (isPlainObject(value) && (has(value, 'status') || has(value, 'reason'))) {
    invalid(`${where}: a new Statement has no status or reason; it starts current (disputed when it carries conflictsWith). Change a status later with entity_record update.`);
  }
  checkMembers(value, allowLinks ? [...NEW_STATEMENT, 'supersedes', 'conflictsWith'] : NEW_STATEMENT, where);
  const s = { text: parseStatementText(value.text, `${where}.text`), topic: parseTopic(value.topic, `${where}.topic`) };
  if (has(value, 'basis')) {
    if (typeof value.basis !== 'string' || isBlank(value.basis)) invalid(`${where}.basis, when given, must say what the inference rests on; omit it for what the user said.`);
    s.basis = value.basis;
  }
  for (const key of ['saidAt', 'validFrom', 'validTo']) if (has(value, key)) s[key] = parsePartialTime(value[key], `${where}.${key}`);
  if (has(value, 'sensitivity')) s.sensitivity = parseEnum(value.sensitivity, SENSITIVITIES, `${where}.sensitivity`);
  if (has(value, 'inSummary')) s.inSummary = parseBoolean(value.inSummary, `${where}.inSummary`);
  for (const key of ['supersedes', 'conflictsWith']) if (has(value, key)) s[key] = parseIdList(value[key], `${where}.${key}`);
  return s;
}

// An update of entity_record (§8.5).
export function parseUpdate(value, where) {
  checkMembers(value, ['statementId', 'status', 'reason', 'sensitivity', 'inSummary'], where);
  const u = { statementId: requireString(value.statementId, `${where}.statementId`) };
  if (has(value, 'status')) u.status = parseEnum(value.status, STATUSES, `${where}.status`);
  if (has(value, 'reason')) {
    if (typeof value.reason !== 'string' || isBlank(value.reason)) invalid(`${where}.reason, when given, must say why the status changed.`);
    u.reason = value.reason;
  }
  if (has(value, 'sensitivity')) u.sensitivity = parseEnum(value.sensitivity, SENSITIVITIES, `${where}.sensitivity`);
  if (has(value, 'inSummary')) u.inSummary = parseBoolean(value.inSummary, `${where}.inSummary`);
  if (Object.keys(u).length === 1) invalid(`${where} changes nothing: give at least one of status, reason, sensitivity and inSummary.`);
  return u;
}

export function parseMetadata(value, where = 'set.metadata') {
  if (!isPlainObject(value)) invalid(`${where} must be an object mapping namespaced string keys (such as "dev.example/flag") to JSON values; an empty object or null removes it.`);
  return structuredClone(value);
}

export function parseProgressPatch(value, where = 'set.progress') {
  checkMembers(value, ['text', 'timestamp'], where);
  if (typeof value.text !== 'string' || isBlank(value.text)) invalid(`${where}.text must be a non-blank string saying where the Event stands now.`);
  const progress = { text: value.text };
  if (has(value, 'timestamp')) progress.timestamp = parseTimestamp(value.timestamp, `${where}.timestamp`);
  return progress;
}

// Canonical JSON for "writing the stored value again changes nothing" (§5.3).
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
export const sameValue = (a, b) => canonical(a ?? null) === canonical(b ?? null);
