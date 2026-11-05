# Writing test cases: the brief

This is everything an author of test cases is given. It does not say what is being compared or which results are expected, so that the cases do not lean towards any answer.

## What the cases are for

A person talks to three AI assistants, A, B and C, on different days. The assistants share one place where they keep what the person has told them, and every conversation starts fresh: the only way an assistant knows what was said before is what that place holds. A test case is a short scripted story of such conversations, followed by questions with exactly one right answer. The cases check how well the assistants can answer questions about the person's own matters afterwards.

Behind every case there are about 150 other everyday matters of the same person (trips, purchases, learning a skill, appointments, family events and so on). Your case's matters sit among them.

## What you write

One JSON file per template, in `eval/templates/<split>/`, named `<category in lower case>-<a short slug>.json`. A template is a story with placeholders; each entry in `variants` fills them in and becomes one case. Write 3 to 5 variants per template, differing in the values and, where it reads naturally, in the place, object or people. The story's shape stays the same across variants.

Here is a complete template:

```json
{
  "id": "d1-moving-budget",
  "category": "D1",
  "author": "your-name",
  "shape": "One value of a matter changed twice, by two different assistants, a few days apart.",
  "keywords": ["搬家"],
  "variants": [
    { "first": "20000", "second": "25000", "third": "23000" },
    { "first": "8000", "second": "12000", "third": "10000" }
  ],
  "sessions": [
    { "day": 0, "assistant": "A", "user": "下个月搬家，预算先定 {first} 元。" },
    { "day": 3, "assistant": "B", "user": "搬家的预算改成 {second} 元吧，东西比想的多。" },
    { "day": 6, "assistant": "C", "user": "搬家那件事，预算最后定成 {third} 元，不再改了。" }
  ],
  "probes": [
    { "day": 9, "assistant": "A", "question": "我搬家的预算现在定的是多少？",
      "answer": { "type": "number", "value": "{third}", "unit": "元", "stale": ["{first}", "{second}"] } }
  ]
}
```

- **id**: lowercase letters, digits and hyphens, starting with the category, unique.
- **author**: who wrote it. Use the same name in every file you write.
- **shape**: one sentence on the real-life situation whose shape the story borrows.
- **keywords**: words that identify this case's matters, such as the place or the object. The 150 background matters are generated so that none of them contains a keyword, so every question has exactly one right matter. Choose words specific enough not to remove whole areas of everyday life: "搬家" is fine, "钱" is not. Every keyword must appear in the story.
- **sessions**: what the person says, one message per conversation, in order. `day` counts from day 0 (a Monday, 2026-10-05); `time` is optional, Beijing time between 08:00 and 23:59 (default 20:00). Each message goes to one assistant (`A`, `B` or `C`); spread them over the assistants the way a person who uses three assistants would.
- **probes**: the questions, asked after the last message, each in a new conversation with one assistant. Every question has one right answer that follows from the story alone.
- **seed** (optional): matters that already exist before day 0, as if earlier conversations had recorded them. Use it when the story needs history (a standing arrangement, a condition set long ago, something said in passing). See "Seeds" below.

Placeholders are `{name}`, filled from the variant; write `{{` and `}}` for literal braces.

## Answers

Every answer is closed, so it is scored by rules:

| type | fields | what counts as right |
|---|---|---|
| `number` | `value`, optional `unit`, optional `stale` (values that were true earlier in the story), optional `confused` (values of a different but similar matter in the same story) | the number |
| `date` | `value` as YYYY-MM-DD, or `day`; optional `stale` | the date |
| `option` | `options` `{"A": "…", "B": "…", …}`, `value` a letter, optional `stale` and `confused` letters | the letter |
| `multi` | `options` as above, `value` a list of letters | exactly that set |
| `provenance` | `who` (`A`, `B` or `C`), `date` or `day`, `kind` (`user` for the person's own words, `inference` for an assistant's guess) | all three |
| `unknown` | optional `as` (`number`, `date` or `option`, the format shown) | saying the place does not hold it |

The question is shown with its options and a line asking for the answer format; you write only the question.

Options must be plausible: each wrong option should be something a careless reader of the story might pick (an old value, the value of a similar matter, what held only for a while), never something absurd.

## Categories

| | The question asks | Write a story where |
|---|---|---|
| D1 | the current value of something after it changed | a value changes two or three times, told to different assistants, possibly with unrelated messages in between |
| D2 | who said or wrote something, on which day, and whether it was the person's own words or an assistant's guess | that is answerable from the story; an assistant's guess can come from a seed (an account with `"source": "agent_response"`, written as "推测：…（依据：…）") |
| D3 | a value of one of two very similar matters | two matters are easy to mix up (two trips, two purchases of the same kind, two appointments), each with its own values, told in an interleaved way |
| D4 | how a long-lived matter stands, while or after a one-off episode of it | a standing arrangement is interrupted for a while (an outage, an injury, a week away); ask about the standing arrangement, and about the episode |
| D5 | something about a part of a larger matter, where the answer depends on a condition set on the larger matter | the larger matter and its condition come first (often as a seed); the part is told later without repeating the condition; the question is worded differently from the condition |
| D6 | which matters are in a given state: waiting on someone, decided, finished, given up | several matters change state over the story; ask with `multi` over options that list them |
| N1 | one value of one matter | one matter, one value, said once; the simplest possible case (the background is small for this category) |
| X1 | something across several matters that is in their content, not their names | several matters whose names do not reveal the answer; ask with `multi` |
| X2 | a matter described without using any word of its name | ask about the matter by describing it; no word of the question may appear in the matter's name |
| X3 | something that was said while talking about a different matter | the information was mentioned in passing in another matter's conversation (a seed account of that other matter); ask about it on its own |

## Seeds

```json
"seed": [
  {
    "key": "parent",
    "title": "2026 年陪外婆出门走走",
    "state": "active",
    "facts": { "goal": "2026 年陪外婆出门玩几次。", "constraint": "住的地方必须有电梯。" },
    "accounts": [{ "day": -60, "assistant": "C", "source": "user", "text": "今年想陪外婆出门走走，住的地方一定要有电梯。" }],
    "organizedBy": { "assistant": "C", "day": -60 }
  }
]
```

- `title` names the matter on its own, with when or which ("2026 年 11 月杭州出差", never just "出差"); at most 80 characters.
- `state`: `emerging` (just mentioned), `active`, `waiting`, `dormant` (set aside), `done` or `cancelled`.
- `facts`: any of `goal`, `constraint` (limits, budgets, wishes) and `plan` (what has been decided), each one sentence, consistent with the accounts.
- `accounts`: what was said, oldest first, each with `day` (before day 0, so -1 or earlier), `assistant`, `source` and `text`.
- `organizedBy`: the assistant who last brought the matter's state and facts up to date, and the day, not before its last account. A matter nobody organized is `emerging` with no facts.
- `parent`: the `key` of a seed above it that it is part of; a part's first account is not older than its parent's.

## Rules

- Write what a person would actually say to an assistant, in natural, everyday Chinese: short, sometimes casual, sometimes referring back loosely ("那件事", "上次说的").
- No real people's names, no company names, no private addresses. Relatives are "我妈", "我爱人", "表弟" and so on.
- Do not use anything you know about how assistants store information; write the story as it would happen.
- Every right answer must follow from the story alone, without outside knowledge, and must be the only defensible one.
- Check your files: `node eval/cli.mjs validate` must pass, and lists your templates by category.
