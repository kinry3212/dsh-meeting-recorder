/**
 * DSH 会议记录插件（host 半边）。
 *
 * 职责：监听会话事件 → 在每轮结束后把新增材料交给独立模型 → 落一份随时可查的
 * 会议记录。开关、查看、重建走 `/record` 命令。
 *
 * 边界：不向主会话注入任何内容；不读 tool/* 事件；不写会话日志（见 store.js 注释）。
 *
 * @module dsh-meeting-recorder
 */
import s from "@deepseek-ai/schemastery";
import { nextDrain } from "./drain.js";
import { runOnce, summarize } from "./recorder.js";
import { defaultStorageDir, emptyState, jsonPath, markdownPath, readState, writeState } from "./store.js";

export const name = "meeting-recorder";

export const inject = ["sessions", "llm", "sessionPersistence"];

export const Config = s.object({
  autoEnable: s.boolean().default(false),
  provider: s.string(),
  model: s.string(),
  maxOutputTokens: s.number().step(1).min(64).default(6000),
  timeoutMs: s.number().step(1).min(1000).default(180000),
  userChars: s.number().step(1).min(200).default(3000),
  assistantChars: s.number().step(1).min(200).default(6000),
  reasoningChars: s.number().step(1).min(0).default(0),
  totalChars: s.number().step(1).min(4000).default(60000),
  maxDrain: s.number().step(1).min(1).default(5),
  storageDir: s.string(),
  debounceMs: s.number().step(1).min(0).default(1500),
  debug: s.boolean().default(false),
});

const USAGE = "用法：/record [on|off|show|rebuild|file]";

/** 把 Loader 传入的配置补成完整配置（未给的字段走默认值）。 */
export function resolveConfig(raw) {
  const config = raw ?? {};
  return {
    autoEnable: config.autoEnable === true,
    provider: typeof config.provider === "string" && config.provider.length > 0 ? config.provider : undefined,
    model: typeof config.model === "string" && config.model.length > 0 ? config.model : undefined,
    maxOutputTokens: Number.isSafeInteger(config.maxOutputTokens) ? config.maxOutputTokens : 6000,
    timeoutMs: Number.isSafeInteger(config.timeoutMs) ? config.timeoutMs : 180000,
    userChars: Number.isSafeInteger(config.userChars) ? config.userChars : 3000,
    assistantChars: Number.isSafeInteger(config.assistantChars) ? config.assistantChars : 6000,
    reasoningChars: Number.isSafeInteger(config.reasoningChars) && config.reasoningChars >= 0 ? config.reasoningChars : 0,
    totalChars: Number.isSafeInteger(config.totalChars) ? config.totalChars : 60000,
    maxDrain: Number.isSafeInteger(config.maxDrain) && config.maxDrain > 0 ? config.maxDrain : 5,
    storageDir: typeof config.storageDir === "string" && config.storageDir.length > 0 ? config.storageDir : defaultStorageDir(),
    debounceMs: Number.isSafeInteger(config.debounceMs) ? config.debounceMs : 1500,
    debug: config.debug === true,
  };
}

