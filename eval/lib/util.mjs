// Small helpers shared by the harness: a seeded random source, dates on the user's clock
// (Beijing time, UTC+8, no daylight saving), files written in one step, and a limit on how
// many jobs run at once.
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, cpSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** A deterministic random source in [0, 1) (mulberry32). */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed derived from text, so that each part of a run has its own stream. */
export const seedOf = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest().readUInt32BE(0);

export const pick = (r, list) => list[Math.floor(r() * list.length)];
export const chance = (r, p) => r() < p;
export const between = (r, low, high) => low + Math.floor(r() * (high - low + 1));

/** A shuffled copy (Fisher–Yates). */
export function shuffle(r, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---- dates ----

const DAY_MS = 86_400_000;
const BEIJING_MS = 8 * 3_600_000;
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** `date` plus `days`, as YYYY-MM-DD. */
export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`. */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export const weekday = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

/** The UTC instant of a Beijing date and time ("20:00"), as an RFC 3339 timestamp. */
export const instantOf = (date, time = '20:00') => new Date(Date.parse(`${date}T${time}:00Z`) - BEIJING_MS).toISOString();

/** The Beijing date of a UTC timestamp. */
export const beijingDate = (timestamp) => new Date(Date.parse(timestamp) + BEIJING_MS).toISOString().slice(0, 10);

// ---- files ----

/** Writes a file in one step: a temporary file, flushed, then renamed over the target. */
export function writeFileAtomic(file, text, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(temporary, 'w', mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

export const writeJson = (file, value, mode) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export function appendJsonl(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function readJsonl(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export function copyDirectory(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

// ---- jobs ----

/** Runs `jobs` (functions returning promises) with at most `limit` at once; resolves with their results in order. */
export async function runLimited(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await jobs[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
  return results;
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replaces every occurrence of each secret in `text`. */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  return out;
}
