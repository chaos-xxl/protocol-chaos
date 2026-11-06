// A stand-in for the model in dry runs (`cli.mjs run --dry`): it writes each user message to
// the store with the arm's own tools and answers every probe "UNKNOWN". As the organizer, it
// reads what is new in P and stops. It checks the plumbing (servers, tokens, clocks, files,
// copies, the nights, scoring, the report) at no cost; its results say nothing about the arms.
import { createScriptedProvider } from './provider.mjs';

const todayOf = (system) => /今天是 (\d{4}-\d{2}-\d{2})/.exec(system)?.[1] ?? '';
const assistantOf = (system) => /你是助手 ([ABC])/.exec(system)?.[1] ?? 'A';
const lastToolResult = (messages) => [...messages].reverse().find((m) => m.role === 'tool')?.content;

export function rehearsalProvider() {
  let files = 0;
  return createScriptedProvider(({ messages, tools }) => {
    const system = messages[0].content;
    const user = messages[1].content;
    const steps = messages.filter((m) => m.role === 'assistant').length;
    const names = new Set(tools.map((t) => t.function.name));
    if (user.includes('回答格式：')) return { content: '我查了一下。\nANSWER: UNKNOWN' };
    if (system.includes('你是整理助手')) {
      const since = /since 填 "([^"]+)"/.exec(user)?.[1];
      if (names.has('event_words_since') && since && steps === 0) return { tool_calls: [{ name: 'event_words_since', arguments: { since } }] };
      return { content: '整理完了。' };
    }
    const assistant = assistantOf(system);
    const title = `演练：${user.slice(0, 16)}`;
    if (names.has('event_note')) {
      if (steps === 0) return { tool_calls: [{ name: 'event_note', arguments: { actor: { kind: 'agent', id: `assistant-${assistant.toLowerCase()}` }, text: user, title } }] };
      if (steps === 1 && names.has('event_record_expression')) {
        const receipt = JSON.parse(lastToolResult(messages));
        return {
          tool_calls: [{
            name: 'event_record_expression',
            arguments: {
              eventId: receipt.eventId, actor: { kind: 'agent', id: `assistant-${assistant.toLowerCase()}` }, text: user,
              accountId: receipt.accountId, expectedVersion: receipt.version, set: { state: 'active', facts: { goal: user } },
            },
          }],
        };
      }
      return { content: '记下了。' };
    }
    if (names.has('memory')) {
      if (steps === 0) return { tool_calls: [{ name: 'memory', arguments: { action: 'add', content: `【${title}】\n状态：进行中\n记录：\n- ${todayOf(system)} 助手 ${assistant}｜用户原话：「${user}」` } }] };
      return { content: '记下了。' };
    }
    if (names.has('notes_create')) {
      files += 1;
      const name = `演练-${Date.now()}-${files}.md`;
      if (steps === 0) return { tool_calls: [{ name: 'notes_create', arguments: { path: name, content: `# ${title}\n\n- 状态：进行中\n\n## 记录\n\n- ${todayOf(system)} 助手 ${assistant}｜用户原话：「${user}」\n` } }] };
      if (steps === 1) return { tool_calls: [{ name: 'notes_append', arguments: { path: 'index.md', content: `- [${title}](${name})｜进行中｜上级：无｜更新：${todayOf(system)}` } }] };
      return { content: '记下了。' };
    }
    return { content: '记下了。' };
  }, { id: 'rehearsal' });
}
