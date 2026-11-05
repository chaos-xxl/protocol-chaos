// The background library: 150 matters of one person, the same in every case and every arm,
// so that a case's own matters must be found among many others. Generated from a seed;
// generateLibrary({size: 10}) and ({size: 50}) are the first 10 and 50 of the 150, and a
// matter's parent always comes before it, so every prefix stands on its own.
//
// The canonical form of a matter is described in eval/README.md ("Matter"). Its facts are
// built only from the words it holds, so every arm can be checked to hold the same.
import { ABROAD, CITIES, EVERYDAY } from './library-kinds.mjs';
import { LONG } from './library-long.mjs';
import { addDays, between, chance, daysBetween, pick, random, shuffle } from './util.mjs';

export const LIBRARY_SIZE = 150;
export const LIBRARY_DATES = { first: '2025-11-01', last: '2026-09-30' };
/** Places the library may mention; a template's own places should be other ones, or reserved. */
export const LIBRARY_PLACES = [...CITIES, ...ABROAD, '香港', '宁波', '广州', '上海', '无锡', '兰州', '杭州', '黄山'];

const ASSISTANTS = ['A', 'B', 'C'];
const STATE_COUNTS = { active: 52, done: 30, dormant: 23, waiting: 15, emerging: 15, cancelled: 15 };
const PARTS_PER_PARENT = [4, 6];
// Assistants' own sentences that fit any matter: what an assistant did, or an inference with its basis.
const NOTES = [
  '已提醒用户留意时间（依据：用户说过怕忘）。',
  '推测：时间比价格更要紧（依据：用户说过想尽快弄完）。',
  '推测：这件事用户挺上心（依据：用户这个月提了好几次）。',
  '已按用户说的在日历上记了一笔（依据：用户让记一下）。',
  '推测：可能还会改主意（依据：用户说过再想想）。',
];
const LAST_START = '2026-09-10';

const dateBetween = (r, first, last) => addDays(first, between(r, 0, Math.max(0, daysBetween(first, last))));
const later = (a, b) => (a > b ? a : b);
const earlier = (a, b) => (a < b ? a : b);
const sentence = (parts) => (parts.length ? `${parts.join('；')}。` : undefined);

/** Every string in a matter's material, outcome functions resolved. */
function resolve(r, material) {
  const outcomes = {};
  for (const [state, outcome] of Object.entries(material.outcomes ?? {})) {
    outcomes[state] = typeof outcome === 'function' ? outcome(r) : outcome;
  }
  return { ...material, outcomes };
}

const textsOf = (material) => JSON.stringify(material);

/**
 * Draws material with `make(r, start)` until its title is new and it holds no reserved word.
 * Throws when 50 draws are not enough: the reserved words then cover too much of a kind.
 */
function draw(r, make, start, { titles, reserved }) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const material = resolve(r, make(r, start));
    const text = textsOf(material);
    if (titles.has(material.title)) continue;
    if (reserved.some((word) => text.includes(word))) continue;
    titles.add(material.title);
    return material;
  }
  return undefined;
}

/** One matter in canonical form from its material, state and first date. */
function compose(r, { key, material, state, first, parent }) {
  const accounts = [];
  let date = first;
  const say = (text, source = 'user') => {
    accounts.push({ date, assistant: pick(r, ASSISTANTS), source, text });
    date = earlier(LIBRARY_DATES.last, addDays(date, between(r, 1, 20)));
  };
  say(material.start);
  if (state === 'emerging') {
    return { key, title: material.title, state, parent, facts: {}, progress: null, accounts, organizedBy: null };
  }
  const constraint = material.startConstraint ? [material.startConstraint] : [];
  const plan = [];
  const count = between(r, 0, Math.min(3, material.details.length));
  const chosen = shuffle(r, material.details.map((_, index) => index)).slice(0, count).sort((a, b) => a - b);
  for (const index of chosen) {
    const detail = material.details[index];
    say(detail.say);
    if (detail.constraint) constraint.push(detail.constraint);
    if (detail.plan) plan.push(detail.plan);
  }
  if (material.inference && chance(r, 0.4)) {
    say(material.inference.say, 'agent_response');
    constraint.push(material.inference.constraint);
  } else if (chance(r, 0.3)) {
    say(pick(r, NOTES), 'agent_response');
  }
  const outcome = material.outcomes[state];
  const told = outcome && (state !== 'active' || chance(r, 0.6));
  if (told) {
    say(outcome.say);
    if (outcome.plan) plan.push(outcome.plan);
  }
  const last = accounts[accounts.length - 1].date;
  const organizedBy = { assistant: pick(r, ASSISTANTS), date: earlier(LIBRARY_DATES.last, addDays(last, between(r, 0, 3))) };
  const facts = { goal: material.goal };
  if (constraint.length) facts.constraint = sentence(constraint);
  if (plan.length) facts.plan = sentence(plan);
  return {
    key,
    title: material.title,
    state,
    parent,
    facts,
    progress: told ? { text: outcome.progress, date: organizedBy.date } : null,
    accounts,
    organizedBy,
  };
}

