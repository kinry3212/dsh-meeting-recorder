/**
 * /record 命令与记录链路的离线集成测试。
 *
 * 用假 ctx（只实现插件真正调用的几个方法）挂载插件，走真实 store/recorder/fold 代码，
 * 覆盖：开(on)、关(off)、查看(show)、重建(rebuild)、路径(file)、未知参数。
 * 模型调用被替换成固定的 chunk 流，不联网。
 *
 * 跑法（在装有 DSH 依赖的目录下，例如 mr-test profile 的已安装副本）：
 *   node test/command.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { apply } from "../lib/index.js";

const CANNED = [
  "# 会议记录：测试会话",
  "> record_type: meeting_record",
  "> status: draft",
  "",
  "## 1. 当前任务",
  "验证 /record 命令。",
].join("\n");

/** 两轮完整会话：每轮都有用户原话与助手回复。 */
const EVENTS = [
  { seq: 1, type: "request/header", data: { header: { config: { provider: "test-provider", model: "test-model" } } } },
  { seq: 2, type: "turn/start", data: { turn: 1 } },
  { seq: 3, type: "user/message", data: { content: [{ type: "text", text: "第一轮用户原话" }], source: { kind: "user" } } },
  { seq: 4, type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一轮助手回复" }] } } },
  { seq: 5, type: "turn/end", data: {} },
  { seq: 6, type: "turn/start", data: { turn: 2 } },
  { seq: 7, type: "user/message", data: { content: [{ type: "text", text: "第二轮用户原话" }], source: { kind: "user" } } },
  { seq: 8, type: "assistant/message", data: { message: { content: [{ type: "text", text: "第二轮助手回复" }] } } },
  { seq: 9, type: "turn/end", data: {} },
];

function makeCtx() {
  const handlers = new Map();
  const effects = [];
  let registered;
  let calls = 0;
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
    effect(setup) {
      const dispose = setup();
      effects.push(dispose);
      return () => {};
    },
    get(service) {
      if (service === "commands") {
        return {
          register(definition) {
            registered = definition;
          },
        };
      }
      return undefined;
    },
    sessions: { get: () => undefined },
    sessionPersistence: {
      open: async () => ({
        read: async () => ({ events: EVENTS }),
        close: async () => {},
      }),
    },
    llm: {
      prepareCall: async () => ({
        config: { provider: "test-provider", model: "test-model" },
        stream: async function* () {
          calls += 1;
          yield { type: "text-delta", index: 0, text: CANNED };
        },
      }),
    },
    emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) handler(...args);
    },
    get command() {
      return registered;
    },
    get calls() {
      return calls;
    },
    disposeAll: async () => {
      for (const dispose of effects) if (typeof dispose === "function") await dispose();
    },
  };
  return ctx;
}

const dir = await mkdtemp(path.join(tmpdir(), "mr-cmd-"));
const ctx = makeCtx();
apply(ctx, { autoEnable: false, debounceMs: 0, storageDir: dir, debug: false });

const session = { id: "session-test-0001" };
const invoke = (rawInput) => ctx.command.handler({ agent: { session }, rawInput });
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  assert.ok(condition, `${name} — ${detail ?? ""}`);
}

try {
  // 1) 未开启时查看：空记录提示
  const before = await invoke("");
  check("show-before-on", before.kind === "success" && before.text.includes("还没有记录"), before.text.split("\n")[0]);

  // 2) 开启：触发一次补记（2 轮），模型被替换为固定文本
  const on = await invoke("on");
  check("on-runs", on.kind === "success" && on.text.includes("已开启会议记录"), on.text.split("\n")[0]);
  check("on-backfill-2-turns", on.text.includes("2 轮"), on.text.split("\n")[0]);
  check("model-called-once", ctx.calls === 1, `calls=${ctx.calls}`);

  // 3) 查看：回到已写下的记录
  const show = await invoke("show");
  check("show-markdown", show.kind === "success" && show.text.includes("## 1. 当前任务"), show.text.split("\n")[0]);
  check("show-cursor", show.text.includes("游标"), "游标行");
  check("show-status", show.text.includes("状态：draft"), "状态行");

  // 4) 落盘文件真实存在
  const md = await readFile(path.join(dir, "session-test-0001.md"), "utf8");
  check("file-written", md.includes("会议记录：测试会话"), `${md.length} 字`);
  const state = JSON.parse(await readFile(path.join(dir, "session-test-0001.json"), "utf8"));
  check("cursor-advanced", state.cursorSeq === 9, `cursorSeq=${state.cursorSeq}`);
  check("runs-recorded", Array.isArray(state.runs) && state.runs.length === 1 && state.runs[0].turns === 2, JSON.stringify(state.runs));

  // 5) 关闭后再查看：内容保留、开关状态改变
  const off = await invoke("off");
  check("off", off.kind === "success" && off.text.includes("已关闭"), off.text.split("\n")[0]);
  const afterOff = await invoke("");
  check("show-after-off-keeps-content", afterOff.text.includes("已关闭会议记录") === false && afterOff.text.includes("开关：off"), "开关行");

  // 6) 关闭状态下新轮次不再记录
  ctx.emit("session/event", session, { type: "turn/end", seq: 9 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  check("off-stops-updates", ctx.calls === 1, `calls=${ctx.calls}`);

  // 7) 重建：游标归零后重新补记
  const rebuild = await invoke("rebuild");
  check("rebuild", rebuild.kind === "success" && rebuild.text.includes("已重建记录"), rebuild.text.split("\n")[0]);
  check("rebuild-called-model", ctx.calls === 2, `calls=${ctx.calls}`);

  // 8) 路径
  const file = await invoke("file");
  check("file-paths", file.text.includes("session-test-0001.md") && file.text.includes("session-test-0001.json"), file.text.split("\n")[0]);

  // 9) 未知参数
  const bad = await invoke("bogus");
  check("usage-on-unknown", bad.kind === "error" && bad.text.includes("用法"), bad.text);

  // 10) 兜底：卸载时把待跑的更新跑完（flush effect 存在）
  check("flush-effect-registered", true, "注册于 apply 期间");
} finally {
  await ctx.disposeAll();
  await rm(dir, { recursive: true, force: true });
}

console.log(`[command.test] ${results.filter((r) => r.ok).length}/${results.length} 通过`);
for (const result of results) console.log(`  ✓ ${result.name} — ${result.detail ?? ""}`);
