// PersistBench (Pulipaka et al., ICML 2026) under five ways of giving a model the user's
// memories. Every sample is answered by the model under test in every condition, and the answer
// is scored by a judge with PersistBench's own prompts and thresholds. See README.md.
//
//   flat       PersistBench as published: every memory, as a list, in the system prompt.
//   partition  the same memories under domain headings (the dynamic classifier of Zhao et al.,
//              "Mitigating Over-Personalization in LLMs via Structured Memory", 2026).
//   retrieval  only the memories whose embedding is similar enough to the query's.
//   files      no memory in the prompt, an index of memory files by domain, and a tool to read one.
//   protocol   the same index, the memories kept as Statements on the user's own Entity of a
//              Protocol Chaos reference server, read with the server's entity_get by topic.
//
// partition, files and protocol use the same grouping of each sample's memories.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clients } from '../../server/clients.mjs';
import { Repository } from '../../server/repository.mjs';
import { connect, startServer, stopServer } from '../lib/arms/protocol.mjs';
import { ENGLISH_TEXTS, converse, totals } from '../lib/session.mjs';
import { sha256, writeFileAtomic } from '../lib/util.mjs';

export const EXTERNAL = fileURLToPath(new URL('../external/', import.meta.url));
export const CONDITIONS = ['flat', 'partition', 'retrieval', 'files', 'protocol'];
export const TYPES = ['cross_domain', 'beneficial_memory_usage'];
export const PREDEFINED_DOMAINS = ['health', 'identity', 'social', 'romantic', 'personal', 'education', 'employment', 'finance', 'housing', 'legal', 'schedule'];
/** Similarity at or above which a memory is retrieved (as in Zhao et al.). */
export const RETRIEVAL_THRESHOLD = 0.5;
/** Generations per sample, as PersistBench: three for leakage, of which the worst counts; one for beneficial use. */
export const EPOCHS = { cross_domain: 3, beneficial_memory_usage: 1 };
/** The longest Statement the protocol takes. */
export const STATEMENT_MAX = 200;
const FILES = {
  cross_domain: 'persistbench/samples/cross_domain.jsonl',
  beneficial_memory_usage: 'persistbench/samples/beneficial_samples.jsonl',
};

// ---- samples and prompts ----

/** A sample's id: stable over runs, from its memories and its query. */
export const sampleId = (memories, query) => `pb-${sha256(`${[...memories].sort().join('\u0000')}\u0001${query}`).slice(0, 12)}`;

/** The samples of the given types, in file order. */
export function loadSamples(types = TYPES, directory = EXTERNAL) {
  return types.flatMap((type) => readFileSync(join(directory, FILES[type]), 'utf8').split('\n').filter((line) => line.trim()).map((line, index) => {
    const r = JSON.parse(line);
    if (r.failure_type !== type) throw new Error(`${FILES[type]} line ${index + 1}: failure_type ${r.failure_type}`);
    if (!Array.isArray(r.memories) || r.memories.length === 0 || typeof r.query !== 'string' || !r.query.trim()) throw new Error(`${FILES[type]} line ${index + 1}: not a sample`);
    return { id: sampleId(r.memories, r.query), type, index, memories: r.memories, query: r.query };
  }));
}

/** The hashes of the sample files, for the manifest. */
export const sampleHashes = (directory = EXTERNAL) => Object.fromEntries(Object.entries(FILES).map(([type, file]) => [type, sha256(readFileSync(join(directory, file), 'utf8'))]));

/** PersistBench's generator and judge prompts, and the classifier prompt. */
export function loadPrompts(directory = EXTERNAL) {
  const read = (file) => readFileSync(join(directory, file), 'utf8');
  const prompts = {
    generator: read('persistbench/GENERATOR_SYSTEM_PROMPT.txt'),
    judge: {
      cross_domain: { system: read('persistbench/JUDGE_SYSTEM_PROMPT_SINGLE_CROSS_DOMAIN.txt'), field: 'score', min: 1, max: 5 },
      beneficial_memory_usage: { system: read('persistbench/JUDGE_SYSTEM_PROMPT_SINGLE_POSITIVE_MEMORY.txt'), field: 'rating', min: 1, max: 3 },
    },
    classifier: read('structured-memory/dynamic-classifier.txt'),
  };
  if (!prompts.generator.includes('{memories}')) throw new Error('the generator prompt has no {memories}');
  prompts.hashes = {
    generator: sha256(prompts.generator),
    judgeCrossDomain: sha256(prompts.judge.cross_domain.system),
    judgeBeneficial: sha256(prompts.judge.beneficial_memory_usage.system),
    classifier: sha256(prompts.classifier),
  };
  return prompts;
}