/**
 * The first `size` matters of the library.
 * @param {{size?: number, seed?: number, reserved?: string[]}} options reserved: words no matter may contain
 *   (the keywords of every template), so that each probe has exactly one right matter.
 */
export function generateLibrary({ size = LIBRARY_SIZE, seed = 20261104, reserved = [] } = {}) {
  if (!Number.isInteger(size) || size < 0 || size > LIBRARY_SIZE) throw new RangeError(`size must be 0 to ${LIBRARY_SIZE}`);
  const r = random(seed);
  const context = { titles: new Set(), reserved: reserved.filter((word) => typeof word === 'string' && word.trim()) };

  // Long-lived matters and their parts.
  const groups = [];
  for (const long of LONG) {
    const first = dateBetween(r, '2026-01-02', '2026-03-31');
    const parent = draw(r, long.parent, first, context);
    if (!parent) continue;
    const parts = [];
    const wanted = between(r, ...PARTS_PER_PARENT);
    const makers = shuffle(r, [...long.parts, ...long.parts]);
    for (const make of makers) {
      if (parts.length >= wanted) break;
      const start = dateBetween(r, addDays(first, 7), LAST_START);
      const material = draw(r, make, start, context);
      if (material) parts.push({ material, first: start });
    }
    groups.push({ parent: { material: parent, first }, parts });
  }
  const partCount = groups.reduce((n, group) => n + group.parts.length, 0);

  // Everyday matters fill the rest.
  const singles = [];
  let guard = 0;
  while (singles.length < LIBRARY_SIZE - groups.length - partCount && guard < 5000) {
    guard += 1;
    const kind = pick(r, EVERYDAY);
    const first = dateBetween(r, LIBRARY_DATES.first, LAST_START);
    const material = draw(r, kind.make, first, context);
    if (material) singles.push({ material, first });
  }
  if (singles.length < LIBRARY_SIZE - groups.length - partCount) {
    throw new Error('The reserved words leave too few everyday matters; reserve fewer or more specific words.');
  }

  // Order: parents among the everyday matters, each part somewhere after its parent.
  let order = shuffle(r, [...singles.map((item) => ({ item })), ...groups.map((group) => ({ item: group.parent, group }))]);
  for (const group of groups) {
    for (const part of group.parts) {
      const at = order.findIndex((entry) => entry.item === group.parent);
      const index = between(r, at + 1, order.length);
      order = [...order.slice(0, index), { item: part, parentItem: group.parent }, ...order.slice(index)];
    }
  }

  // States: exact proportions, parents kept open.
  const states = shuffle(r, Object.entries(STATE_COUNTS).flatMap(([state, n]) => Array(n).fill(state)));
  order.forEach((entry, index) => { entry.state = states[index]; });
  for (const entry of order) {
    if (!entry.group || ['active', 'dormant'].includes(entry.state)) continue;
    const swap = order.find((other) => !other.group && other.state === 'active');
    [entry.state, swap.state] = [swap.state, entry.state];
  }

  // Keys and canonical matters.
  const keyOf = new Map();
  const matters = order.map((entry, index) => {
    const key = `bg-${String(index + 1).padStart(3, '0')}`;
    keyOf.set(entry.item, key);
    return compose(r, {
      key,
      material: entry.item.material,
      state: entry.state,
      first: entry.item.first,
      parent: entry.parentItem ? keyOf.get(entry.parentItem) : null,
    });
  });
  return matters.slice(0, size);
}

/** Counts for a library, for the CLI and the tests. */
export function describeLibrary(matters) {
  const states = {};
  let accounts = 0;
  let inferences = 0;
  for (const matter of matters) {
    states[matter.state] = (states[matter.state] ?? 0) + 1;
    accounts += matter.accounts.length;
    inferences += matter.accounts.filter((account) => account.source === 'agent_response').length;
  }
  return {
    matters: matters.length,
    states,
    withParent: matters.filter((matter) => matter.parent).length,
    parents: new Set(matters.map((matter) => matter.parent).filter(Boolean)).size,
    accounts,
    inferences,
    withProgress: matters.filter((matter) => matter.progress).length,
    organized: matters.filter((matter) => matter.organizedBy).length,
    firstDate: matters.flatMap((m) => m.accounts.map((a) => a.date)).sort()[0],
    lastDate: matters.flatMap((m) => m.accounts.map((a) => a.date)).sort().at(-1),
  };
}

export { later };
