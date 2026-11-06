// Scoring by rules, not by a model. A probe's reply ends with a line "ANSWER: <value>"; the
// value is parsed for the question's type and compared with the gold answer. Outcomes:
// correct, stale (an earlier value of the timeline), wrong, unknown (the model says the store
// does not hold it) and unparseable. A wrong number or option that belongs to a similar
// matter of the case (the answer's `confused` values) is marked detail "confused". Gold
// answer types are described in eval/README.md.

export const OUTCOMES = ['correct', 'stale', 'wrong', 'unknown', 'unparseable', 'failed'];
const UNKNOWN = /^(unknown|未知|不知道|不清楚|不确定|没有记录|记录里没有|无记录|查不到|没查到)$/i;

const norm = (text) => String(text).normalize('NFKC').trim().replace(/\s+/g, ' ');
const isUnknown = (value) => UNKNOWN.test(value.replace(/[\s。.!！"'「」“”]/g, ''));

// ---- the message ----

function formatLine(answer) {
  const type = answer.type === 'unknown' ? (answer.as ?? 'number') : answer.type;
  const none = '记录里没有，就写「ANSWER: UNKNOWN」。';
  switch (type) {
    case 'number': return `回答格式：最后一行写「ANSWER: 数字」${answer.unit && answer.type !== 'unknown' ? `（单位：${answer.unit}）` : ''}。${none}`;
    case 'date': return `回答格式：最后一行写「ANSWER: YYYY-MM-DD」。${none}`;
    case 'option': return `回答格式：最后一行写「ANSWER: 选项字母」，只写一个字母。${none}`;
    case 'multi': return `回答格式：最后一行写「ANSWER: ["A", "C"]」这样的字母列表，选出全部符合的；一个都没有，就写「ANSWER: []」。${none}`;
    case 'provenance': return `回答格式：最后一行写「ANSWER: {"who": "A", "date": "YYYY-MM-DD", "kind": "user"}」。who 是哪个助手（A、B 或 C），date 是哪天，kind 是 user（用户说的）或 inference（助手推测的）。${none}`;
    default: throw new Error(`unknown answer type ${type}`);
  }
}

/** The user message of a probe: the question, the options if any, and the answer format. */
export function probeMessage(question, answer) {
  const parts = [question.trim()];
  if (answer.options) parts.push(Object.keys(answer.options).sort().map((letter) => `${letter}. ${answer.options[letter]}`).join('\n'));
  parts.push(formatLine(answer));
  return parts.join('\n\n');
}

// ---- reading the answer ----

/** The text after the last "ANSWER:" line, or undefined. */
export function extractAnswer(reply) {
  if (typeof reply !== 'string') return undefined;
  const lines = reply.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^\s*(?:[-*>]\s*)?[*_`]*\s*ANSWER\s*[*_`]*\s*[:：]\s*[*_`]*\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let value = m[1].trim();
    if (!value) value = (lines.slice(i + 1).find((line) => line.trim()) ?? '').trim();
    value = value.replace(/^[*_`]+|[*_`]+$/g, '').trim();
    while (/^[「“"'`][\s\S]*[」”"'`]$/.test(value) && value.length >= 2) value = value.slice(1, -1).trim();
    return value;
  }
  return undefined;
}

// ---- numbers ----

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };
const CN_BIG = { 万: 1e4, 亿: 1e8, w: 1e4, W: 1e4, k: 1e3, K: 1e3 };
export const NUMBER_RUN = /[-+]?(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千])(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿]|(?<=\d)\s?[万千百亿]|(?<=[\d万千百])[kKwW](?![A-Za-z]))*/u;

/** The value of a number written with Arabic digits, Chinese numerals, or both (2.5万, 两万五, 2万5千). */
export function parseNumberRun(run) {
  const tokens = run.replace(/\s/g, '').match(/\d+(?:\.\d+)?|[^\d]/gu) ?? [];
  let sign = 1;
  if (tokens[0] === '-' || tokens[0] === '+') sign = tokens.shift() === '-' ? -1 : 1;
  let total = 0;
  let section = 0;
  let number = null;
  let lastUnit = 1;
  let afterZero = false;
  let sawUnit = false;
  for (const token of tokens) {
    if (/^\d/.test(token)) { number = Number(token); afterZero = false; continue; }
    if (token in CN_DIGITS) {
      if (CN_DIGITS[token] === 0) { afterZero = true; number = null; continue; }
      number = CN_DIGITS[token];
      continue;
    }
    if (token in CN_UNITS) {
      const unit = CN_UNITS[token];
      section += (number ?? (unit === 10 ? 1 : NaN)) * unit;
      number = null;
      lastUnit = unit;
      afterZero = false;
      sawUnit = true;
      continue;
    }
    if (token in CN_BIG) {
      const big = CN_BIG[token];
      total += (section + (number ?? 0)) * big;
      if (section === 0 && number === null) return NaN;
      section = 0;
      number = null;
      lastUnit = big;
      afterZero = false;
      sawUnit = true;
      continue;
    }
    return NaN;
  }
  if (number !== null) {
    // 两万五 is 25000 and 三千五 is 3500: a single trailing digit right after a unit counts in the next unit down.
    const colloquial = sawUnit && !afterZero && Number.isInteger(number) && number < 10 && lastUnit >= 10;
    section += colloquial ? number * (lastUnit / 10) : number;
  }
  return sign * (total + section);
}

