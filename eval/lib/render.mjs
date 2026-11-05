// Canonical matters (eval/README.md, "Matter") as plain text: T1's entries and T2's files.
// The parsers invert the renderers exactly; equivalence.mjs uses them to check that every
// arm starts from the same information. Text written by models during a run is never
// parsed: it only has to be readable by the next model.

export const STATE_LABELS = {
  emerging: '刚提起', active: '进行中', waiting: '等待中', dormant: '搁置', done: '已完成', cancelled: '已取消',
};
const STATE_OF_LABEL = Object.fromEntries(Object.entries(STATE_LABELS).map(([state, label]) => [label, state]));
const SOURCE_LABELS = { user: '用户原话', agent_response: '助手记下' };

/** Text on one line: backslashes and line breaks escaped. */
export const oneLine = (text) => String(text).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n');
export const unescapeLine = (text) => text.replace(/\\(\\|n)/g, (_, c) => (c === 'n' ? '\n' : '\\'));

const latestDate = (matter) => [matter.organizedBy?.date, ...matter.accounts.map((a) => a.date)].filter(Boolean).sort().at(-1);

function recordLine(account) {
  const words = account.source === 'user' ? `「${oneLine(account.text)}」` : oneLine(account.text);
  return `- ${account.date} 助手 ${account.assistant}｜${SOURCE_LABELS[account.source]}：${words}`;
}

function parseRecordLine(line, where) {
  const m = /^- (\d{4}-\d{2}-\d{2}) 助手 ([ABC])｜(用户原话|助手记下)：(.*)$/.exec(line);
  if (!m) throw new Error(`${where}: not a record line: ${line}`);
  const source = m[3] === '用户原话' ? 'user' : 'agent_response';
  let words = m[4];
  if (source === 'user') {
    if (!words.startsWith('「') || !words.endsWith('」')) throw new Error(`${where}: user words not in 「」: ${line}`);
    words = words.slice(1, -1);
  }
  return { date: m[1], assistant: m[2], source, text: unescapeLine(words) };
}

const organizedLine = (organizedBy) => `最后整理：助手 ${organizedBy.assistant}，${organizedBy.date}`;
function parseOrganized(value, where) {
  const m = /^助手 ([ABC])，(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (!m) throw new Error(`${where}: not "助手 X，YYYY-MM-DD": ${value}`);
  return { assistant: m[1], date: m[2] };
}

const titleOfParent = (matter, byKey) => {
  if (!matter.parent) return null;
  const parent = byKey.get(matter.parent);
  if (!parent) throw new Error(`${matter.key}: parent ${matter.parent} is not in the library`);
  return parent.title;
};

// ---- T1: entries ----

/** One entry of T1 for a matter. `byKey` maps keys to matters, to name the parent. */
export function renderEntry(matter, byKey) {
  const lines = [`【${oneLine(matter.title)}】`, `状态：${STATE_LABELS[matter.state]}`];
  const parent = titleOfParent(matter, byKey);
  if (parent) lines.push(`上级：【${oneLine(parent)}】`);
  if (matter.facts.goal) lines.push(`目标：${oneLine(matter.facts.goal)}`);
  if (matter.facts.constraint) lines.push(`条件：${oneLine(matter.facts.constraint)}`);
  if (matter.facts.plan) lines.push(`安排：${oneLine(matter.facts.plan)}`);
  if (matter.progress) lines.push(`进展（${matter.progress.date}）：${oneLine(matter.progress.text)}`);
  lines.push('记录：', ...matter.accounts.map(recordLine));
  if (matter.organizedBy) lines.push(organizedLine(matter.organizedBy));
  return lines.join('\n');
}

export function renderEntries(matters) {
  const byKey = new Map(matters.map((m) => [m.key, m]));
  return matters.map((m) => renderEntry(m, byKey));
}

/** T1 entries back to matters, keyed by title (key and parent are titles). */
export function parseEntries(entries) {
  return entries.map((entry, index) => {
    const where = `entry ${index + 1}`;
    const lines = entry.split('\n');
    const title = /^【(.*)】$/.exec(lines[0])?.[1];
    if (title === undefined) throw new Error(`${where}: the first line is not 【title】`);
    const matter = { key: unescapeLine(title), title: unescapeLine(title), state: undefined, parent: null, facts: {}, progress: null, accounts: [], organizedBy: null };
    let i = 1;
    for (; i < lines.length && lines[i] !== '记录：'; i += 1) {
      const line = lines[i];
      let m;
      if ((m = /^状态：(.*)$/.exec(line))) matter.state = STATE_OF_LABEL[m[1]];
      else if ((m = /^上级：【(.*)】$/.exec(line))) matter.parent = unescapeLine(m[1]);
      else if ((m = /^目标：(.*)$/.exec(line))) matter.facts.goal = unescapeLine(m[1]);
      else if ((m = /^条件：(.*)$/.exec(line))) matter.facts.constraint = unescapeLine(m[1]);
      else if ((m = /^安排：(.*)$/.exec(line))) matter.facts.plan = unescapeLine(m[1]);
      else if ((m = /^进展（(\d{4}-\d{2}-\d{2})）：(.*)$/.exec(line))) matter.progress = { text: unescapeLine(m[2]), date: m[1] };
      else throw new Error(`${where}: unexpected line: ${line}`);
    }
    if (!matter.state) throw new Error(`${where}: no state`);
    for (i += 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith('最后整理：')) {
        matter.organizedBy = parseOrganized(line.slice('最后整理：'.length), where);
        if (i !== lines.length - 1) throw new Error(`${where}: lines after 最后整理`);
      } else {
        matter.accounts.push(parseRecordLine(line, where));
      }
    }
    return matter;
  });
}

