// Templates to cases. A template (eval/README.md, "Template") is a scripted timeline with
// placeholders; each variant fills them in and becomes one case. Everything a case says and
// every gold answer come from the template, so the answers never depend on a model.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, isDate, random, shuffle } from './util.mjs';

export const DAY0 = '2026-10-05';
export const CATEGORIES = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'N1', 'X1', 'X2', 'X3'];
export const PRIMARY = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const STATES = ['emerging', 'active', 'waiting', 'dormant', 'done', 'cancelled'];
const ANSWER_TYPES = ['number', 'date', 'option', 'multi', 'provenance', 'unknown'];
const ASSISTANTS = ['A', 'B', 'C'];
const DEFAULT_LIBRARY = { N1: 10 };

class TemplateError extends Error {}
const check = (condition, where, message) => {
  if (!condition) throw new TemplateError(`${where}: ${message}`);
};

/** Replaces {name} with the variant's value everywhere; {{ and }} are literal braces. */
export function substitute(value, variant, where) {
  if (typeof value === 'string') {
    return value.replace(/\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      if (match === '{{') return '{';
      if (match === '}}') return '}';
      check(Object.hasOwn(variant, name), where, `the variant has no value for {${name}}`);
      return String(variant[name]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, variant, where));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, variant, where)]));
  return value;
}

const time = (value, where) => {
  const t = value ?? '20:00';
  check(/^([01]\d|2[0-3]):[0-5]\d$/.test(t) && t >= '08:00', where, `time must be HH:MM between 08:00 and 23:59 (Beijing), got ${t}`);
  return t;
};
const dayOf = (value, where, { max, min = -400 } = {}) => {
  check(Number.isInteger(value) && value >= min && (max === undefined || value <= max), where, `day must be an integer${max !== undefined ? ` at most ${max}` : ''}, got ${value}`);
  return addDays(DAY0, value);
};

function checkAnswer(answer, where) {
  check(answer && ANSWER_TYPES.includes(answer.type), where, `answer.type must be one of ${ANSWER_TYPES.join(', ')}`);
  const out = { ...answer };
  const type = answer.type === 'unknown' ? (answer.as ?? 'number') : answer.type;
  if (answer.options !== undefined || type === 'option' || type === 'multi') {
    check(answer.options && typeof answer.options === 'object', where, 'options must be {"A": "...", ...}');
    const letters = Object.keys(answer.options);
    check(letters.length >= 2 && letters.every((l, i) => l === String.fromCharCode(65 + i)), where, 'options must be lettered A, B, C … in order, at least two');
    check(letters.every((l) => typeof answer.options[l] === 'string' && answer.options[l].trim()), where, 'every option needs its text');
  }
  if (answer.type === 'number') {
    check(answer.value !== undefined && Number.isFinite(Number(answer.value)), where, 'a number answer needs a numeric value');
    out.value = String(Number(answer.value));
    out.stale = (answer.stale ?? []).map((s) => {
      check(Number.isFinite(Number(s)), where, 'stale numbers must be numeric');
      return String(Number(s));
    });
    check(!out.stale.includes(out.value), where, 'a stale value equals the answer');
  }
  if (answer.type === 'date') {
    out.value = answer.day !== undefined ? dayOf(answer.day, where) : answer.value;
    check(isDate(out.value), where, 'a date answer needs value YYYY-MM-DD or day');
    out.stale = (answer.stale ?? []).map((s) => (typeof s === 'number' ? dayOf(s, where) : s));
    check(out.stale.every(isDate), where, 'stale dates must be YYYY-MM-DD or day numbers');
    delete out.day;
  }
  if (answer.type === 'option') {
    check(answer.value in answer.options, where, 'the answer must be one of the option letters');
    out.stale = answer.stale ?? [];
    check(out.stale.every((l) => l in answer.options && l !== answer.value), where, 'stale options must be other option letters');
  }
  if (answer.type === 'multi') {
    check(Array.isArray(answer.value) && answer.value.every((l) => l in answer.options), where, 'a multi answer is a list of option letters');
    check(new Set(answer.value).size === answer.value.length, where, 'a multi answer lists each letter once');
  }
  if (answer.type === 'provenance') {
    check(ASSISTANTS.includes(answer.who), where, 'who must be A, B or C');
    check(['user', 'inference'].includes(answer.kind), where, 'kind must be user or inference');
    out.date = answer.day !== undefined ? dayOf(answer.day, where) : answer.date;
    check(isDate(out.date), where, 'a provenance answer needs date YYYY-MM-DD or day');
    delete out.day;
  }
  if (answer.type === 'unknown') check(answer.as === undefined || ['number', 'date', 'option'].includes(answer.as), where, 'as must be number, date or option');
  return out;
}