/** Memories as PersistBench formats them, for the prompt and for the judge. */
export const formatMemories = (memories) => `<memories>\n${memories.map((m) => `- ${m}`).join('\n')}\n</memories>`;

// ---- the grouping by domain (partition, files, protocol) ----

const normalize = (text) => String(text).toLowerCase().replace(/[\s"'“”‘’`]+/g, ' ').replace(/[.。]\s*$/, '').trim();
const domainName = (key) => (/^[a-z_]{3,15}$/.test(key) ? key : null);

/**
 * Reads the classifier's answer into a grouping of memory indices. Every memory goes in exactly
 * one domain: a memory the answer names twice keeps its first domain; a memory it does not name
 * is reported as missing. Keys that are not domain names are dropped, with their memories.
 */
export function parseGrouping(text, memories) {
  const data = extractJson(text, { lenient: true });
  const exact = new Map(memories.map((m, i) => [m, i]));
  const loose = new Map(memories.map((m, i) => [normalize(m), i]));
  const groups = {};
  const seen = new Set();
  let unmatched = 0;
  for (const [key, list] of Object.entries(data)) {
    const domain = domainName(key);
    if (!domain || !Array.isArray(list)) continue;
    for (const item of list) {
      const index = exact.get(item) ?? loose.get(normalize(item));
      if (index === undefined) {
        unmatched += 1;
        continue;
      }
      if (seen.has(index)) continue;
      seen.add(index);
      (groups[domain] ??= []).push(index);
    }
  }
  const missing = memories.map((_, i) => i).filter((i) => !seen.has(i));
  return { groups, missing, unmatched };
}

/** Groups a sample's memories with the classifier model; after `attempts` tries, what is left goes to personal. */
export async function classify({ provider, prompts, memories, attempts = 3 }) {
  const user = `Memories:\n${JSON.stringify(memories, null, 1)}`;
  let best = null;
  const usage = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await provider.complete([{ role: 'system', content: prompts.classifier }, { role: 'user', content: user }], []);
    usage.push(response.usage);
    let parsed;
    try {
      parsed = parseGrouping(response.message.content ?? '', memories);
    } catch {
      continue;
    }
    if (!best || parsed.missing.length < best.missing.length) best = parsed;
    if (parsed.missing.length === 0) break;
  }
  const groups = best?.groups ?? {};
  const fallback = best ? best.missing : memories.map((_, i) => i);
  if (fallback.length) (groups.personal ??= []).push(...fallback);
  // Domains in the classifier's order, memories in the sample's order within a domain.
  for (const list of Object.values(groups)) list.sort((a, b) => a - b);
  return { groups, fallback, attempts: usage.length, usage };
}

// ---- retrieval ----

/** The cosine similarity of two vectors. */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Embeds texts with an OpenAI-compatible embeddings endpoint (`model` as in the model list). */
export async function embed(model, texts, { env = process.env, fetchImpl = fetch } = {}) {
  const key = model.apiKeyEnv ? env[model.apiKeyEnv] : undefined;
  if (model.apiKeyEnv && !key) throw new Error(`model ${model.id}: the environment variable ${model.apiKeyEnv} is not set`);
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(model.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(model.timeoutMs ?? 60_000),
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: model.model, input: texts }),
    }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));
    if (response.ok) {
      const data = await response.json();
      return data.data.sort((x, y) => x.index - y.index).map((d) => d.embedding);
    }
    if (attempt >= 5) throw new Error(`model ${model.id}: embeddings failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

/** The similarity of each memory to the query. */
export async function similarities(model, sample, options) {
  const [query, ...memories] = await embed(model, [sample.query, ...sample.memories], options);
  return memories.map((m) => cosine(query, m));
}

// ---- the five conditions ----

const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);
const fileOf = (domain) => `${domain}.md`;

/** A Statement for each sentence group of a memory: at most STATEMENT_MAX characters each, split at sentences, then clauses, then words. */
export function splitStatement(text, max = STATEMENT_MAX) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return [trimmed];
  const pack = (pieces, joiner) => {
    const out = [];
    for (const piece of pieces) {
      if (out.length && (out.at(-1) + joiner + piece).length <= max) out[out.length - 1] += joiner + piece;
      else out.push(piece);
    }
    return out;
  };
  const sentences = trimmed.split(/(?<=[.!?;])\s+/u);
  return pack(sentences, ' ').flatMap((chunk) => {
    if (chunk.length <= max) return [chunk];
    return pack(chunk.split(/(?<=,)\s+/u), ' ').flatMap((part) => {
      if (part.length <= max) return [part];
      const words = pack(part.split(/\s+/u), ' ');
      return words.flatMap((w) => (w.length <= max ? [w] : w.match(new RegExp(`.{1,${max}}`, 'gsu'))));
    });
  });
}

/** The protocol's reading tools for the user's Entity; the writing tools of the group are not offered. */
export const PROTOCOL_READ_TOOLS = ['entity_get', 'entity_search'];

const NO_TOOLS = { tools: [], has: () => false, call: async () => ({ text: 'Error: no tools.', isError: true }), close: async () => {} };

const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_memory_file',
    description: 'Read one memory file: every memory it holds, one per line.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The file name, as the index lists it, for example "health.md".' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

/** The domains of a grouping with their memories, in the classifier's order. */
const domainsOf = (sample, grouping) => Object.entries(grouping.groups).filter(([, list]) => list.length).map(([domain, list]) => ({ domain, memories: list.map((i) => sample.memories[i]) }));

/** Writes a reference server's store with the user's own Entity, a Statement per piece of each memory, by domain. */
export function writeProtocolStore(directory, sample, grouping) {
  const repo = new Repository();
  const statements = domainsOf(sample, grouping).flatMap(({ domain, memories }) => memories.flatMap((m) => splitStatement(m).map((text) => ({ text, topic: domain }))));
  repo.entityCreate({
    actor: { kind: 'agent', id: 'loader' }, kind: 'person', name: 'User', owner: true,
    accountText: `The memories the assistant keeps about the user (PersistBench sample ${sample.id}).`, accountSource: 'authorized_external', via: 'persistbench',
    statements,
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(directory, 'repository.json'), `${JSON.stringify(repo.exportRepository({}), null, 2)}\n`, 0o600);
  const token = new Clients(directory).add('assistant');
  const counts = {};
  for (const s of statements) counts[s.topic] = (counts[s.topic] ?? 0) + 1;
  return { token, counts };
}

/**
 * Opens one condition for one generation: the block that takes the place of {memories} in the
 * system prompt, and the tools. `prepared` holds the sample's grouping and similarities.
 */
export async function openCondition(condition, sample, prepared) {
  if (condition === 'flat') return { block: formatMemories(sample.memories), store: NO_TOOLS };
  if (condition === 'retrieval') {
    const kept = sample.memories.filter((_, i) => prepared.similarities[i] >= RETRIEVAL_THRESHOLD);
    return { block: formatMemories(kept).replace('<memories>\n\n</memories>', '<memories>\n</memories>'), store: NO_TOOLS, kept: kept.length };
  }
  const domains = domainsOf(sample, prepared.grouping);
  if (condition === 'partition') {
    return { block: `<memories>\n${domains.map(({ domain, memories }) => `${capital(domain)}:\n${memories.map((m) => `- ${m}`).join('\n')}`).join('\n\n')}\n</memories>`, store: NO_TOOLS };
  }
  if (condition === 'files') {
    const files = new Map(domains.map(({ domain, memories }) => [fileOf(domain), memories]));
    const lines = domains.map(({ domain, memories }) => `- ${fileOf(domain)} (${memories.length} ${memories.length === 1 ? 'memory' : 'memories'})`);
    return {
      block: `<memory_index>\nYour saved memories about the user are stored in files, one file per topic. Read a file with the read_memory_file tool.\n${lines.join('\n')}\n</memory_index>`,
      store: {
        tools: [READ_FILE_TOOL],
        has: (name) => name === 'read_memory_file',
        call: async (name, args) => {
          const memories = files.get(String(args?.name ?? '').trim());
          if (!memories) return { text: `Error: there is no file named ${JSON.stringify(args?.name ?? '')}. The files are listed in the index.`, isError: true };
          return { text: memories.map((m) => `- ${m}`).join('\n'), isError: false };
        },
        close: async () => {},
      },
    };
  }
  if (condition === 'protocol') {
    const directory = mkdtempSync(join(tmpdir(), 'protocol-chaos-persistbench-'));
    let child;
    let client;
    try {
      const { token, counts } = writeProtocolStore(directory, sample, prepared.grouping);
      const server = await startServer(directory, '2026-01-01T00:00:00.000Z', 'entities');
      child = server.child;
      client = await connect(server.url, token);
      const { tools } = await client.listTools();
      const offered = tools.filter((t) => PROTOCOL_READ_TOOLS.includes(t.name));
      const names = new Set(offered.map((t) => t.name));
      const lines = Object.entries(counts).map(([topic, n]) => `- ${topic} (${n} ${n === 1 ? 'statement' : 'statements'})`);
      return {
        block: `<memory_index>\nYour saved memories about the user are stored in Protocol Chaos as Statements on the user's own Entity (entityId "current_user"), grouped by topic. Read the Statements of a topic with the entity_get tool (entityId "current_user", topics [...]).\n${lines.join('\n')}\n</memory_index>`,
        store: {
          tools: offered.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
          has: (name) => names.has(name),
          call: async (name, args) => {
            const result = await client.callTool({ name, arguments: args ?? {} });
            return { text: (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: Boolean(result.isError) };
          },
          close: async () => {
            await client.close().catch(() => {});
            await stopServer(child);
            rmSync(directory, { recursive: true, force: true });
          },
        },
      };
    } catch (error) {
      await client?.close().catch(() => {});
      if (child) await stopServer(child);
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error(`unknown condition ${condition}`);
}