// ---- T2: files ----

/**
 * A file name for a title: the title itself, without path separators or characters some systems
 * refuse. Spaces stay, so that a model that writes the title as the file name finds the file.
 */
export function fileNameFor(title, taken = new Set()) {
  const base = title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/-+/g, '-').trim().replace(/^[-.]+/, '').slice(0, 80).trim() || '未命名';
  let name = `${base}.md`;
  for (let n = 2; taken.has(name) || name === 'index.md'; n += 1) name = `${base}-${n}.md`;
  taken.add(name);
  return name;
}

export const INDEX = 'index.md';
const INDEX_HEAD = '# 索引\n\n每件事一个文件。这里每行一件：文件、状态、上级、最后更新。\n';

export function indexLine(title, file, state, parentTitle, date) {
  return `- [${oneLine(title)}](${file})｜${STATE_LABELS[state]}｜上级：${parentTitle ? oneLine(parentTitle) : '无'}｜更新：${date}`;
}

/** T2 for matters: `{files: {name: content}, index}`, the index being the content of index.md. */
export function renderFiles(matters) {
  const byKey = new Map(matters.map((m) => [m.key, m]));
  const taken = new Set();
  const names = new Map(matters.map((m) => [m.key, fileNameFor(m.title, taken)]));
  const files = {};
  const lines = [];
  for (const matter of matters) {
    const parent = titleOfParent(matter, byKey);
    const head = [`# ${oneLine(matter.title)}`, '', `- 状态：${STATE_LABELS[matter.state]}`];
    if (parent) head.push(`- 上级：[${oneLine(parent)}](${names.get(matter.parent)})`);
    if (matter.organizedBy) head.push(`- ${organizedLine(matter.organizedBy)}`);
    const sections = [];
    if (matter.facts.goal) sections.push(['## 目标', oneLine(matter.facts.goal)]);
    if (matter.facts.constraint) sections.push(['## 条件', oneLine(matter.facts.constraint)]);
    if (matter.facts.plan) sections.push(['## 安排', oneLine(matter.facts.plan)]);
    if (matter.progress) sections.push([`## 进展（${matter.progress.date}）`, oneLine(matter.progress.text)]);
    sections.push(['## 记录', matter.accounts.map(recordLine).join('\n')]);
    files[names.get(matter.key)] = `${[head.join('\n'), ...sections.map(([h, body]) => `${h}\n\n${body}`)].join('\n\n')}\n`;
    lines.push(indexLine(matter.title, names.get(matter.key), matter.state, parent, latestDate(matter)));
  }
  return { files, index: `${INDEX_HEAD}\n${lines.join('\n')}\n` };
}

