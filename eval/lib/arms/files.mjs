// T2: plain-text memory as a folder of Markdown files, one per matter, with index.md listing
// them. index.md is in the system prompt when a conversation starts; tools view, search,
// create, edit a passage of, and append to files. The model keeps the index up to date.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX, renderFiles } from '../render.mjs';
import { writeFileAtomic } from '../util.mjs';

const FOLDER = 'notes';
const MAX_RESULTS = 10;
const LINES_PER_FILE = 3;
const LINE_CHARS = 200;

const path = { type: 'string', description: '文件名，比如 "index.md"；文件都在同一个文件夹里，没有子文件夹。' };
const tool = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const TOOLS = [
  tool('notes_view', '看一个文件的全文。', { path }, ['path']),
  tool('notes_search', '按词在全部文件里找：返回同时包含这些词的文件（词之间用空格隔开，不分大小写），和每个文件里含有这些词的几行。', {
    query: { type: 'string', description: '要找的词。' },
  }, ['query']),
  tool('notes_create', '新建一个文件。文件已经存在就报错。', { path, content: { type: 'string', description: '文件的全部内容。' } }, ['path', 'content']),
  tool('notes_str_replace', '把一个文件里的一段原文换成新文字。那段原文在文件里必须只出现一次。', {
    path, old_str: { type: 'string', description: '要换掉的原文，一字不差。' }, new_str: { type: 'string', description: '换成的文字。' },
  }, ['path', 'old_str', 'new_str']),
  tool('notes_append', '在一个文件的末尾追加文字（自动另起一行）。', { path, content: { type: 'string', description: '追加的文字。' } }, ['path', 'content']),
];
const NAMES = new Set(TOOLS.map((t) => t.function.name));
/** The tools of an assistant that only records (modes light and organized): no changes to text already written. */
export const RECORD_ONLY_TOOLS = TOOLS.filter((t) => t.function.name !== 'notes_str_replace');
const RECORD_ONLY_NAMES = new Set(RECORD_ONLY_TOOLS.map((t) => t.function.name));

/** Every .md file of a folder and its content. */
const snapshotOf = (folder) => Object.fromEntries(readdirSync(folder).filter((n) => n.endsWith('.md')).sort().map((n) => [n, readFileSync(join(folder, n), 'utf8')]));

/**
 * What changed in a folder since `before`: files created, text appended at the end of a file,
 * and files changed otherwise (shown whole). The assistants only create and append, so the last
 * kind is a safeguard.
 */
export function folderChanges(before, now) {
  const changes = [];
  for (const [name, content] of Object.entries(now)) {
    const old = before[name];
    if (old === undefined) changes.push({ name, kind: 'created', text: content });
    else if (content === old) continue;
    else if (content.startsWith(old)) changes.push({ name, kind: 'appended', text: content.slice(old.length).replace(/^\n+/, '') });
    else changes.push({ name, kind: 'changed', text: content });
  }
  return changes;
}
const CHANGE_LABELS = { created: '新建', appended: '末尾追加', changed: '改过，全文' };

const fail = (text) => ({ text: `出错：${text}`, isError: true });
const ok = (text) => ({ text, isError: false });
// A file name the file system takes: at most 200 bytes, so that the temporary name of an atomic write fits too.
const MAX_NAME_BYTES = 200;
const tooLong = (name) => typeof name === 'string' && Buffer.byteLength(name) > MAX_NAME_BYTES;
const safe = (name) => typeof name === 'string' && /^[^/\\\u0000-\u001f]+\.md$/.test(name) && !name.startsWith('.') && !tooLong(name);
const occurrences = (text, part) => {
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count += 1;
  return count;
};