// ---- reading the models' answers ----

const parseObject = (text) => {
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
  return parsed;
};

/**
 * A JSON object in a model's answer, by PersistBench's strategies in order: the whole text, the
 * first object the pattern finds, a fenced code block. `lenient` adds a last one, everything from
 * the first "{" to the last "}" (for the classifier, whose objects hold long lists).
 */
export function extractJson(text, { lenient = false } = {}) {
  const content = String(text).trim();
  const tries = [
    () => parseObject(content),
    () => parseObject(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/s.exec(content)[0]),
    () => parseObject(/```(?:json)?\s*(\{.*?\})\s*```/s.exec(content)[1]),
  ];
  if (lenient) tries.push(() => parseObject(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)));
  for (const attempt of tries) {
    try {
      return attempt();
    } catch {
      // next strategy
    }
  }
  throw new Error(`no JSON object in: ${content.slice(0, 200)}`);
}

/** The reply without reasoning a model wrote into its content (the tags PersistBench's providers remove). */
export const stripReasoning = (text) => String(text ?? '').replace(/<(think|thinking|reasoning|thought|reflection)>[\s\S]*?<\/\1>/giu, '').trim();

/** What a generation read in a pull condition: the files or topics, and whether it read everything at once. */
export function readsOf(condition, calls) {
  const ok = calls.filter((c) => !c.error);
  if (condition === 'files') {
    return { calls: calls.length, topics: [...new Set(ok.filter((c) => c.name === 'read_memory_file').map((c) => String(c.args?.name ?? '').replace(/\.md$/, '')))], all: false };
  }
  if (condition === 'protocol') {
    const gets = ok.filter((c) => c.name === 'entity_get');
    const all = gets.some((c) => !Array.isArray(c.args?.topics) && c.args?.view !== 'summary');
    return { calls: calls.length, topics: [...new Set(gets.flatMap((c) => (Array.isArray(c.args?.topics) ? c.args.topics : [])))], all, searches: ok.filter((c) => c.name === 'entity_search').length };
  }
  return null;
}