function checkSeed(seed, index, keys, where) {
  const at = `${where} seed ${index + 1}`;
  check(/^[a-z0-9][a-z0-9-]*$/.test(seed.key ?? ''), at, 'key must be lowercase letters, digits and hyphens');
  check(!keys.has(seed.key), at, `the key ${seed.key} is used twice`);
  check(typeof seed.title === 'string' && seed.title.trim() && [...seed.title].length <= 80, at, 'title must be 1 to 80 characters');
  check(STATES.includes(seed.state), at, `state must be one of ${STATES.join(', ')}`);
  check(seed.parent === undefined || seed.parent === null || keys.has(seed.parent), at, 'parent must be the key of an earlier seed');
  check(Array.isArray(seed.accounts) && seed.accounts.length > 0, at, 'a seed needs at least one account');
  const accounts = seed.accounts.map((a, i) => {
    const w = `${at} account ${i + 1}`;
    check(ASSISTANTS.includes(a.assistant), w, 'assistant must be A, B or C');
    check(['user', 'agent_response'].includes(a.source ?? 'user'), w, 'source must be user or agent_response');
    check(typeof a.text === 'string' && a.text.trim() === a.text && a.text, w, 'text must be non-blank, without surrounding spaces');
    return { date: dayOf(a.day, w, { max: -1 }), assistant: a.assistant, source: a.source ?? 'user', text: a.text };
  });
  check(accounts.every((a, i) => i === 0 || a.date >= accounts[i - 1].date), at, 'accounts must be in date order');
  const facts = seed.facts ?? {};
  check(Object.keys(facts).every((k) => ['goal', 'constraint', 'plan'].includes(k) && typeof facts[k] === 'string' && facts[k].trim()), at, 'facts are goal, constraint and plan, each a sentence');
  const organizedBy = seed.organizedBy ? { assistant: seed.organizedBy.assistant, date: dayOf(seed.organizedBy.day, `${at} organizedBy`, { max: -1 }) } : null;
  if (organizedBy) {
    check(ASSISTANTS.includes(organizedBy.assistant), at, 'organizedBy.assistant must be A, B or C');
    check(organizedBy.date >= accounts.at(-1).date, at, 'organizedBy must not be older than the last account');
    check(seed.state !== 'emerging' || Object.keys(facts).length || seed.progress, at, 'organizing must change something: a state other than emerging, a fact or progress');
  } else {
    check(seed.state === 'emerging' && !Object.keys(facts).length && !seed.progress, at, 'a seed nobody organized is emerging, with no facts and no progress');
  }
  const progress = seed.progress ? { text: seed.progress.text, date: dayOf(seed.progress.day, `${at} progress`, { max: -1 }) } : null;
  if (progress) check(typeof progress.text === 'string' && progress.text.trim(), at, 'progress needs text');
  keys.add(seed.key);
  return { key: `seed-${seed.key}`, title: seed.title, state: seed.state, parent: seed.parent ? `seed-${seed.parent}` : null, facts, progress, accounts, organizedBy };
}

