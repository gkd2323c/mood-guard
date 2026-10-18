/**
 * 思考块守卫（mood-guard）· 主入口
 *
 * 职责：一轮回复的正文流没以该 agent 的思考块开头时，在用户下一条消息发出后，
 * 向该轮模型注入一条只给模型看的提示——不新起回合、不写进对话记录、
 * 不改用户消息。
 *
 * 覆盖宿主三种思考模块（hanako→<mood>、butter→<pulse>、ming→<reflect>），
 * 没有思考模块的 agent（kong）完全不判定。用哪种由该会话 systemPrompt
 * 里出现的那组标签决定，不在这里写死 agent 映射。
 *
 * 链路只有两跳：
 *   agent/settled（回合结束）→ 读条目判定本轮开头 → 缺失则记入内存队列
 *   agent/before-start（下一轮开始）→ 队列命中 → 返回 { message: { display:false } }
 *
 * 判定放在 settled 而不是 before-start：settled 时回合锁已释放，
 * 读 session:entries / session:context 不会和回合启动链互相等待；
 * before-start 只查内存，保证决策钩子同步返回。
 */
import { defineApp } from "./sdk/app-contract/server-client.js";
import {
  CUSTOM_TYPE,
  buildReminderText,
  detectThinkingTag,
  inspectTurn,
  normalizeConfig,
} from "./lib/mood-core.js";

export const name = "mood-guard";

const ENTRY_SCAN_DEPTH = 400;