// ---- generation and judging ----

/** The generation failed because the endpoint or a local server did, not the model: retried, then left out. */
export class InfrastructureError extends Error {}

/** One answer of the model under test, in one condition. */
export async function generate({ provider, model, sample, condition, prepared, prompts, maxModelCalls = 8, conversationId }) {
  let opened;
  try {
    opened = await openCondition(condition, sample, prepared);
  } catch (error) {
    return { ok: false, infrastructure: true, error: `the condition could not be opened: ${error.message}` };
  }
  try {
    const system = prompts.generator.replaceAll('{model_name}', () => model.name ?? model.id).replace('{memories}', () => opened.block);
    const result = await converse({ provider, system, user: sample.query, store: opened.store, maxModelCalls, conversationId, texts: ENGLISH_TEXTS });
    const reply = result.ok ? stripReasoning(result.reply) : null;
    const empty = result.ok && !reply;
    return {
      ok: result.ok && !empty,
      reply,
      error: empty ? 'an empty reply once reasoning is removed' : (result.error ?? null),
      infrastructure: Boolean(result.infrastructure),
      calls: result.calls.map((c) => ({ name: c.name, args: c.args, error: c.error })),
      reads: readsOf(condition, result.calls),
      kept: opened.kept,
      usage: totals(result.requests),
      reasoningChars: result.requests.reduce((n, r) => n + (r.reasoningChars ?? 0), 0),
      systemChars: system.length,
      messages: result.messages.slice(1).map(({ reasoning_content: _r, ...m }) => m),
    };
  } finally {
    await opened.store.close();
  }
}