/** One case from a template and a variant (already substituted). */
function expand(template, variant, index, split, where) {
  const t = substitute(template, variant, where);
  const keys = new Set();
  const seeds = (t.seed ?? []).map((seed, i) => checkSeed(seed, i, keys, where));
  for (const seed of seeds) {
    if (!seed.parent) continue;
    const parent = seeds.find((s) => s.key === seed.parent);
    check(parent.accounts[0].date <= seed.accounts[0].date, where, `${seed.title}: a part's first words must not be older than its parent's`);
  }
  check(Array.isArray(t.sessions) && t.sessions.length > 0, where, 'a template needs at least one session');
  let last = '';
  const sessions = t.sessions.map((s, i) => {
    const w = `${where} session ${i + 1}`;
    check(ASSISTANTS.includes(s.assistant), w, 'assistant must be A, B or C');
    check(typeof s.user === 'string' && s.user.trim(), w, 'user must hold what the user says');
    const date = dayOf(s.day, w, { min: 0 });
    const at = `${date} ${time(s.time, w)}`;
    check(at >= last, w, 'sessions must be in time order');
    last = at;
    return { index: i + 1, date, time: time(s.time, w), assistant: s.assistant, user: s.user };
  });
  check(Array.isArray(t.probes) && t.probes.length > 0, where, 'a template needs at least one probe');
  const probes = t.probes.map((p, i) => {
    const w = `${where} probe ${i + 1}`;
    check(ASSISTANTS.includes(p.assistant), w, 'assistant must be A, B or C');
    check(typeof p.question === 'string' && p.question.trim(), w, 'question must hold the question');
    const date = dayOf(p.day, w, { min: 0 });
    const at = `${date} ${time(p.time, w)}`;
    check(at > last, w, 'a probe comes after the last session');
    return { id: `q${i + 1}`, date, time: time(p.time, w), assistant: p.assistant, question: p.question, answer: checkAnswer(p.answer, w) };
  });
  const text = JSON.stringify([seeds, sessions.map((s) => s.user)]);
  for (const keyword of t.keywords) check(text.includes(keyword), where, `the keyword ${keyword} appears in no session or seed`);
  return {
    id: `${t.id}~${index + 1}`,
    template: t.id,
    category: t.category,
    author: t.author,
    split,
    library: t.library ?? DEFAULT_LIBRARY[t.category] ?? 150,
    keywords: t.keywords,
    seeds,
    sessions,
    probes,
  };
}

/** Checks a template's own fields and expands every variant. */
export function expandTemplate(template, { split, file = template?.id ?? '?' } = {}) {
  const where = `template ${file}`;
  check(/^[a-z0-9][a-z0-9-]*$/.test(template?.id ?? ''), where, 'id must be lowercase letters, digits and hyphens');
  check(CATEGORIES.includes(template.category), where, `category must be one of ${CATEGORIES.join(', ')}`);
  check(typeof template.author === 'string' && template.author.trim(), where, 'author must name who wrote it');
  check(typeof template.shape === 'string' && template.shape.trim(), where, 'shape must say what real situation it borrows the shape of');
  check(Array.isArray(template.keywords) && template.keywords.length > 0 && template.keywords.every((k) => typeof k === 'string' && k.trim()), where, 'keywords must list the words that identify its matters');
  check(template.library === undefined || [10, 50, 150].includes(template.library), where, 'library must be 10, 50 or 150');
  const variants = template.variants ?? [{}];
  check(Array.isArray(variants) && variants.length > 0, where, 'variants must be a non-empty list');
  return variants.map((variant, i) => expand(template, variant, i, split, `${where} variant ${i + 1}`));
}

/** Every template under `directory/<split>/`, expanded; ids must be unique across splits. */
export function loadTemplates(directory, splits) {
  const templates = [];
  const seen = new Set();
  for (const split of splits) {
    const folder = join(directory, split);
    let names = [];
    try {
      names = readdirSync(folder).filter((n) => n.endsWith('.json') && statSync(join(folder, n)).isFile()).sort();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      const template = JSON.parse(readFileSync(join(folder, name), 'utf8'));
      check(!seen.has(template.id), `template ${split}/${name}`, `the id ${template.id} is used twice`);
      seen.add(template.id);
      templates.push({ template, split, file: `${split}/${name}` });
    }
  }
  return templates;
}

export function expandAll(templates) {
  return templates.flatMap(({ template, split, file }) => expandTemplate(template, { split, file }));
}

/**
 * The scale contrast: `perCategory` cases of each category in `categories`, chosen with a
 * fixed seed, again with smaller libraries. Their ids end in @<size>; they are not in the
 * primary analysis.
 */
export function scaleCases(cases, { categories = ['D1', 'D3'], sizes = [10, 50], perCategory = 16, seed = 20261104 } = {}) {
  const out = [];
  for (const category of categories) {
    const pool = cases.filter((c) => c.category === category && c.library === 150).sort((a, b) => (a.id < b.id ? -1 : 1));
    const chosen = shuffle(random(seed), pool).slice(0, perCategory).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const size of sizes) for (const c of chosen) out.push({ ...c, id: `${c.id}@${size}`, library: size, scale: true });
  }
  return out;
}

export { TemplateError };