/** T2 back to matters keyed by title; throws when the index disagrees with the files. */
export function parseFiles({ files, index }) {
  const titleOfFile = new Map();
  const matters = [];
  for (const [name, content] of Object.entries(files)) {
    const where = name;
    const blocks = content.replace(/\n$/, '').split('\n\n');
    const title = /^# (.*)$/.exec(blocks[0])?.[1];
    if (title === undefined) throw new Error(`${where}: no # title`);
    const matter = { key: unescapeLine(title), title: unescapeLine(title), state: undefined, parent: null, facts: {}, progress: null, accounts: [], organizedBy: null };
    for (const line of blocks[1].split('\n')) {
      let m;
      if ((m = /^- 状态：(.*)$/.exec(line))) matter.state = STATE_OF_LABEL[m[1]];
      else if ((m = /^- 上级：\[(.*)\]\((.*)\)$/.exec(line))) matter.parent = { title: unescapeLine(m[1]), file: m[2] };
      else if ((m = /^- 最后整理：(.*)$/.exec(line))) matter.organizedBy = parseOrganized(m[1], where);
      else throw new Error(`${where}: unexpected line: ${line}`);
    }
    for (let i = 2; i < blocks.length; i += 2) {
      const heading = blocks[i];
      const body = blocks[i + 1] ?? '';
      let m;
      if (heading === '## 目标') matter.facts.goal = unescapeLine(body);
      else if (heading === '## 条件') matter.facts.constraint = unescapeLine(body);
      else if (heading === '## 安排') matter.facts.plan = unescapeLine(body);
      else if ((m = /^## 进展（(\d{4}-\d{2}-\d{2})）$/.exec(heading))) matter.progress = { text: unescapeLine(body), date: m[1] };
      else if (heading === '## 记录') matter.accounts = body.split('\n').map((line) => parseRecordLine(line, where));
      else throw new Error(`${where}: unexpected section: ${heading}`);
    }
    titleOfFile.set(name, matter.title);
    matters.push({ matter, name });
  }
  for (const { matter } of matters) {
    if (matter.parent) {
      if (titleOfFile.get(matter.parent.file) !== matter.parent.title) throw new Error(`${matter.title}: the parent link does not point at that title`);
      matter.parent = matter.parent.title;
    }
  }
  const listed = index.split('\n').filter((line) => line.startsWith('- ['));
  const byName = new Map(matters.map(({ matter, name }) => [name, matter]));
  if (listed.length !== matters.length) throw new Error(`index.md lists ${listed.length} files, there are ${matters.length}`);
  for (const line of listed) {
    const m = /^- \[(.*)\]\((.*)\)｜(.*)｜上级：(.*)｜更新：(\d{4}-\d{2}-\d{2})$/.exec(line);
    if (!m) throw new Error(`index.md: not an index line: ${line}`);
    const matter = byName.get(m[2]);
    if (!matter) throw new Error(`index.md: ${m[2]} is not a file`);
    if (unescapeLine(m[1]) !== matter.title || STATE_OF_LABEL[m[3]] !== matter.state
      || (m[4] === '无' ? null : unescapeLine(m[4])) !== matter.parent || m[5] !== latestDate(matter)) {
      throw new Error(`index.md disagrees with ${m[2]}`);
    }
  }
  return matters.map(({ matter }) => matter);
}