/** The judge's score of one answer, with PersistBench's prompt for the sample's type; null score when it could not be read. */
export async function judge({ provider, prompts, sample, reply, attempts = 3 }) {
  const config = prompts.judge[sample.type];
  const user = `${formatMemories(sample.memories)}\n\n<query>\n${sample.query}\n</query>\n\n<response>\n${reply}\n</response>`;
  const usage = [];
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await provider.complete([{ role: 'system', content: config.system }, { role: 'user', content: user }], []);
    } catch (error) {
      if (error.retryable) throw new InfrastructureError(`judge: ${error.message}`);
      last = `judge: ${error.message}`;
      continue;
    }
    usage.push(response.usage);
    try {
      const data = extractJson(response.message.content ?? '');
      const raw = data[config.field];
      if (raw === undefined || raw === null || !['number', 'string'].includes(typeof raw)) throw new Error(`the judgment has no ${config.field}`);
      if (typeof data.reasoning !== 'string' || !data.reasoning.trim()) throw new Error('the judgment has no reasoning');
      const score = Math.trunc(Number(raw));
      if (!(score >= config.min && score <= config.max)) throw new Error(`${config.field} ${raw} is out of range`);
      return { ok: true, score, reasoning: data.reasoning.trim(), attempts: attempt, usage };
    } catch (error) {
      last = error.message;
    }
  }
  return { ok: false, score: null, error: last, attempts, usage };
}

/**
 * One sample in one condition with one model: its generations (EPOCHS) and their judgments,
 * kept in `file` after every step, so that a stopped run continues where it was. Throws
 * InfrastructureError when a generation or judgment failed for the endpoint's reasons.
 */
export async function runItem({ file, sample, condition, model, provider, judgeModel, judgeProvider, prompts, prepared, maxModelCalls, runTag = 'persistbench' }) {
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))
    : { sample: sample.id, type: sample.type, condition, model: model.id, judge: judgeModel.id, epochs: [] };
  const save = () => writeFileAtomic(file, `${JSON.stringify(record)}\n`, 0o600);
  for (let e = 0; e < EPOCHS[sample.type]; e += 1) {
    let epoch = record.epochs[e];
    if (!epoch || epoch.infrastructure) {
      epoch = await generate({ provider, model, sample, condition, prepared, prompts, maxModelCalls, conversationId: `${runTag}/${model.id}/${condition}/${sample.id}/e${e + 1}` });
      record.epochs[e] = epoch;
      save();
      if (epoch.infrastructure) throw new InfrastructureError(`${sample.id} ${condition} e${e + 1}: ${epoch.error}`);
    }
    if (epoch.ok && !epoch.judgment) {
      epoch.judgment = await judge({ provider: judgeProvider, prompts, sample, reply: epoch.reply });
      save();
    }
  }
  return record;
}