/** The first number in a value, or undefined; `more` tells whether other numbers follow. */
export function parseNumber(value) {
  const cleaned = norm(value).replace(/(?<=\d)[,，_\u2009\u202f'](?=\d{3}\b|\d{3}\D|\d{3}$)/g, '');
  const m = NUMBER_RUN.exec(cleaned);
  if (!m) return undefined;
  const n = parseNumberRun(m[0]);
  if (!Number.isFinite(n)) return undefined;
  const rest = cleaned.slice(m.index + m[0].length);
  return { n, more: NUMBER_RUN.test(rest) };
}

const sameNumber = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

// ---- dates ----

const pad = (n) => String(n).padStart(2, '0');
const validDate = (y, m, d) => {
  const text = `${y}-${pad(m)}-${pad(d)}`;
  return new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text ? text : undefined;
};

/** A date as YYYY-MM-DD; a date without a year takes the gold year. */
export function parseDate(value, goldYear) {
  const text = norm(value);
  let m = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/.exec(text);
  if (m) {
    const date = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return date ? { date, method: 'date' } : undefined;
  }
  m = /(?<!\d)(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?(?!\d)/.exec(text);
  if (m && goldYear) {
    const date = validDate(goldYear, Number(m[1]), Number(m[2]));
    return date ? { date, method: `date:no-year-assumed-${goldYear}` } : undefined;
  }
  return undefined;
}

// ---- options ----

function parseOption(value, options) {
  const text = norm(value);
  const letters = Object.keys(options);
  const byText = letters.find((letter) => norm(options[letter]) === text);
  if (byText) return { letter: byText, method: 'option:text' };
  const m = /^(?:选项|选)?\s*[(（[【]?\s*([A-Za-z])\s*[)）\]】]?(?=$|[\s.、:：,，。]|[^\x00-\x7f])/.exec(text);
  const standalone = [...new Set((text.match(/(?<![A-Za-z])[A-Z](?![A-Za-z])/g) ?? []))];
  if (m) {
    const letter = m[1].toUpperCase();
    if (standalone.filter((l) => letters.includes(l) && l !== letter).length) return { letter: null, method: 'option:several' };
    return { letter, method: 'option:letter' };
  }
  if (standalone.length > 1) return { letter: null, method: 'option:several' };
  if (standalone.length === 1) return { letter: standalone[0], method: 'option:letter-in-text' };
  return undefined;
}

function parseMulti(value) {
  const text = norm(value);
  if (/^(\[\s*\]|无|没有|都没有|一个都没有|none)$/i.test(text.replace(/[。.]$/, ''))) return { letters: [], method: 'multi:empty' };
  try {
    const parsed = JSON.parse(text.replace(/'/g, '"'));
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return { letters: [...new Set(parsed.map((x) => x.trim().toUpperCase()))].sort(), method: 'multi:json' };
    }
  } catch { /* not JSON */ }
  const tokens = text.replace(/^[[(（【]|[\])）】]$/g, '').split(/[\s,，、;；]+|和|与|及/).map((t) => t.replace(/["'“”「」]/g, '').trim()).filter(Boolean);
  if (tokens.length && tokens.every((t) => /^[A-Za-z]$/.test(t))) return { letters: [...new Set(tokens.map((t) => t.toUpperCase()))].sort(), method: 'multi:list' };
  return undefined;
}

// ---- provenance ----

function whoOf(text) {
  const m = /^(?:助手\s*|assistant[\s_-]*)?([ABC])$/i.exec(norm(text));
  return m ? m[1].toUpperCase() : undefined;
}
function kindOf(text) {
  const t = norm(text).toLowerCase();
  if (/^(user|用户|用户说的|用户原话|原话|用户说)$/.test(t)) return 'user';
  if (/^(inference|推测|助手推测|推断|agent|assistant|agent_response|助手记下)$/.test(t)) return 'inference';
  return undefined;
}
function parseProvenance(value, goldYear) {
  const text = norm(value).replace(/[“”]/g, '"');
  let object;
  try {
    object = JSON.parse(text.replace(/'/g, '"'));
  } catch { /* not JSON */ }
  if (object && typeof object === 'object' && !Array.isArray(object)) {
    const date = typeof object.date === 'string' ? parseDate(object.date, goldYear)?.date : undefined;
    return { who: typeof object.who === 'string' ? whoOf(object.who) : undefined, date, kind: typeof object.kind === 'string' ? kindOf(object.kind) : undefined, method: 'provenance:json' };
  }
  const who = (/(?:who|助手)[^A-Za-z0-9]{0,5}([ABC])(?![A-Za-z])/i.exec(text) ?? /assistant[\s_-]*([abc])(?![a-z])/i.exec(text))?.[1]?.toUpperCase();
  const date = parseDate(text, goldYear)?.date;
  const kind = /inference|推测|推断/i.test(text) ? 'inference' : /user|用户/i.test(text) ? 'user' : undefined;
  if (!who && !date && !kind) return undefined;
  return { who, date, kind, method: 'provenance:text' };
}

// ---- scoring ----

const result = (outcome, value, normalized, method, extra = {}) => ({ outcome, value, normalized, method, ...extra });

/** Scores a reply against a gold answer. */
export function score(answer, reply) {
  const value = extractAnswer(reply);
  if (value === undefined || value === '') return result('unparseable', value ?? null, null, 'no ANSWER line');
  if (isUnknown(value)) return result(answer.type === 'unknown' ? 'correct' : 'unknown', value, 'UNKNOWN', 'unknown');
  const type = answer.type === 'unknown' ? (answer.as ?? 'number') : answer.type;
  const goldYear = Number(/^(\d{4})/.exec(answer.value ?? answer.date ?? '')?.[1]) || undefined;
  if (type === 'number') {
    const parsed = parseNumber(value);
    if (!parsed) return result('unparseable', value, null, 'number:none');
    if (answer.type === 'unknown') return result('wrong', value, parsed.n, 'number');
    const outcome = sameNumber(parsed.n, Number(answer.value)) ? 'correct'
      : (answer.stale ?? []).some((s) => sameNumber(parsed.n, Number(s))) ? 'stale' : 'wrong';
    const extra = parsed.more ? { review: 'several numbers' } : {};
    if (outcome === 'wrong' && (answer.confused ?? []).some((c) => sameNumber(parsed.n, Number(c)))) extra.detail = 'confused';
    return result(outcome, value, parsed.n, 'number', extra);
  }
  if (type === 'date') {
    const parsed = parseDate(value, goldYear ?? 2026);
    if (!parsed) return result('unparseable', value, null, 'date:none');
    if (answer.type === 'unknown') return result('wrong', value, parsed.date, parsed.method);
    const outcome = parsed.date === answer.value ? 'correct' : (answer.stale ?? []).includes(parsed.date) ? 'stale' : 'wrong';
    return result(outcome, value, parsed.date, parsed.method);
  }
  if (type === 'option') {
    const parsed = parseOption(value, answer.options ?? {});
    if (!parsed) return result('unparseable', value, null, 'option:none');
    if (parsed.letter === null || answer.type === 'unknown' || !(parsed.letter in (answer.options ?? {}))) return result('wrong', value, parsed.letter, parsed.method);
    const outcome = parsed.letter === answer.value ? 'correct' : (answer.stale ?? []).includes(parsed.letter) ? 'stale' : 'wrong';
    return result(outcome, value, parsed.letter, parsed.method, outcome === 'wrong' && (answer.confused ?? []).includes(parsed.letter) ? { detail: 'confused' } : {});
  }
  if (type === 'multi') {
    const parsed = parseMulti(value);
    if (!parsed) return result('unparseable', value, null, 'multi:none');
    const valid = parsed.letters.every((l) => l in (answer.options ?? {}));
    const gold = [...answer.value].sort();
    const outcome = valid && answer.type !== 'unknown' && JSON.stringify(parsed.letters) === JSON.stringify(gold) ? 'correct' : 'wrong';
    return result(outcome, value, parsed.letters, parsed.method);
  }
  if (type === 'provenance') {
    const parsed = parseProvenance(value, goldYear ?? 2026);
    if (!parsed) return result('unparseable', value, null, 'provenance:none');
    const fields = { who: parsed.who ?? null, date: parsed.date ?? null, kind: parsed.kind ?? null };
    const outcome = answer.type !== 'unknown' && fields.who === answer.who && fields.date === answer.date && fields.kind === answer.kind ? 'correct' : 'wrong';
    return result(outcome, value, fields, parsed.method);
  }
  throw new Error(`unknown answer type ${answer.type}`);
}

// ---- review ----

const IDS = /\b(?:evt|acc|rev|ent|stm|rv)_[A-Za-z0-9_]+/g;
const ARM_WORDS = /event_note|event_record_expression|event_get_protocol|event_search|event_get_revisions|event_words_since|event_undo_revision|event_add_parent|event_remove_parent|context_pack|entity_[a-z_]+|notes_[a-z_]+|memory|index\.md|事情库|事情目录|记忆条目|笔记文件夹|条目|文件/g;

/** A review packet entry from which the arm cannot be told. */
export function reviewEntry({ id, question, answer, reply }) {
  const clean = (text) => String(text ?? '').replace(IDS, '[…]').replace(ARM_WORDS, '[…]');
  return { id, question: clean(question), type: answer.type, options: answer.options ?? null, gold: answer, reply: clean(reply) };
}

