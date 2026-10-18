/**
 * MOOD 守卫 · 判定核心（纯函数，无宿主依赖）
 *
 * 判据来自思考块契约：看位置不看写法。
 * 一轮的正文流第一个块必须是该 agent 的思考块；前面只允许思考与工具调用。
 * 因此判定在「本轮第一条 assistant 正文」上做，而不是「最后一条 assistant 消息」——
 * 工具调用之间会留下多条没有正文的 assistant 消息。
 *
 * 三种思考模块（宿主的 yuan 定义，见 lib/yuan/*.md）：
 *   hanako → MOOD    <mood>
 *   butter → PULSE   <pulse>
 *   ming   → 沉思    <reflect>
 *   kong   → 无      不判定
 * 具体是哪种，由该会话 systemPrompt 里出现的那组标签决定，不在这里写死 agent 映射。
 */

/** 本 App 注入消息的 customType，同时用于识别自己的注入。 */
export const CUSTOM_TYPE = "mood-guard/reminder";

/** 已知思考模块：标签名与展示名。 */
export const THINKING_BLOCKS = Object.freeze({
  mood: Object.freeze({ tag: "mood", name: "MOOD" }),
  pulse: Object.freeze({ tag: "pulse", name: "PULSE" }),
  reflect: Object.freeze({ tag: "reflect", name: "沉思" }),
});

/** 可识别的标签，顺序即匹配优先级（互斥，不会同时出现在一份 persona 里）。 */
export const THINKING_TAGS = Object.freeze(["mood", "pulse", "reflect"]);

/**
 * 从 systemPrompt 认出该会话要求的思考块标签。
 * 要求开闭成对出现，避免正文里偶然提到的标签造成误认。
 * 返回 null 表示这个 agent 没有思考模块（kong 一档），应当完全不判定。
 */
export function detectThinkingTag(systemPrompt) {
  const text = typeof systemPrompt === "string" ? systemPrompt : "";
  if (!text) return null;
  for (const tag of THINKING_TAGS) {
    if (text.includes(`<${tag}>`) && text.includes(`</${tag}>`)) return tag;
  }
  return null;
}

/** 会话条目 → 归一化视图。宿主条目有 entry 包一层与裸消息两种形态。 */
export function normalizeEntry(entry) {
  const msg = entry && typeof entry === "object" && entry.message && typeof entry.message === "object"
    ? entry.message
    : entry;
  const injected = !!(msg?.origin || entry?.origin || msg?.source || entry?.source);
  const timestamp = typeof msg?.timestamp === "number"
    ? msg.timestamp
    : (typeof entry?.timestamp === "number" ? entry.timestamp : null);
  return {
    role: msg?.role ?? null,
    content: msg?.content,
    injected,
    timestamp,
  };
}

/** content（块数组或字符串）→ 第一段正文文本，跳过 thinking / tool_use 等非正文块。 */
export function firstTextBlock(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type && block.type !== "text") continue;
    if (typeof block.text === "string") return block.text;
  }
  return "";
}

/** 正文是否以指定标签开头（容忍前导空白）。 */
export function isBlockOpening(text, tag) {
  if (typeof text !== "string" || !tag) return false;
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*<${escaped}>`).test(text);
}

/** 兼容旧调用点：默认按 MOOD 判。 */
export function isMoodOpening(text) {
  return isBlockOpening(text, "mood");
}

/**
 * 本轮正文流的第一个块。
 * 本轮 = 最后一条真实用户消息之后；App 注入消息、assistant 的纯工具消息都跳过。
 * 没有真实用户消息（隔离 / 子代理会话）或本轮没有正文时返回 null。
 */
export function turnOpeningText(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const rows = entries.map(normalizeEntry);

  let turnStart = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === "user" && !rows[i].injected) {
      turnStart = i;
      break;
    }
  }
  if (turnStart < 0) return null;

  for (let i = turnStart + 1; i < rows.length; i += 1) {
    if (rows[i].role !== "assistant") continue;
    const text = firstTextBlock(rows[i].content);
    if (text.trim()) return text;
  }
  return null;
}

/**
 * 本轮是否漏了思考块。
 * - 本轮没有正文 → 不算漏（避免对纯工具轮次误报）
 * - tag 为空（该 agent 无思考模块）→ 永远不算漏
 */
export function inspectTurn(entries, tag = "mood") {
  const opening = turnOpeningText(entries);
  if (opening === null) return { missing: false, reason: "no-turn-text", opening: "" };
  if (!tag) return { missing: false, reason: "no-thinking-block", opening: opening.slice(0, 32) };
  if (isBlockOpening(opening, tag)) return { missing: false, reason: "ok", opening: opening.slice(0, 32) };
  return { missing: true, reason: "missing", opening: opening.slice(0, 32) };
}

/**
 * 按思考块生成默认提示文案。
 * 外层标签统一为 thinking_guard：同一个守卫服务三种模块，不按模块换外壳。
 * 内层只用标签名，不拼区块名——中英文混拼会在中文那档挤出空格缝，同构也更像同一套制度。
 */
export function buildReminderText(template, tag = "mood") {
  const custom = typeof template === "string" ? template.trim() : "";
  if (custom) return custom;
  const block = THINKING_BLOCKS[tag] ?? THINKING_BLOCKS.mood;
  return [
    "<thinking_guard>",
    `上轮正文未以 <${block.tag}> 块起始，不满足平台契约。`,
    `判据：正文流首块须为 <${block.tag}> 块；思考与工具调用不计入正文，可先行。`,
    "范围：每条新消息对应一轮，每轮一次。",
    "</thinking_guard>",
  ].join("\n");
}

export const DEFAULT_REMINDER_TEXT = buildReminderText("", "mood");

/** 配置归一化：非法值回落到默认，不让一个坏设置拖死整条链路。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: src.enabled !== false,
    reminderText: typeof src.reminderText === "string" ? src.reminderText.trim() : "",
  };
}
