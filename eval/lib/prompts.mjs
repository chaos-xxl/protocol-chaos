// The system prompt of every conversation: the shared instructions (word for word the same in
// every arm), the arm's paragraph on how to use its store, the date and which assistant this
// is, and what the store injects at the start. The prompt files are hashed into every run.
//
// Three ways of writing (modes). inline: the assistant records the words and brings the
// matter's current state up to date in the same conversation. light: the assistant only
// adds the words, it cannot change what the store holds. organized: as light, and every night
// an organizer folds the new words into the current state. The organizer has its own shared
// instructions and its own paragraph per arm.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_IDS } from './p-writer.mjs';
import { sha256, weekday } from './util.mjs';
const DIR = fileURLToPath(new URL('../prompts/', import.meta.url));
const FILES = {
  shared: 'shared.md', P: 'p.md', T1: 't1.md', T2: 't2.md',
  sharedLight: 'shared-light.md', PLight: 'p-light.md', T1Light: 't1-light.md', T2Light: 't2-light.md',
  organizer: 'organizer.md', POrganizer: 'p-organizer.md', T1Organizer: 't1-organizer.md', T2Organizer: 't2-organizer.md',
};
export const MODES = ['inline', 'light', 'organized'];
/** The organizer's client name in P, and its name in the prompts. */
export const ORGANIZER_ID = 'organizer';
export function loadPrompts(directory = DIR) {
  const texts = Object.fromEntries(Object.entries(FILES).map(([part, file]) => [part, readFileSync(`${directory}/${file}`, 'utf8').trim()]));
  return { ...texts, hashes: Object.fromEntries(Object.entries(texts).map(([part, text]) => [part, sha256(text)])) };
}
/** The system prompt for one conversation in `arm`: an assistant's in `mode`, or the organizer's (`role` "organizer"). */
export function systemPrompt(prompts, arm, { date, time, assistant, view, mode = 'inline', role = 'assistant' }) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  const organizing = role === 'organizer';
  const shared = organizing ? prompts.organizer : mode === 'inline' ? prompts.shared : prompts.sharedLight;
  const part = organizing ? `${arm}Organizer` : mode === 'inline' ? arm : `${arm}Light`;
  const client = organizing ? ORGANIZER_ID : ASSISTANT_IDS[assistant];
  const paragraph = prompts[part].replaceAll('{assistant}', assistant ?? '').replaceAll('{client}', client);
  const who = organizing ? '你是整理助手。' : `你是助手 ${assistant}。`;
  return [
    shared,
    paragraph,
    `## 现在\n\n今天是 ${date}（${weekday(date)}），北京时间 ${time}。${who}`,
    view,
  ].join('\n\n');
}