/** 会话对象上取 id，兼容 `session.id` 与 `session.header.id`。 */
function sessionIdOf(session) {
  const id = session?.id ?? session?.header?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();
  /** @type {Map<string, number>} 因预算延后的轮次自动续跑的次数，防止跑飞 */
  const drainRounds = new Map();

  const log = (level, ...args) => {
    const logger = ctx.logger;
    if (logger && typeof logger[level] === "function") logger[level]("[meeting-recorder]", ...args);
    if (config.debug) {
      const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" ")}\n`;
      void import("node:fs/promises")
        .then(({ appendFile, mkdir }) => mkdir(config.storageDir, { recursive: true }).then(() => appendFile(`${config.storageDir}/_debug.log`, line, "utf8")))
        .catch(() => undefined);
    }
  };

  /** 同一会话串行执行，避免两次更新抢同一份状态。 */
  function update(sessionId, options) {
    log("info", `update start ${sessionId} ${JSON.stringify(options ?? {})}`);
    const prev = tails.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => runOnce(ctx, config, sessionId, options))
      .then((result) => {
        log("info", `update done ${sessionId} ${JSON.stringify(result).slice(0, 300)}`);
        // 预算放不下的轮次：自动接着跑，但设两道闸（游标未前进 / 次数到 maxDrain）见 drain.js
        const decision = nextDrain({
          ran: result.ran === true,
          deferred: result.deferred ?? 0,
          cursor: result.cursor,
          cursorFrom: result.cursorFrom,
          rounds: drainRounds.get(sessionId) ?? 0,
          maxDrain: config.maxDrain,
        });
        if (decision.reason === "stalled") {
          log("warn", `游标没有前进（${result.cursorFrom} → ${result.cursor}），停止自动续跑，避免空转烧 token`);
        } else if (decision.reason === "max-rounds") {
          log("warn", `还有 ${result.deferred} 轮未纳入，已达自动续跑上限 maxDrain=${config.maxDrain}，等下次触发`);
        }
        if (decision.drain) {
          drainRounds.set(sessionId, decision.rounds);
          log("info", `deferred ${result.deferred} 轮，自动续跑第 ${decision.rounds} 次`);
          schedule(sessionId, options ?? {});
        } else {
          drainRounds.delete(sessionId);
        }
        return result;
      })
      .catch((error) => {
        log("warn", `update failed ${sessionId}`, error);
        return { ran: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
      });
    tails.set(sessionId, next.then(() => undefined, () => undefined));
    return next;
  }

  function schedule(sessionId, options) {
    const existing = timers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      void update(sessionId, options ?? {});
    }, config.debounceMs);
    if (typeof timer.unref === "function") timer.unref();
    timers.set(sessionId, timer);
  }

  /**
   * 会话一有动静就先落一个空状态文件。
   * 这样即使本次进程在记录员调用返回前就退出（headless、关窗口），
   * 下次加载也能从游标处续接补记，不会整段丢掉。
   */
  async function ensureState(sessionId) {
    if ((await readState(config.storageDir, sessionId)) !== null) return;
    const state = emptyState(sessionId);
    if (state.override === null && !config.autoEnable) return;
    await writeState(config.storageDir, sessionId, state);
  }

  // 每轮结束触发一次增量更新。
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return;
    const sessionId = sessionIdOf(session);
    if (sessionId === undefined) return;
    void ensureState(sessionId).catch((error) => log("warn", "初始化记录文件失败", error));
    schedule(sessionId, {});
  });

  // 卸载/退出前把还没跑的那次更新跑完，避免最后一轮的记录丢掉。
  ctx.effect(() => () => {
    const pendingSessions = [...timers.keys()];
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    const jobs = [
      ...pendingSessions.map((sessionId) => update(sessionId, {})),
      ...[...tails.values()].map((tail) => tail.catch(() => undefined)),
    ];
    return Promise.allSettled(jobs).then(() => undefined);
  }, "meeting-recorder.flush");

  /** 打开一个会话的记录文件（不存在则建空壳）。 */
  async function loadState(sessionId) {
    return (await readState(config.storageDir, sessionId)) ?? emptyState(sessionId);
  }

  async function handleCommand(invocation) {
    const session = invocation?.agent?.session;
    const sessionId = sessionIdOf(session);
    if (sessionId === undefined) return { kind: "error", text: "当前没有活动会话，会议记录挂在会话上。" };
    const arg = String(invocation?.rawInput ?? "").trim().toLowerCase();
    const state = await loadState(sessionId);

    switch (arg) {
      case "":
      case "show":
      case "status": {
        return {
          kind: "success",
          text: [
            summarize(state),
            `开关：${state.override ?? "跟随配置"}（配置 autoEnable=${config.autoEnable}）`,
            `文件：${markdownPath(config.storageDir, sessionId)}`,
            `状态：${state.status}`,
            state.markdown.length > 0 ? `\n---\n${state.markdown}` : "",
          ].filter((line) => line.length > 0).join("\n"),
        };
      }
      case "on": {
        state.override = "on";
        await writeState(config.storageDir, sessionId, state);
        const result = await update(sessionId, { backfill: state.markdown.length === 0 });
        const recorded = result.pending - (result.deferred ?? 0);
        return {
          kind: "success",
          text: result.ran
            ? `已开启会议记录，并对历史做了补记（${recorded} 轮${result.deferred > 0 ? `，另有 ${result.deferred} 轮因预算排队，后台继续` : ""}）。\n${summarize(await loadState(sessionId))}`
            : `已开启会议记录。${result.reason === "nothing-new" ? "当前没有可记录的新轮次。" : `本次未生成：${result.reason}${result.error ? `（${result.error}）` : ""}`}`,
        };
      }
      case "off": {
        state.override = "off";
        await writeState(config.storageDir, sessionId, state);
        return { kind: "success", text: "已关闭会议记录。已写下的内容保留，状态不自动置为 final。" };
      }
      case "rebuild": {
        state.override = "on";
        state.cursorSeq = 0;
        state.markdown = "";
        state.runs = [];
        await writeState(config.storageDir, sessionId, state);
        const result = await update(sessionId, { force: true, backfill: true });
        const recorded = result.pending - (result.deferred ?? 0);
        return {
          kind: result.ran ? "success" : "error",
          text: result.ran
            ? `已重建记录（${recorded} 轮${result.deferred > 0 ? `，另有 ${result.deferred} 轮因预算排队，后台继续` : ""}）。\n${summarize(await loadState(sessionId))}`
            : `重建失败：${result.reason}${result.error ? `（${result.error}）` : ""}`,
        };
      }
      case "file": {
        return {
          kind: "success",
          text: `记录：${markdownPath(config.storageDir, sessionId)}\n状态：${jsonPath(config.storageDir, sessionId)}`,
        };
      }
      default:
        return { kind: "error", text: USAGE };
    }
  }

  const commands = ctx.get("commands");
  if (commands !== undefined && typeof commands.register === "function") {
    commands.register({
      definitionId: "dsh-meeting-recorder",
      name: "record",
      description: "会议记录：开关、查看、重建当前会话的记录",
      input: { hint: "[on|off|show|rebuild|file]" },
      handler: handleCommand,
    });
  } else {
    log("warn", "commands service 不可用，/record 命令未注册");
  }

  // 续接补记：插件（重新）加载后，把已开启但落后的会话补一次。
  ctx.effect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(config.storageDir).catch(() => []);
        log("info", `resume scan ${config.storageDir}: ${files.length} 个文件`);
        for (const file of files) {
          if (cancelled) return;
          if (!file.endsWith(".json")) continue;
          const sessionId = file.slice(0, -".json".length);
          const state = await readState(config.storageDir, sessionId);
          if (state === null) continue;
          const enabled = state.override === "on" || (state.override === null && config.autoEnable);
          if (!enabled) continue;
          log("info", `resume schedule ${sessionId} cursor=${state.cursorSeq}`);
          schedule(sessionId, {});
        }
      } catch (error) {
        log("warn", "续接补记扫描失败", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, "meeting-recorder.resume");
}

export default { name, inject, Config, apply };
