// The system prompt of every conversation: the shared instructions (word for word the same in
// every arm), the arm's paragraph on how to use its store, the date and which assistant this
// is, and what the store injects at the start. The prompt files are hashed into every run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_IDS } from './p-writer.mjs';
import { sha256, weekday } from './util.mjs';

const DIR = fileURLToPath(new URL('../prompts/', import.meta.url));
const FILES = { shared: 'shared.md', P: 'p.md', T1: 't1.md', T2: 't2.md' };

export function loadPrompts(directory = DIR) {
  const texts = Object.fromEntries(Object.entries(FILES).map(([part, file]) => [part, readFileSync(`${directory}/${file}`, 'utf8').trim()]));
  return { ...texts, hashes: Object.fromEntries(Object.entries(texts).map(([part, text]) => [part, sha256(text)])) };
}

/** The system prompt for one conversation in `arm`. */
export function systemPrompt(prompts, arm, { date, time, assistant, view }) {
  const paragraph = prompts[arm].replaceAll('{assistant}', assistant).replaceAll('{client}', ASSISTANT_IDS[assistant]);
  return [
    prompts.shared,
    paragraph,
    `## 现在\n\n今天是 ${date}（${weekday(date)}），北京时间 ${time}。你是助手 ${assistant}。`,
    view,
  ].join('\n\n');
}