export default defineApp(async (sdk) => {
  const log = (level, message) => {
    try {
      Promise.resolve(sdk.logger[level](`[mood-guard] ${message}`)).catch(() => {});
    } catch {
      /* logger 不可用时静默 */
    }
  };

  const shortRef = (p) => String(p ?? "").split(/[\\/]/).pop() || "?";

  // ── 配置 ──
  let config = normalizeConfig({});
  async function refreshConfig() {
    try {
      const all = await sdk.config.getAll();
      config = normalizeConfig(all);
    } catch (e) {
      log("warn", `config read failed, keeping current: ${e?.message || e}`);
    }
  }
  await refreshConfig();

  // ── 状态 ──
  /** sessionPath → 该会话缺失的思考块标签：等下一轮开场注入。 */
  const pending = new Map();
  /** sessionPath → 读 session:entries 时可用的 target，避免每次试错。 */
  const targets = new Map();
  /** sessionPath → 该会话的思考块标签（null = 无思考模块）。 */
  const blocks = new Map();

  /** 路径比对归一化：大小写与斜杠方向不敏感。 */
  const normalizePath = (p) => String(p ?? "").replace(/\//g, "\\").toLowerCase();

  /**
   * 找到能读该会话的 target。
   * 宿主的 manifest 只认清单里的 canonical sessionId（sess_*）：invocation 给的是
   * pi 的 sessionId 和一条裸路径，两者都会被拒，所以先用 session:list 按路径
   * 反查 canonical id 并缓存；缓存失效时由 readEntries 重查一次。
   */
  async function resolveTarget(sessionPath, sessionId) {
    const cached = targets.get(sessionPath);
    if (cached) return cached;

    try {
      const list = await sdk.sessions.list({ scope: "all", lifecycle: "active" });
      const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
      const wanted = normalizePath(sessionPath);
      const hit = sessions.find((s) => typeof s?.path === "string" && normalizePath(s.path) === wanted);
      if (hit?.sessionId) {
        const target = { sessionId: hit.sessionId };
        targets.set(sessionPath, target);
        return target;
      }
      log("info", `no manifest session for ${shortRef(sessionPath)} (n=${sessions.length}), falling back`);
    } catch (e) {
      log("warn", `session:list failed: ${e?.message || e}`);
    }

    if (sessionId) return { sessionId };
    throw new Error("no resolvable session target");
  }

  async function entriesOf(target) {
    const res = await sdk.sessions.entries({ ...target, scope: "all" });
    return Array.isArray(res?.entries) ? res.entries.slice(-ENTRY_SCAN_DEPTH) : [];
  }

  async function readEntries(sessionPath, sessionId) {
    const first = await resolveTarget(sessionPath, sessionId);
    try {
      return await entriesOf(first);
    } catch (e) {
      targets.delete(sessionPath);
      log("info", `entries read failed on cached target, re-resolving: ${e?.message || e}`);
      return await entriesOf(await resolveTarget(sessionPath, sessionId));
    }
  }

  /**
   * 该会话要求的思考块标签。
   * 从 systemPrompt 认：那里带着该 agent 实际生效的那份 persona。
   * 读取失败返回 undefined（本轮不判），确认无模块返回 null（永久静默）。
   */
  async function resolveThinkingTag(sessionPath, target) {
    if (blocks.has(sessionPath)) return blocks.get(sessionPath);
    try {
      const ctx = await sdk.sessions.context({ ...target, scope: "all" });
      const tag = detectThinkingTag(ctx?.systemPrompt);
      blocks.set(sessionPath, tag);
      log("info", `thinking block resolved: ${tag ?? "none"} (${shortRef(sessionPath)})`);
      return tag;
    } catch (e) {
      log("warn", `context read failed: ${e?.message || e}`);
      return undefined;
    }
  }

  // ── 1. 回合结束：判定本轮正文开头 ──
  try {
    await sdk.hooks.on("agent/settled", (invocation) => {
      const sessionPath = invocation?.session?.sessionPath ?? null;
      const sessionId = invocation?.session?.sessionId ?? null;
      if (!sessionPath) return;
      handleSettled({ sessionPath, sessionId }).catch((e) => {
        log("warn", `settled handling failed: ${e?.message || e}`);
      });
    });
  } catch (e) {
    log("warn", `agent/settled registration failed: ${e?.message || e}`);
  }

  async function handleSettled({ sessionPath, sessionId }) {
    if (!config.enabled) {
      pending.delete(sessionPath);
      return;
    }

    let target;
    try {
      target = await resolveTarget(sessionPath, sessionId);
    } catch (e) {
      log("warn", `no target for ${shortRef(sessionPath)}: ${e?.message || e}`);
      return;
    }

    const tag = await resolveThinkingTag(sessionPath, target);
    if (tag === undefined) return;
    if (tag === null) {
      if (pending.delete(sessionPath)) log("info", `queue cleared (no thinking block) in ${shortRef(sessionPath)}`);
      return;
    }

    let entries;
    try {
      entries = await readEntries(sessionPath, sessionId);
    } catch (e) {
      log("warn", `entries read failed for ${shortRef(sessionPath)}: ${e?.message || e}`);
      return;
    }

    const verdict = inspectTurn(entries, tag);
    if (!verdict.missing) {
      if (pending.delete(sessionPath)) log("info", `${tag} present, queue cleared (${shortRef(sessionPath)})`);
      return;
    }

    pending.set(sessionPath, tag);
    log("info", `${tag} missing, queued in ${shortRef(sessionPath)} opening=${JSON.stringify(verdict.opening)}`);
  }

  // ── 2. 下一轮开始：注入隐身提示 ──
  try {
    await sdk.hooks.onDecision("agent/before-start", (invocation) => {
      const sessionPath = invocation?.session?.sessionPath ?? null;
      if (!sessionPath) return undefined;

      const tag = pending.get(sessionPath);
      if (!tag) return undefined;
      pending.delete(sessionPath);

      if (!config.enabled) return undefined;

      log("info", `reminder injected (block=${tag}) in ${shortRef(sessionPath)}`);
      return {
        message: {
          customType: CUSTOM_TYPE,
          content: buildReminderText(config.reminderText, tag),
          display: false,
        },
      };
    });
  } catch (e) {
    log("warn", `agent/before-start registration failed: ${e?.message || e}`);
  }

  log("info", "ready");
});
