// The check that the three arms start from the same information: each arm's starting store
// is read back into canonical matters and compared with what was written. A case does not
// run unless all three agree.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRepository } from './p-writer.mjs';
import { INDEX, parseEntries, parseFiles } from './render.mjs';

/** Matters in a key-free form sorted by title: parents named by title, facts with only the keys present. */
export function comparable(matters) {
  const titleOfKey = new Map(matters.map((m) => [m.key, m.title]));
  return matters.map((m) => ({
    title: m.title,
    state: m.state,
    parent: m.parent === null ? null : (titleOfKey.get(m.parent) ?? m.parent),
    facts: Object.fromEntries(['goal', 'constraint', 'plan'].filter((k) => m.facts[k] !== undefined).map((k) => [k, m.facts[k]])),
    progress: m.progress ? { text: m.progress.text, date: m.progress.date } : null,
    accounts: m.accounts.map(({ date, assistant, source, text }) => ({ date, assistant, source, text })),
    organizedBy: m.organizedBy ? { assistant: m.organizedBy.assistant, date: m.organizedBy.date } : null,
  })).sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

/** Readable differences between two lists of matters; empty when they hold the same. */
export function diffMatters(expected, actual) {
  const a = new Map(comparable(expected).map((m) => [m.title, m]));
  const b = new Map(comparable(actual).map((m) => [m.title, m]));
  const out = [];
  for (const title of a.keys()) if (!b.has(title)) out.push(`missing: ${title}`);
  for (const title of b.keys()) if (!a.has(title)) out.push(`extra: ${title}`);
  for (const [title, m] of a) {
    const n = b.get(title);
    if (!n) continue;
    for (const field of Object.keys(m)) {
      if (JSON.stringify(m[field]) !== JSON.stringify(n[field])) {
        out.push(`${title}: ${field} differs: ${JSON.stringify(m[field]).slice(0, 160)} != ${JSON.stringify(n[field]).slice(0, 160)}`);
      }
    }
  }
  return out;
}

/** Reads each arm's starting store in `directories` ({P, T1, T2}) and compares it with `matters`. */
export function checkEquivalence(matters, directories) {
  const differences = {};
  const read = {
    P: (dir) => readRepository(dir),
    T1: (dir) => parseEntries(JSON.parse(readFileSync(join(dir, 'entries.json'), 'utf8')).entries),
    T2: (dir) => {
      const notes = join(dir, 'notes');
      const files = Object.fromEntries(readdirSync(notes).filter((n) => n !== INDEX && n.endsWith('.md')).map((n) => [n, readFileSync(join(notes, n), 'utf8')]));
      return parseFiles({ files, index: readFileSync(join(notes, INDEX), 'utf8') });
    },
  };
  for (const [arm, dir] of Object.entries(directories)) {
    try {
      differences[arm] = diffMatters(matters, read[arm](dir));
    } catch (error) {
      differences[arm] = [`unreadable: ${error.message}`];
    }
  }
  return { ok: Object.values(differences).every((list) => list.length === 0), differences };
}
