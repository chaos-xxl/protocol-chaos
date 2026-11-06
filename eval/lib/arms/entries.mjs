// T1: plain-text memory as a list of entries, like the built-in memory of Hermes Agent. Every
// entry is in the system prompt when a conversation starts; one tool adds an entry, replaces
// a passage of one, or removes one. There is no size limit and no tool to read: what the
// conversation changed, the model learns from the tool's answers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEntries } from '../render.mjs';
import { writeJson } from '../util.mjs';

const FILE = 'entries.json';
export const DELIMITER = '\n§\n';

export const TOOLS = [{
  type: 'function',
  function: {
    name: 'memory',
    description: '改记忆条目。add 新增一条；replace 把一条里的一段原文换成新文字；remove 删掉一整条。改动立即保存，下次对话开始时就在记忆里。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove'] },
        content: { type: 'string', description: 'add：新条目的全部内容。' },
        old_text: { type: 'string', description: 'replace、remove：条目里的一段原文，只能找到一处。' },
        new_text: { type: 'string', description: 'replace：换成的文字。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
}];

/** The tool of an assistant that only records (modes light and organized): add only. */
export const ADD_ONLY_TOOLS = [{
  type: 'function',
  function: {
    name: 'memory',
    description: '新增一条记忆条目。只能新增，不能改或删已有的条目。新增立即保存，下次对话开始时就在记忆里。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add'] },
        content: { type: 'string', description: '新条目的全部内容。' },
      },
      required: ['action', 'content'],
      additionalProperties: false,
    },
  },
}];

const occurrences = (text, part) => {
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count += 1;
  return count;
};
const fail = (text) => ({ text: `出错：${text}`, isError: true });

/** The tool on a list of entries, saved through `save` after each change. */
export function memoryTool(entries, save) {
  return (args) => {
    const { action } = args ?? {};
    if (action === 'add') {
      if (typeof args.content !== 'string' || !args.content.trim()) return fail('add 要给 content：新条目的内容。');
      entries.push(args.content.trim());
      save();
      return { text: `已新增一条。现在共 ${entries.length} 条。`, isError: false };
    }
    if (action !== 'replace' && action !== 'remove') return fail('action 只能是 add、replace 或 remove。');
    if (typeof args.old_text !== 'string' || !args.old_text) return fail(`${action} 要给 old_text：条目里的一段原文。`);
    const hits = entries.map((entry, index) => ({ index, n: occurrences(entry, args.old_text) })).filter((hit) => hit.n > 0);
    const total = hits.reduce((n, hit) => n + hit.n, 0);
    if (total === 0) return fail('没找到这段原文。原文要和条目里的一字不差。');
    if (action === 'remove') {
      if (hits.length > 1) return fail(`这段原文出现在 ${hits.length} 条里，多写几个字，让它只指向一条。`);
      const [removed] = entries.splice(hits[0].index, 1);
      save();
      return { text: `已删除这一条：\n${removed}`, isError: false };
    }
    if (typeof args.new_text !== 'string') return fail('replace 要给 new_text：换成的文字。');
    if (total > 1) return fail(`这段原文出现了 ${total} 次（在 ${hits.length} 条里），多写几个字，让它只出现一次。`);
    const { index } = hits[0];
    const changed = entries[index].replace(args.old_text, () => args.new_text);
    if (!changed.trim()) return fail('换完这一条就空了；要删整条，用 remove。');
    entries[index] = changed;
    save();
    return { text: `已替换。这一条现在是：\n${changed}`, isError: false };
  };
}

/**
 * The entries of `now` that `before` did not hold. The assistants only add, so `before` is a
 * prefix of `now`; should it not be, every entry `before` does not hold as many times is new.
 */
export function addedEntries(before, now) {
  if (before.length <= now.length && before.every((entry, i) => entry === now[i])) return now.slice(before.length);
  const left = new Map();
  for (const entry of before) left.set(entry, (left.get(entry) ?? 0) + 1);
  return now.filter((entry) => {
    const n = left.get(entry) ?? 0;
    if (n > 0) {
      left.set(entry, n - 1);
      return false;
    }
    return true;
  });
}

export function view(entries) {
  if (entries.length === 0) return '## 记忆\n\n（还没有任何条目）';
  return `## 记忆\n\n这次对话开始时的全部条目，共 ${entries.length} 条，条目之间用 § 隔开：\n\n${entries.join(DELIMITER)}`;
}

export default {
  name: 'T1',
  /** A tool call as it is counted in a pilot: memory with its action. */
  label: (name, args) => (name === 'memory' ? `memory:${typeof args?.action === 'string' ? args.action : '?'}` : name),
  /** Writes the starting store: one entry per matter. */
  prepare(directory, matters) {
    writeJson(join(directory, FILE), { entries: renderEntries(matters) }, 0o600);
    return {};
  },
  /**
   * Opens the store for one conversation. An assistant that only records (mode light or
   * organized) may only add entries; the organizer, and an assistant in mode inline, may change any.
   */
  async open(directory, { mode = 'inline', role = 'assistant' } = {}) {
    const file = join(directory, FILE);
    const load = () => JSON.parse(readFileSync(file, 'utf8')).entries;
    const addOnly = mode !== 'inline' && role !== 'organizer';
    // The system prompt holds the entries as they were when the conversation started; each change is made to the
    // entries as they are now, so a change by another conversation in between is never written over.
    const injected = view(load());
    return {
      tools: addOnly ? ADD_ONLY_TOOLS : TOOLS,
      view: injected,
      has: (name) => name === 'memory',
      call: async (name, args) => {
        if (addOnly && args?.action !== 'add') return fail('只能新增（action 用 add），不能改或删已有的条目。');
        const entries = load();
        return memoryTool(entries, () => writeJson(file, { entries }, 0o600))(args);
      },
      close: async () => {},
    };
  },
  /** The organizer's starting point: the entries as they are before the first night. */
  organizeStart(directory) {
    return { entries: JSON.parse(readFileSync(join(directory, FILE), 'utf8')).entries };
  },
  /** The organizer's message: the entries added since the last night; null when there are none. */
  organizeMessage(directory, state, { date }) {
    const now = JSON.parse(readFileSync(join(directory, FILE), 'utf8')).entries;
    const fresh = addedEntries(state.entries, now);
    if (fresh.length === 0) return null;
    return `现在是 ${date} 夜里，整理上次整理以后新记的话。上次整理以后新增了 ${fresh.length} 条：\n\n${fresh.join(DELIMITER)}`;
  },
  /** After a night: what the organizer left is the next night's starting point. */
  organizeDone(directory, state) {
    state.entries = JSON.parse(readFileSync(join(directory, FILE), 'utf8')).entries;
  },
  /** The whole store as text, for the review of a run. */
  dump(directory) {
    return JSON.parse(readFileSync(join(directory, FILE), 'utf8')).entries.join(DELIMITER);
  },
};