/** The five tools on a folder. */
export function notesTools(folder) {
  const file = (name) => join(folder, name);
  const read = (name) => readFileSync(file(name), 'utf8');
  const exists = (name) => safe(name) && existsSync(file(name));
  const missing = (name) => fail(`没有 ${name} 这个文件。文件列表在 index.md 里。`);
  return {
    notes_view({ path: name }) {
      if (!safe(name)) return fail('path 要是一个 .md 文件名。');
      return exists(name) ? ok(read(name)) : missing(name);
    },
    notes_search({ query }) {
      if (typeof query !== 'string' || !query.trim()) return fail('query 要给要找的词。');
      const words = query.trim().toLowerCase().split(/\s+/u);
      const hits = [];
      for (const name of readdirSync(folder).filter((n) => n.endsWith('.md')).sort()) {
        const text = read(name);
        const lower = text.toLowerCase();
        if (!words.every((w) => lower.includes(w))) continue;
        const score = words.reduce((n, w) => n + occurrences(lower, w), 0);
        const lines = text.split('\n').filter((line) => words.some((w) => line.toLowerCase().includes(w))).slice(0, LINES_PER_FILE)
          .map((line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line));
        hits.push({ name, score, lines });
      }
      if (hits.length === 0) return ok(`没有文件同时包含：${words.join('、')}。`);
      hits.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
      const shown = hits.slice(0, MAX_RESULTS);
      const more = hits.length > shown.length ? `\n（还有 ${hits.length - shown.length} 个文件也包含，换更具体的词试试。）` : '';
      return ok(`${shown.map((h) => `${h.name}\n${h.lines.map((l) => `  ${l}`).join('\n')}`).join('\n\n')}${more}`);
    },
    notes_create({ path: name, content }) {
      if (tooLong(name)) return fail('文件名太长了，起一个短一点的。');
      if (!safe(name)) return fail('path 要是一个 .md 文件名，不能带斜杠。');
      if (typeof content !== 'string') return fail('content 要给文件内容。');
      if (exists(name)) return fail(`${name} 已经存在；要改它，用 notes_str_replace 或 notes_append。`);
      writeFileAtomic(file(name), content.endsWith('\n') ? content : `${content}\n`, 0o600);
      return ok(`已新建 ${name}。`);
    },
    notes_str_replace({ path: name, old_str: before, new_str: after }) {
      if (!safe(name)) return fail('path 要是一个 .md 文件名。');
      if (!exists(name)) return missing(name);
      if (typeof before !== 'string' || !before) return fail('old_str 要给要换掉的原文。');
      if (typeof after !== 'string') return fail('new_str 要给换成的文字。');
      const text = read(name);
      const n = occurrences(text, before);
      if (n === 0) return fail(`${name} 里没找到这段原文。原文要一字不差。`);
      if (n > 1) return fail(`这段原文在 ${name} 里出现了 ${n} 次，多写几个字，让它只出现一次。`);
      writeFileAtomic(file(name), text.replace(before, () => after), 0o600);
      return ok(`已替换 ${name} 里的这一段。`);
    },
    notes_append({ path: name, content }) {
      if (!safe(name)) return fail('path 要是一个 .md 文件名。');
      if (!exists(name)) return missing(name);
      if (typeof content !== 'string' || !content) return fail('content 要给追加的文字。');
      const text = read(name);
      appendFileSync(file(name), `${text.endsWith('\n') ? '' : '\n'}${content}${content.endsWith('\n') ? '' : '\n'}`);
      return ok(`已追加到 ${name} 末尾。`);
    },
  };
}

export const view = (index) => `## 笔记文件夹的 index.md\n\n这次对话开始时的内容：\n\n${index.trimEnd()}`;

export default {
  name: 'T2',
  /** A tool call as it is counted in a pilot: whether it was on index.md. */
  label: (name, args) => (args?.path === INDEX ? `${name}:index` : name),
  /** Writes the starting store: a file per matter and index.md. */
  prepare(directory, matters) {
    const folder = join(directory, FOLDER);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const { files, index } = renderFiles(matters);
    for (const [name, content] of Object.entries(files)) writeFileAtomic(join(folder, name), content, 0o600);
    writeFileAtomic(join(folder, INDEX), index, 0o600);
    return {};
  },
  /**
   * Opens the store for one conversation. An assistant that only records (mode light or
   * organized) may view, search, create and append, not replace; the organizer, and an
   * assistant in mode inline, has every tool.
   */
  async open(directory, { mode = 'inline', role = 'assistant' } = {}) {
    const folder = join(directory, FOLDER);
    const tools = notesTools(folder);
    const recordOnly = mode !== 'inline' && role !== 'organizer';
    const names = recordOnly ? RECORD_ONLY_NAMES : NAMES;
    const index = existsSync(join(folder, INDEX)) ? readFileSync(join(folder, INDEX), 'utf8') : '';
    return {
      tools: recordOnly ? RECORD_ONLY_TOOLS : TOOLS,
      view: view(index),
      has: (name) => names.has(name),
      call: async (name, args) => tools[name](args ?? {}),
      close: async () => {},
    };
  },
  /** The organizer's starting point: the folder as it is before the first night. */
  organizeStart(directory) {
    return { files: snapshotOf(join(directory, FOLDER)) };
  },
  /** The organizer's message: the files created or added to since the last night; null when there are none. */
  organizeMessage(directory, state, { date }) {
    const changes = folderChanges(state.files, snapshotOf(join(directory, FOLDER)));
    if (changes.length === 0) return null;
    const parts = changes.map((c) => `=== ${c.name}（${CHANGE_LABELS[c.kind]}）===\n${c.text.trimEnd()}`);
    return `现在是 ${date} 夜里，整理上次整理以后新记的话。上次整理以后新建或追加了这些文件：\n\n${parts.join('\n\n')}`;
  },
  /** After a night: what the organizer left is the next night's starting point. */
  organizeDone(directory, state) {
    state.files = snapshotOf(join(directory, FOLDER));
  },
  dump(directory) {
    const folder = join(directory, FOLDER);
    return readdirSync(folder).filter((n) => n.endsWith('.md')).sort((a, b) => (a === INDEX ? -1 : b === INDEX ? 1 : a < b ? -1 : 1))
      .map((n) => `=== ${n} ===\n${readFileSync(join(folder, n), 'utf8')}`).join('\n');
  },
};
