/**
 * 思考块守卫 · 判定核心单测
 * 跑法：node test/mood-core.test.mjs
 */
import assert from "node:assert/strict";
import {
  CUSTOM_TYPE,
  DEFAULT_REMINDER_TEXT,
  buildReminderText,
  detectThinkingTag,
  firstTextBlock,
  inspectTurn,
  isBlockOpening,
  isMoodOpening,
  normalizeConfig,
  normalizeEntry,
  turnOpeningText,
} from "../lib/mood-core.js";

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolOnly = () => ({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read" }] });
const thinkingThenText = (thinking, text) => ({
  role: "assistant",
  content: [{ type: "thinking", thinking }, { type: "text", text }],
});
const injectedUser = (text) => ({ role: "user", content: [{ type: "text", text }], origin: { kind: "app" } });

console.log("mood-core");

check("正文以 <mood> 开头 → 不漏", () => {
  const r = inspectTurn([user("继续"), assistant("<mood>\nVibe: 平静\n</mood>\n正文")]);
  assert.equal(r.missing, false);
  assert.equal(r.reason, "ok");
});

check("正文先出口 → 漏", () => {
  const r = inspectTurn([user("继续"), assistant("先说结论：不行。")]);
  assert.equal(r.missing, true);
  assert.equal(r.reason, "missing");
});

check("前导空白 / 换行不误判", () => {
  assert.equal(isMoodOpening("\n\n  <mood>\nVibe: x"), true);
  assert.equal(isMoodOpening("<mood>"), true);
  assert.equal(isMoodOpening("<MOOD>"), false);
});

check("thinking 块不算正文，其后 text 才是开头", () => {
  const text = firstTextBlock(thinkingThenText("先想想", "<mood>Vibe: 好</mood>").content);
  assert.equal(text, "<mood>Vibe: 好</mood>");
  const r = inspectTurn([user("继续"), thinkingThenText("先想想", "<mood>Vibe: 好</mood>")]);
  assert.equal(r.missing, false);
});

check("工具轮次不误报：最后一条是无正文的 tool_use", () => {
  const entries = [user("查一下"), assistant("<mood>Vibe: 专注</mood>"), toolOnly(), toolOnly()];
  assert.equal(inspectTurn(entries).missing, false);
  const bad = [user("查一下"), assistant("我来看下文件。"), toolOnly()];
  assert.equal(inspectTurn(bad).missing, true);
});

check("只取本轮：上一轮的缺失不影响本轮判定", () => {
  const entries = [
    user("第一问"),
    assistant("第一次就漏了"),
    user("第二问"),
    assistant("<mood>Vibe: 恢复</mood>"),
  ];
  assert.equal(inspectTurn(entries).missing, false);
});

check("App 注入的用户消息不算真实用户消息", () => {
  const entries = [user("原话"), assistant("<mood>Vibe: 好</mood>"), injectedUser("【完成守卫】kick")];
  assert.equal(turnOpeningText(entries), "<mood>Vibe: 好</mood>");
});

check("没有真实用户消息（隔离 / 子代理会话）→ 不判", () => {
  assert.equal(inspectTurn([]).reason, "no-turn-text");
  assert.equal(inspectTurn([assistant("<mood>x</mood>")]).reason, "no-turn-text");
  assert.equal(inspectTurn([injectedUser("注入")]).reason, "no-turn-text");
});

check("本轮只有用户消息、还没有回复 → 不判", () => {
  assert.equal(inspectTurn([user("刚发出去")]).missing, false);
});

check("entry 包一层 message 的形态可解析", () => {
  const wrapped = { message: { role: "assistant", content: [{ type: "text", text: "先说话" }] } };
  assert.equal(normalizeEntry(wrapped).role, "assistant");
  assert.equal(inspectTurn([user("q"), wrapped]).missing, true);
});

check("字符串 content 也能读", () => {
  assert.equal(firstTextBlock("纯字符串正文"), "纯字符串正文");
  assert.equal(inspectTurn([user("q"), { role: "assistant", content: "直接说话" }]).missing, true);
});

check("从 systemPrompt 认出三种思考块", () => {
  assert.equal(detectThinkingTag("最后，MOOD 区块要用 <mood></mood> 标签包住"), "mood");
  assert.equal(detectThinkingTag("<pulse>Vibe: x</pulse>"), "pulse");
  assert.equal(detectThinkingTag("<reflect>想清楚了</reflect>"), "reflect");
});

check("kong 一档：认不出标签 → 永不判定", () => {
  assert.equal(detectThinkingTag("你是一个语速很快的助手"), null);
  assert.equal(detectThinkingTag(""), null);
  assert.equal(detectThinkingTag(undefined), null);
  const r = inspectTurn([user("q"), assistant("直接说话")], null);
  assert.equal(r.missing, false);
  assert.equal(r.reason, "no-thinking-block");
});

check("开闭不成对不算认出（避免正文里顺带提到的标签误认）", () => {
  assert.equal(detectThinkingTag("提到 <mood> 但没有闭合"), null);
});

check("按各自标签判定，跨模块不误判", () => {
  const butter = [user("q"), assistant("<pulse>Vibe: 暖</pulse>")];
  assert.equal(inspectTurn(butter, "pulse").missing, false);
  const ming = [user("q"), assistant("<reflect>想清楚了</reflect>")];
  assert.equal(inspectTurn(ming, "reflect").missing, false);
  assert.equal(inspectTurn(ming, "mood").missing, true);
});

check("三种模块文案同构，只换内层标签", () => {
  const texts = { mood: buildReminderText("", "mood"), pulse: buildReminderText("", "pulse"), reflect: buildReminderText("", "reflect") };
  for (const [tag, text] of Object.entries(texts)) {
    assert.match(text, /^<thinking_guard>\n/);
    assert.match(text, new RegExp(`<${tag}> 块起始`));
    assert.match(text, /不满足平台契约/);
    assert.doesNotMatch(text, /失效/);
    assert.doesNotMatch(text, /mood_guard/);
  }
  const lines = Object.values(texts).map((t) => t.split("\n").length);
  assert.equal(new Set(lines).size, 1);
  assert.doesNotMatch(texts.reflect, /\s沉思\s/);
});

check("默认文案用结构标签包裹，且不会被自己的判定器当成思考块", () => {
  assert.match(DEFAULT_REMINDER_TEXT, /^<thinking_guard>\n/);
  assert.match(DEFAULT_REMINDER_TEXT, /\n<\/thinking_guard>$/);
  assert.match(DEFAULT_REMINDER_TEXT, /<mood> 块/);
  assert.equal(isBlockOpening("<thinking_guard>\n正文\n</thinking_guard>", "mood"), false);
});

check("标签匹配按字面处理，正则字符不生效", () => {
  assert.equal(isBlockOpening("<mood>", "mood"), true);
  assert.equal(isBlockOpening("<mood>", "mood>"), false);
});

check("文案模板：空白回落默认，自定义原样保留", () => {
  assert.equal(buildReminderText(""), DEFAULT_REMINDER_TEXT);
  assert.equal(buildReminderText("   "), DEFAULT_REMINDER_TEXT);
  assert.equal(buildReminderText("  自定义  "), "自定义");
});

check("配置归一化：缺省与非法值回落", () => {
  const d = normalizeConfig(null);
  assert.equal(d.enabled, true);
  assert.equal(d.reminderText, "");
  assert.equal(normalizeConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeConfig({ reminderText: "  x  " }).reminderText, "x");
  assert.equal(normalizeConfig("bogus").enabled, true);
});

check("注入标识稳定", () => {
  assert.equal(CUSTOM_TYPE, "mood-guard/reminder");
});

console.log(`\n${passed} 项断言通过`);
