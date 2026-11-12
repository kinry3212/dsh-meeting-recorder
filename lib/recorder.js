/**
 * 记录员：读事件 → 折轮次 → 调独立模型 → 落盘。
 *
 * 记录员不占主会话：自己的 system prompt、自己的 messages、自己的 maxTokens，
 * 结果只写插件目录，不往主会话注入任何东西。
 *
 * @module dsh-meeting-recorder/recorder
 */
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
import { collectTurns, lastSeqOf, latestRoute, selectPending } from "./fold.js";
import { SYSTEM_PROMPT, buildUserInput, normalizeMarkdown } from "./format.js";
import { emptyState, isEnabled, readState, writeState } from "./store.js";

/** 读会话事件：在线会话走内存快照，冷会话走持久化层。 */
export async function readSessionEvents(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId);
  if (live !== undefined) return live.snapshotEvents();
  const handle = await ctx.sessionPersistence.open(sessionId, "read");
  try {
    const { events } = await handle.read();
    return events;
  } finally {
    await handle.close();
  }
}

/** 一次模型调用，返回纯文本。超时由 AbortController 兜住。 */
async function callModel(ctx, { provider, model, sessionId, input, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("meeting-recorder: model call timed out")), timeoutMs);
  try {
    const call = await ctx.llm.prepareCall({ provider, model, maxTokens }, controller.signal, (controls) => controls);
    const options = deepFreeze({
      ...call.config,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: input }],
          source: { kind: "meeting-recorder" },
        }),
      ],
      system: SYSTEM_PROMPT,
      sessionId,
      signal: controller.signal,
    });
    const assembler = new BlockAssembler();
    for await (const chunk of call.stream(options)) assembler.push(chunk);
    const blocks = assembler.blocks();
    return blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一次更新。返回 { ran, reason?, markdown?, pending? }。
 * 开关关闭、没有新材料、模型不可用都会返回 ran:false 并带原因，不抛。
 */
export async function runOnce(ctx, config, sessionId, options = {}) {
  const dir = config.storageDir;
  const state = (await readState(dir, sessionId)) ?? emptyState(sessionId);
  if (!options.force && !isEnabled(state, config.autoEnable)) {
    return { ran: false, reason: "disabled" };
  }

  const events = await readSessionEvents(ctx, sessionId);
  const turns = collectTurns(events);
  const { pending, advancedTo } = selectPending(turns, state.cursorSeq);
  if (pending.length === 0) {
    state.lastSeq = lastSeqOf(events);
    await writeState(dir, sessionId, state);
    return { ran: false, reason: "nothing-new" };
  }

  const route = config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model }
    : (state.route ?? latestRoute(events));
  if (route === undefined) {
    state.lastError = "no route: 会话日志里没有 request/header，配置里也没给 provider/model";
    await writeState(dir, sessionId, state);
    return { ran: false, reason: "no-route", error: state.lastError };
  }

  const backfill = options.backfill ?? state.markdown.length === 0;
  const built = buildUserInput({
    previousMarkdown: state.markdown,
    turns: pending,
    backfill,
    limits: {
      userChars: config.userChars,
      assistantChars: config.assistantChars,
      reasoningChars: config.reasoningChars,
      totalChars: config.totalChars,
    },
  });
  const input = built.input;
  const included = built.included.length > 0 ? built.included : pending.slice(0, 1);

  let raw;
  try {
    raw = await callModel(ctx, {
      provider: route.provider,
      model: route.model,
      sessionId,
      input,
      maxTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    await writeState(dir, sessionId, state);
    return { ran: false, reason: "model-error", error: state.lastError };
  }

  const markdown = normalizeMarkdown(raw);
  if (markdown.length === 0) {
    state.lastError = "model returned empty text";
    await writeState(dir, sessionId, state);
    return { ran: false, reason: "empty-output" };
  }

  const recordedTo = included[included.length - 1];
  const cursorSeq = recordedTo.endSeq ?? recordedTo.assistantSeq ?? recordedTo.startSeq ?? advancedTo;
  const next = {
    ...state,
    markdown,
    // 游标只推进到「真正写进输入」的最后一轮：预算不足被延后的轮次下次还能被选中
    cursorSeq,
    lastSeq: lastSeqOf(events),
    route,
    updatedAt: Date.now(),
    lastError: null,
    runs: [
      ...(Array.isArray(state.runs) ? state.runs : []),
      {
        at: Date.now(),
        turns: included.length,
        fromSeq: included[0].assistantSeq ?? included[0].startSeq,
        toSeq: recordedTo.assistantSeq ?? recordedTo.startSeq,
        deferred: pending.length - included.length,
        backfill,
        provider: route.provider,
        model: route.model,
        chars: markdown.length,
      },
    ].slice(-40),
  };
  await writeState(dir, sessionId, next);
  return {
    ran: true,
    markdown,
    pending: pending.length,
    deferred: pending.length - included.length,
    cursor: cursorSeq,
    cursorFrom: state.cursorSeq,
    backfill,
    route,
  };
}

/** 把记录渲染成命令输出用的短摘要。 */
export function summarize(state) {
  if (!state || typeof state.markdown !== "string" || state.markdown.length === 0) {
    return "还没有记录。用 /record on 开启，或 /record rebuild 立即重建。";
  }
  const lines = state.markdown.split("\n");
  const title = lines.find((line) => line.startsWith("# ")) ?? "# 会议记录";
  const when = state.updatedAt > 0 ? new Date(state.updatedAt).toLocaleString("zh-CN") : "未更新";
  return [
    title,
    `更新时间：${when}`,
    `游标：seq ${state.cursorSeq}（已处理到这条助手消息）`,
    `运行次数：${Array.isArray(state.runs) ? state.runs.length : 0}`,
    state.lastError ? `上次错误：${state.lastError}` : "",
  ].filter((line) => line.length > 0).join("\n");
}
