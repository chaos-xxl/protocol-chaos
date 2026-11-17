// End to end with a real organizer agent: an assistant records eleven sentences through the
// server, as Codex would, and the background organizer folds each of them with the organizer
// agent's own headless run. Then the daily sweep runs twice. The repository is a new temporary
// one; the data is invented.
//
//   node eval/organize/end-to-end.mjs [--agent dsh|claude-code|codex] [--command <path>] [--keep]
//
// It spends the organizer agent's model credit: with DeepSeek Harness, about 1,300 tokens per
// sentence. See README.md.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runSweep } from '../../server/organize.mjs';

const SERVER = fileURLToPath(new URL('../../server/index.mjs', import.meta.url));
const DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const { values } = parseArgs({ options: { agent: { type: 'string', default: 'dsh' }, command: { type: 'string' }, keep: { type: 'boolean' } } });
const config = { agent: values.agent, command: values.command ?? (values.agent === 'dsh' ? DSH : values.agent === 'claude-code' ? 'claude' : 'codex'), actor: 'organizer', enabled: true };
if (values.agent === 'dsh') Object.assign(config, { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'off' });
if (values.agent === 'claude-code') Object.assign(config, { model: 'haiku', budgetUsd: 0.2 });

const data = mkdtempSync(join(tmpdir(), 'protocol-chaos-e2e-'));
writeFileSync(join(data, 'organizer.json'), JSON.stringify(config, null, 2));
mkdirSync(join(data, 'organizer'));
writeFileSync(join(data, 'organizer', 'state.json'), JSON.stringify({ sweepCheckpoint: new Date().toISOString(), done: {} }));
const sessions = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
const sessionsBefore = existsSync(sessions) ? readdirSync(sessions).length : 0;

// The server starts as an assistant would start it: over stdio, with the SDK's minimal environment.
const client = new Client({ name: 'end-to-end', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, '--data', data, '--client', 'codex'], stderr: 'ignore' }));
const actor = { kind: 'agent', id: 'codex' };
const note = async (text, where) => JSON.parse((await client.callTool({ name: 'event_note', arguments: { actor, text, ...where } })).content[0].text);
const started = Date.now();
const move = (await note('我打算今年冬天搬个家，从老城区搬到新区', { title: '2026 年冬天搬家' })).eventId;
await note('搬家定在 12 月 20 号，预算两万以内', { eventId: move });
await note('搬家改到明年 1 月 3 号了，12 月公司太忙', { eventId: move });
await note('搬家公司订好了，便宜那家，报价 6800', { eventId: move });
const trip = (await note('明年春天想和 Mei 去葡萄牙玩一周', { title: '2027 年春天葡萄牙行（和 Mei）' })).eventId;
await note('葡萄牙那趟想住在里斯本老城附近', { eventId: trip });
await note('四月的里斯本冷不冷？', { eventId: trip }); // an assistant would not record a question; the fold should change nothing
const licence = (await note('我报了驾校，想年底前把驾照考下来', { title: '2026 年考到驾照' })).eventId;
await note('驾照考下来了，科目三一次过', { eventId: licence });
const network = (await note('家里网络老掉线，想今年把网络整个弄稳定', { title: '家里的网络稳定下来（2026）' })).eventId;
const breakdown = (await note('今天路由器又坏了，先用手机热点顶着', { title: '2026 年 11 月路由器故障', parentEventId: network })).eventId;
const recorded = Date.now() - started;
await client.close();

const logFile = join(data, 'organizer', 'log.jsonl');
const entries = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const deadline = Date.now() + 10 * 60_000;
while (entries().filter((entry) => entry.run === 'pending').length < 11 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 1000));
const folds = entries().filter((entry) => entry.run === 'pending');
console.log(`Recorded 11 sentences in ${(recorded / 1000).toFixed(1)}s; the organizer (${config.agent}) folded them in the background, done ${((Date.now() - started) / 1000).toFixed(0)}s after the first.\n`);
for (const entry of folds) {
  console.log(`  ${entry.outcome.padEnd(9)} ${entry.eventId} ${(entry.changed ?? []).join(', ')}${entry.error ? ` ${entry.error}` : ''}  ${((entry.ms ?? 0) / 1000).toFixed(1)}s${entry.usage ? `, ${entry.usage.input} in / ${entry.usage.output} out${entry.usage.cached ? ` (${entry.usage.cached} cached)` : ''}` : ''}`);
}
const sum = (key) => folds.reduce((total, entry) => total + (entry.usage?.[key] ?? 0), 0);
console.log(`\n  ${folds.length} folds: ${sum('input')} tokens in, ${sum('output')} out, ${sum('cached')} of them cached; ${(folds.reduce((t, e) => t + (e.ms ?? 0), 0) / Math.max(1, folds.length) / 1000).toFixed(1)}s per fold\n`);

const repository = JSON.parse(readFileSync(join(data, 'repository.json'), 'utf8'));
for (const id of [move, trip, licence, network, breakdown]) {
  const { event } = repository.events.find((item) => item.event.id === id);
  console.log(`${event.title} · ${event.state}`);
  for (const key of ['goal', 'constraint', 'plan']) if (event.facts?.[key]) console.log(`  ${key}: ${event.facts[key]}`);
  if (event.progress?.text) console.log(`  progress: ${event.progress.text}`);
  if (event.refs?.length) console.log(`  involves: ${event.refs.map((ref) => ref.criteria ?? ref.ref).join('; ')}`);
}

await runSweep(data);
await runSweep(data);
const sweeps = entries().filter((entry) => entry.run === 'sweep');
console.log(`\nSweeps: ${sweeps.map((entry) => `${entry.outcome}${entry.folded !== undefined ? ` (folded ${entry.folded})` : ''}`).join('; ')}; model calls in the sweeps: ${sweeps.filter((entry) => entry.usage).length}`);
const sessionsAfter = existsSync(sessions) ? readdirSync(sessions).length : 0;
if (config.agent === 'dsh') console.log(`DeepSeek Harness session folders: ${sessionsBefore} before, ${sessionsAfter} after`);
const log = readFileSync(logFile, 'utf8');
console.log(`The log holds none of the words: ${['搬家', '葡萄牙', '驾照', '路由器'].every((word) => !log.includes(word))}`);
if (values.keep) console.log(`Kept: ${data}`);
else rmSync(data, { recursive: true, force: true });
