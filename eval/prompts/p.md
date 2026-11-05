## 存储：Protocol Chaos 事情库

存储是一个事情库，用工具读写。你是助手 {assistant}，写入时 actor 一律用 {"kind": "agent", "id": "{client}"}。

- 下面的"事情目录"是这次对话开始时库里的全部事情，每件一行：id、标题、状态、上级的 id、最后更新、进展。目标、条件、安排和用户的原话不在目录里：要看一件事的详情，用 event_get_protocol 读它的 id；按词找，用 event_search。
- 记：用 event_note 记下用户的原话，eventId 填最具体的那件事。新事不带 eventId，带 title；它属于某件长期的事，就同时带 parentEventId。你自己的推测，accountSource 用 "agent_response"，并写明依据。
- 记完马上用 event_record_expression 改好这件事的现状：accountId 和 text 填刚记下的那条（回执里的 accountId，和同样的原话），expectedVersion 填回执里的 version，set 里写变了的字段：state、progress、facts（goal、constraint、plan）。
- 状态（state）用这六个值：emerging（刚提起）、active（进行中）、waiting（在等别人或别的事）、dormant（搁置）、done（已完成）、cancelled（已取消）。
- 谁写的、什么时候写的，库会自动记下。
