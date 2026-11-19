# 混沌协议 · Protocol Chaos

[![npm](https://img.shields.io/npm/v/protocol-chaos?label=npm)](https://www.npmjs.com/package/protocol-chaos)
[![Specification](https://img.shields.io/badge/specification-draft%200.2-informational)](../PROTOCOL.md)
[![Tests](https://github.com/chaos-xxl/protocol-chaos/actions/workflows/test.yml/badge.svg)](https://github.com/chaos-xxl/protocol-chaos/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue)](../LICENSE)

[English](../README.md) · 简体中文

**Connected plans. Shared memory. Yours to keep.**

An open memory protocol and MCP server for personal AI assistants.

Protocol Chaos 是一份开放的记忆协议，也提供可以直接运行的 MCP 服务端。它把你正在推进的项目、旅行、学习目标等，保存成彼此关联的事情：为了什么、进展如何、属于哪件更大的事。

- **事情有脉络。** 把目标、它下面的具体事情和各自进展连起来。助手能跨对话跟进，应用也能据此组织清楚的事情视图。
- **跨助手接着做。** 兼容的助手读写同一份事情，接续最新的约束和安排；每次改动都保留记录者和原话依据。
- **积累由自己掌握。** 事情库在自己的电脑或服务器上。某个助手账号失效后，已经保存到库里的内容仍由你保管，也可以迁移到另一个合格的实现。

只用一个助手、经常开新对话的人也能用；多个助手可以共用；开发 Personal Agent 的团队可以把它接进自己的产品。

[开始试用](#快速开始) · [给 Personal Agent 开发者](#给-personal-agent-开发者) · [阅读协议](../PROTOCOL.md)

## 快速开始

需要 **Node.js 20+**，支持 **macOS / Linux**。

~~~sh
npx protocol-chaos init
~~~

1. **选择助手。** 安装器找出这台电脑上已有的助手，把你选的接到同一个库。
2. **说一件长期计划。** 例如：“我想学街头摄影，不过只能周末去。”
3. **开新对话接着聊。** 在同一个助手或另一个已接入的助手里，问自己之前说过摄影什么。之后改一次条件，再确认新对话能读到新的安排。

安装器也可以导入助手已有的记忆文件。它会先列出读什么、文字发到哪里、预计消耗多少模型用量，征得同意再导入；原文件只读。详见[记忆导入](../server/README.md#importing-other-assistants-memories)。

安装器已适配 **Claude Code、Codex、DeepSeek Harness、Hermes、Kiro、Cursor、OpenCode、OpenClaw、Claude Desktop、GitHub Copilot 和 Pi**。各宿主的真实会话验证仍在补充，详见[接入说明](../server/README.md#installer)。

安装器可以选一个已接入的助手，在后台整理新记下的原话；没有可用的后台助手时，会提示当前助手在对话中更新事情。Hermes 使用自己的插件整理。详见[后台整理](../server/README.md#organizing-in-the-background)。

用 <code>npx protocol-chaos doctor</code> 检查连接，用 <code>npx protocol-chaos uninstall</code> 撤销安装配置；事情库保留。另见[你的数据](#你的数据)。

<details>
<summary>手动配置 MCP 与跨设备使用</summary>

想手动接，就把参考服务端加到助手里，名字用 `protocol_chaos`：

- **Claude Code：**

  ```sh
  claude mcp add --scope user protocol_chaos -- npx -y protocol-chaos@0.2
  ```

- **Codex**，写在 `~/.codex/config.toml` 里：

  ```toml
  [mcp_servers.protocol_chaos]
  command = "npx"
  args = ["-y", "protocol-chaos@0.2"]
  ```

- **Claude Desktop、Cursor、Kiro** 等用 JSON 配置的客户端（`claude_desktop_config.json`、`~/.cursor/mcp.json`、`~/.kiro/settings/mcp.json`）：

  ```json
  { "mcpServers": { "protocol_chaos": { "command": "npx", "args": ["-y", "protocol-chaos@0.2"] } } }
  ```


多个设备上的助手共用时，通过 HTTP 运行服务端，给每个助手单独的令牌：见[远程接入](../server/README.md#remote)。

手动配置时也应装上[常驻指引](agent-guide.md#server-instructions)，让助手知道什么时候读、什么时候记。<code>init</code> 会为支持的客户端配置这些指引。

</details>

## 给 Personal Agent 开发者

Personal Agent 要先持续掌握用户正在推进的事情，才能决定首页呈现什么、回答引用什么。一个长期目标、它下面的具体计划、刚发生的一次变化，含义各不相同，即使都能装进一张卡片。

Protocol Chaos 为这些内容提供可以持续维护的结构。每件事有身份、当前状态、目标和约束、所属的更大事情，以及原话与修订记录。

例如，一个摄影目标可以逐渐长出：

~~~text
学习街头摄影
├── 周末摄影散步 — 进行中
└── 制作第一本摄影小册 — 刚萌芽
~~~

同一份记录可以用于不同页面：计划页呈现目标和它下面的事情，今日页展示相关变化，对话按最新约束回答摄影小册的问题。这个例子说明可以用协议构建的应用；参考服务端提供事情记录和读写操作，**展示什么、怎样排序、如何解释出现理由，由你的产品决定。**

从 <code>context_pack</code> 返回的目录开始，用 <code>event_get_protocol</code> 读取所需事情，用 <code>event_note</code> 记下新的原话。[接入指引](agent-guide.md)说明怎样维护，[协议规格](../PROTOCOL.md)定义共同遵守的约定。

## 记忆怎样维护

- **当前状态与历史分开。** 可以读一件事现在到哪了，也可以追溯谁依据哪句话修改过它。
- **原话是证据。** 用户原话逐字保留；推断标明依据，用户的纠正优先。
- **模糊是常态。** 一件事可以从一句话开始，用户不必填满一张表。
- **关联明确记录。** 一件事可以有多个上级，不同事情也可以指向同一个人、地点或物品。
- **约定可以被别人实现。** 规范和兼容性测试让其他实现能通过 MCP 支持相同的记录和操作。

## 协议定义了什么

| | |
|---|---|
| **事情（Event）** | 一件事：标题、状态、进展；用自然语言写的目标、约束、计划；涉及的人、地方和东西；以及它属于哪件更大的事。 |
| **原话（Account）** | 一件事所依据的用户原话，原样保存，永不修改。 |
| **实体（Entity）** | 用户提到的人、动物、东西和地方，包括用户本人，每条陈述只说一件事。 |
| **修订（Revision）** | 每一次改动，写明是谁改的、依据的是哪句原话。 |
| **写入规则** | 什么该记、什么不该记，让往同一个库里写的每个助手做法一致。 |
| **级别** | Core，以及可选的实体、搜索、同步、撤销、远程。 |

客户端怎么判断一段对话涉及哪些事、怎么排序、什么时候整理，由客户端自己决定。完整规则见 **[PROTOCOL.md](../PROTOCOL.md)**（英文）。

~~~mermaid
flowchart LR
  claude[Claude] <--> server
  codex[Codex] <--> server
  cursor[Cursor] <--> server
  app[你自己的应用] <--> server
  server["混沌协议服务端<br/>任何合格的实现"] --- repo[("用户的库<br/>事情 · 原话 · 实体 · 历史")]
~~~

## 仓库里有什么

| 路径 | |
|---|---|
| [PROTOCOL.md](../PROTOCOL.md) | 规范，有约束力。 |
| [conformance/](../conformance/README.md) | 兼容性测试，通过 MCP 检查任何服务端。 |
| [server/](../server/README.md) | 参考服务端，从 Core 到远程全部级别都支持：一台电脑上用 stdio，几台电脑共用时用 HTTP。 |
| [docs/agent-guide.md](agent-guide.md) | 助手怎么用好一个库：先回答，后记录，晚点整理。不是规范。 |
| [integrations/hermes/](../integrations/hermes/protocol-chaos/README.md) | [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的插件：会话概览、后台记录与整理，以及可选的逐轮上下文选择。 |

## 实现这份协议

1. 读 [PROTOCOL.md](../PROTOCOL.md)，先做 Core 级别（§12）。
2. 把各项操作做成 MCP 工具（§9.1）：一台电脑用 stdio；几台电脑共用一个库时，用 streamable HTTP，每个客户端一个凭证（§9.2）。
3. 测你的服务端，不管它用什么语言写，也不用克隆仓库：

   ```sh
   npx -y -p protocol-chaos@0.2 protocol-chaos-conformance --stdio "node my-server.js --data {tmp}"
   ```

   套件每启动一个服务端，`{tmp}` 就换成一个新的空目录。测试会写数据，所以库不是空的就拒绝运行。

规范的目标是光看它就够写出实现。为了验证这一点，我们让一个从没见过任何实现的 Agent 只读这份文档写一个服务端。它第一次运行就通过了当时 40 项 Core 测试中的 39 项，它发现的那处缺口已经补进文档。这个服务端后来就成了这里的参考服务端。

## 你的数据

- 参考服务端默认把事情库保存在 <code>~/.protocol-chaos/repository.json</code>。它属于你，可以导出、搬到另一个合格的服务端（§8.6）。
- 参考服务端把库存在它所在电脑上的一个文件里。混沌协议没有自己的服务器，参考服务端也不往任何这类服务器发东西。会离开这台电脑的只有两样，都是发给你接上的某个 Agent 的模型、经由那个 Agent 的服务商：`init` 设了整理角色时，正在整理的那件事和它最近的原话；你同意导入时，导入读到的记忆文件的文字（密钥、令牌和长串数字会先遮掉）。用 HTTP 运行时，它只应答持有你发的令牌的助手。
- 目前每个接入的助手都能读到整个库，按客户端分别授权还没设计（§13）。只接入你愿意把全部内容交给它的助手。助手读到的内容会进入它的模型上下文，由它的服务商处理。
- 助手被要求永远不记录密码、令牌和证件号码（§7）。

## 现状与路线

参考服务端实现的是 **draft 0.2**。这版草案来自作者跨助手的日常使用，不承诺草案间兼容。仓库包含规范、兼容性测试和参考实现。匹配准确性、导入一致性、各宿主的真实会话验证仍在继续改进。

接下来：

- 持续验证 [Hermes 插件](../integrations/hermes/protocol-chaos/README.md)及其他客户端的记录、整理与读取。
- `init` 接更多的 Agent，每次几家：下一批是 Antigravity、Devin Desktop 和 Devin CLI、Cline、Kilo Code、Gemini CLI。欢迎为其他 Agent 提 PR：每个 Agent 就是 [server/install.mjs](../server/install.mjs) 里的一个对象。
- 按客户端分别授权：每个助手能读到什么（§13）。
- 跨应用认出同一个人（§13）。
- draft 0.3，从大家反馈的案例出发。

每个版本的变化见[更新记录](../CHANGELOG.md)。

## 常见问题

**我能安装什么？** 一套可以直接使用的 MCP 服务端，背后是一份开放协议和兼容性测试。你可以使用这个参考服务端，也可以自己实现相同的约定。

**只用一个助手有用吗？** 有。同一个助手的新对话可以接着使用已有事情；接入更多助手以后，它们共用这些记录。

**AI 账号失效了怎么办？** 已经保存在事情库里的数据仍在自己的电脑或服务器上，可以交给另一个兼容助手继续使用，也可以迁到另一个合格实现。尚未保存到库里的聊天记录，不在这个范围内。

**需要服务端吗？** 需要，任何合格的都行。参考服务端在你电脑上用一条命令就能跑起来。你也可以自己写一个，兼容性测试会告诉你写对了没有。

**哪些助手能用？** 任何 MCP 客户端。快速开始里写了一台电脑上的 Claude Code、Codex、Claude Desktop、Cursor 和 Kiro。用 HTTP（远程级别）运行时，其他电脑上的助手、能连到你服务器的云端助手，也能共用同一个库。

**我的数据在哪？** 事情库保存在你运行服务端的地方；助手读取、后台整理处理的内容，可能会发给相应助手的模型服务商。见[你的数据](#你的数据)。

## 参与

协议最需要的是来自真实使用的证据：它适用的案例、它不够用的案例，以及各种实现。

- **问题和想法：** [Discussions](https://github.com/chaos-xxl/protocol-chaos/discussions)
- **修改规范：** 从一个真实案例出发，提一个[提案](https://github.com/chaos-xxl/protocol-chaos/issues/new?template=spec_proposal.yml)
- **bug：** [issues](https://github.com/chaos-xxl/protocol-chaos/issues)
- **安全问题：** 私下报告，见 [SECURITY.md](../SECURITY.md)

改动怎么决定，见 [CONTRIBUTING.md](../CONTRIBUTING.md)（英文）。

## 关于

混沌协议由薛星龙（[@chaos-xxl](https://github.com/chaos-xxl)）创建，是混沌系列的一员，另一个是 Doctor Chaos。采用 [Apache License 2.0](../LICENSE) 许可。
