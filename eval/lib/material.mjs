// The experiment's material, the same for every command: every template expanded, and the
// background library with every template's keywords (as the variants fill them in, from
// every split) reserved, so that dev and formal cases share one library.
import { fileURLToPath } from 'node:url';
import { generateLibrary } from './library.mjs';
import { expandAll, loadTemplates } from './templates.mjs';

export const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
export const SPLITS = ['dev', 'formal'];
export const LIBRARY_SEED = 20261104;

export function material(splits = SPLITS) {
  const all = loadTemplates(TEMPLATES, SPLITS);
  const every = expandAll(all);
  const cases = every.filter((c) => splits.includes(c.split));
  const reserved = [...new Set(every.flatMap((c) => c.keywords))].sort();
  const library = generateLibrary({ seed: LIBRARY_SEED, reserved });
  return { all, cases, library, reserved };
}
