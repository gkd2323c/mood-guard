# 思考块守卫（mood-guard）

Hana v2 App。一轮回复的正文流没有以该 agent 的思考块开头时，在用户下一条消息发出后，向那一轮模型注入一条**只给模型看**的提示。

不新起回合、不进对话记录、不改用户消息。这是与「回合结束后补发一条消息」那类守卫的根本区别：后者每次都会多出一轮没有用户输入的对话。

## 安装

把整个目录放到 HanaAgent 的 App 目录下，文件夹名保持 `mood-guard`：

```
<HANA_HOME>/apps/mood-guard/
```

`<HANA_HOME>` 默认是用户目录下的 `.hanako`（Windows 即 `%USERPROFILE%\.hanako`）。放好后重载 App 或重启，在「设置 → 应用」里授予 `app/hooks.observe`、`app/hooks.agent-before-start`、`app/sessions.read` 三项能力即可（见「权限」）。

`sdk/` 是 HanaAgent 宿主 SDK 的随包副本，让 App 不依赖宿主的 `node_modules`。升级宿主后可以用新版本的副本覆盖它，不要手改。

## 覆盖范围

宿主的四种人格底座各带一种思考模块：

| yuan   | 区块名 | 标签        | 本 App       |
| ------ | ------ | ----------- | ------------ |
| hanako | MOOD   | `<mood>`    | 判定         |
| butter | PULSE  | `<pulse>`   | 判定         |
| ming   | 沉思   | `<reflect>` | 判定         |
| kong   | 无     | —           | 不判定，静默 |

用哪种不写死在代码里：会话的 `systemPrompt` 带着该 agent 实际生效的 persona，从里面认出哪组标签被要求（组内开闭标签成对出现才算认出）。认不出任何一组即视为无思考模块。

## 链路

```
agent/settled（回合结束，锁已释放）
   │  读 session:context 定标签（一次，缓存）
   │  读 session:entries，取最后一条真实用户消息之后的第一条 assistant 正文
   ▼
判定：正文是否以该标签开头（看位置，不看写法）
   ├─ 是 / 本轮无正文 / 无思考模块 ──→ 清空该会话队列，不打扰
   └─ 否 ──→ 记入内存队列（下一轮开场注入）
                    │
                    ▼
agent/before-start（用户下一条消息提交，新一轮开始）
   │  只查内存，不做 IO（保证决策钩子同步返回）
   └─ 命中 ──→ 返回 { message: { customType, content, display: false } }
```

判定放在 `settled` 而不是 `before-start`：回合结束时会话锁已释放，读条目与读上下文不会和回合启动链互相等待；`before-start` 因此保持纯内存判断。

## 判定规则

- 一轮的正文流第一个块必须是思考块，前面只允许思考与工具调用。
- 「本轮第一条 assistant 正文」才是判定对象。工具调用之间会产生多条没有正文的 assistant 消息，取最后一条会误判。
- App 注入的用户消息（带 `origin` / `source` 标记）不算真实用户消息。
- 本轮没有正文（纯工具轮次、隔离会话、子代理会话）不判，避免误报。
- 大小写敏感：`<MOOD>` 不算合规开头。

## 注入形态

```
<thinking_guard>
上轮正文未以 <mood> 块起始，不满足平台契约。
判据：正文流首块须为 <mood> 块；思考与工具调用不计入正文，可先行。
范围：每条新消息对应一轮，每轮一次。
</thinking_guard>
```

外层标签统一为 `thinking_guard`：一个守卫服务三种模块，不按模块换外壳。内层标签随该会话替换（`<mood>` / `<pulse>` / `<reflect>`），三种文案逐行同构，只差这个标签。

只用标签名、不拼区块名：中英文混拼会在中文那档挤出空格缝（「该轮 沉思 失效」），同构也比丰富更像同一套制度。`<thinking_guard>` 同时是检索锚点，grep 一个词即可捞出全部注入记录。

## 权限

| 能力                           | 用途                                      |
| ------------------------------ | ----------------------------------------- |
| `app/hooks.observe`            | 观察 `agent/settled` 生命周期事件         |
| `app/hooks.agent-before-start` | 在回合开始前返回注入消息                  |
| `app/sessions.read`            | 读 `session:entries` 与 `session:context` |

不需要 `app/sessions.manage` 与 `app/session.start-turn`：本 App 不写会话、不起回合。

## 设置

- **启用守卫**：总开关。
- **提示文案**：留空按当前会话的思考块自动生成。

## 已知边界

- **当轮不可补**：判据看位置，正文一出口该轮即不满足契约，注入只能让下一轮恢复。
- **队列在内存**：宿主重启后清空，重启后的第一轮不会提示；后续重新积累。
- **时序窗口**：`settled` 处理完成前用户就发出下一条消息时，该次提示会漏，下一轮重新判定。
- **判据只看开头**：不评价思考块内容质量，只判断位置。
- **会话读取要 canonical id**：`session:entries` 只认同清单里的 `sess_*`。钩子事件给的是 pi 的 sessionId 与一条裸路径，两者都会被拒，必须先经 `session:list` 按路径反查规范 id。
- **标签来自 persona**：`systemPrompt` 读不到时本轮跳过且不缓存失败，避免在未知人格上误判。
- **不处理多个思考块**：一轮里出现多个思考块时，平台逐块正常渲染，用户体验无损失；判据只看首块位置、不数数量，因此不做任何限制或告警。多个块最多算那一轮写得啰嗦，不属于格式问题。不要为此加检查。
- **标签缓存不失效**：`blocks` 以会话路径为键，同一会话中途更换人格底座时不会重认标签（重载 App 或新会话才会）。
- **扫描窗口有限**：只回看最近 400 条条目，超长单轮的正文起点会滑出窗口，那一轮不判（静默降级，不会误报）。

## 验证

- 判定核心单测：`node test/mood-core.test.mjs`（21 项断言，覆盖三种标签、无模块静默、开闭不成对、工具轮次、注入消息、thinking 块、配置边界）
- 官方静态校验：0 error / 0 warning
- 官方隔离启动校验（`--smoke`）：后端 `loaded`
- 真机实测（2026-10-18）：`settled` 判定 → 排队 → 下一轮 `before-start` 注入，会话记录出现独立 `custom_message` 条目（`customType: mood-guard/reminder`、`display: false`），模型上下文可读到该提示。
- 可见性：数据层 `display: false` 已正确落盘；界面是否渲染该标记以实机观察为准。
