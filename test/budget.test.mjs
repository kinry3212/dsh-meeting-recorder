// 输入预算与取舍自测：跑法 node --test plugin/test/budget.test.mjs
// 覆盖：①一问一答整轮同进同退 ②用户 3000 / 正文 6000 / 推理默认不加载 ③超预算整轮延后、游标不跳过
import test from "node:test";
import assert from "node:assert/strict";
import { buildUserInput, SYSTEM_PROMPT } from "../lib/format.js";
import { collectTurns, splitAssistantBlocks } from "../lib/fold.js";
import { nextDrain } from "../lib/drain.js";

const long = (prefix, n) => `${prefix}${"字".repeat(n)}`;

function turn(index, { user = long("用户说：", 1200), assistant = long("助手答：", 1200), reasoning = long("推理：", 1200) } = {}) {
  return {
    turn: index,
    startSeq: index * 10,
    endSeq: index * 10 + 3,
    time: 0,
    userSeq: index * 10 + 1,
    assistantSeq: index * 10 + 2,
    user,
    assistant,
    reasoning,
  };
}

const build = (turns, limits, previousMarkdown = "") =>
  buildUserInput({ previousMarkdown, turns, backfill: false, limits });

test("推理块与正文分开收集", () => {
  const { text, reasoning } = splitAssistantBlocks([
    { type: "reasoning", text: "先想一下" },
    { type: "text", text: "结论是 A" },
    { type: "tool-call", id: "x" },
  ]);
  assert.equal(text, "结论是 A");
  assert.equal(reasoning, "先想一下");
});

test("默认不加载推理，正文上限 6000", () => {
  const { input } = build([turn(1)], { totalChars: 60000 });
  assert.ok(!input.includes("助手推理"), "默认 reasoningChars=0，不应出现推理");
  assert.ok(input.includes("用户说：") && input.includes("助手答："));
});

test("助手正文 4000 字在 6000 上限下不被截断", () => {
  const body = long("助手答：", 4000);
  const { input } = build([turn(1, { assistant: body })], { totalChars: 60000 });
  assert.ok(input.includes(body), "4000 字正文应完整保留");
  assert.ok(!input.includes("中间省略"));
});

test("问答成对：预算紧也不会出现只有问、没有答的轮次", () => {
  const turns = Array.from({ length: 6 }, (_, i) => turn(i + 1, {
    user: long("用户说：", 900),
    assistant: long("助手答：", 900),
    reasoning: "",
  }));
  const { input, included } = build(turns, { totalChars: 5000, assistantChars: 6000, userChars: 3000 });
  assert.ok(included.length >= 1, "至少要纳入一轮");
  const blocks = input.split("### 第 ").slice(1);
  assert.equal(blocks.length, included.length, "每个纳入的轮次都有自己的块");
  for (const block of blocks) {
    assert.ok(!block.includes("（本轮没有助手回复）"), `这一轮缺了助手正文：\n${block.slice(0, 80)}`);
  }
});

test("超预算时只纳入前缀轮次，并说明剩余轮次下次补上", () => {
  const turns = Array.from({ length: 8 }, (_, i) => turn(i + 1, {
    user: long("用户说：", 1500),
    assistant: long("助手答：", 1500),
    reasoning: "",
  }));
  const { input, included } = build(turns, { totalChars: 12000 });
  assert.ok(included.length >= 1 && included.length < turns.length, `included=${included.length}`);
  assert.deepEqual(included, turns.slice(0, included.length), "必须是前缀，不能跳轮");
  assert.ok(input.includes(`后续还有 ${turns.length - included.length} 轮`));
});

test("单轮就超预算时问答两半都保留，不成孤儿半轮", () => {
  const turns = [turn(1, { user: long("用户说：", 8000), assistant: long("助手答：", 20000), reasoning: "" })];
  const { input } = build(turns, { totalChars: 6000 });
  assert.ok(input.includes("用户说："));
  assert.ok(input.includes("助手答："));
});

test("上一份记录很长时仍至少放一轮（否则游标永远推进不了）", () => {
  const { included } = build([turn(1)], { totalChars: 60000 }, long("旧记录", 59000));
  assert.equal(included.length, 1);
});

test("显式打开推理时才带推理", () => {
  const { input } = build([turn(1)], { totalChars: 60000, reasoningChars: 800 });
  assert.ok(input.includes("助手推理（过程性思考，不是结论）："));
});

test("推理不得被写成结论：系统提示词有硬规则", () => {
  assert.ok(SYSTEM_PROMPT.includes("助手推理"));
  assert.ok(SYSTEM_PROMPT.includes("不是结论"));
});

test("折叠层把推理挂到轮次上，且不影响正文序号", () => {
  const events = [
    { seq: 1, type: "turn/start", data: { turn: 1 }, time: 0 },
    { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "问题" }] } },
    { seq: 3, type: "assistant/message", data: { message: { content: [
      { type: "reasoning", text: "想一想" },
      { type: "text", text: "回答" },
    ] } } },
    { seq: 4, type: "turn/end", data: {} },
  ];
  const [only] = collectTurns(events);
  assert.equal(only.user, "问题");
  assert.equal(only.assistant, "回答");
  assert.equal(only.reasoning, "想一想");
  assert.equal(only.assistantSeq, 3);
});

// ── 自动续跑的闸门 ────────────────────────────────────────────
test("有延后且游标前进时续跑，次数递增", () => {
  const decision = nextDrain({ ran: true, deferred: 3, cursor: 40, cursorFrom: 10, rounds: 0, maxDrain: 5 });
  assert.equal(decision.drain, true);
  assert.equal(decision.rounds, 1);
});

test("游标没前进立刻停（防 bug 空转）", () => {
  const decision = nextDrain({ ran: true, deferred: 3, cursor: 10, cursorFrom: 10, rounds: 0, maxDrain: 5 });
  assert.equal(decision.drain, false);
  assert.equal(decision.reason, "stalled");
});

test("游标倒退也停", () => {
  const decision = nextDrain({ ran: true, deferred: 3, cursor: 8, cursorFrom: 10, rounds: 0, maxDrain: 5 });
  assert.equal(decision.drain, false);
  assert.equal(decision.reason, "stalled");
});

test("到 maxDrain 就停", () => {
  const decision = nextDrain({ ran: true, deferred: 3, cursor: 40, cursorFrom: 10, rounds: 5, maxDrain: 5 });
  assert.equal(decision.drain, false);
  assert.equal(decision.reason, "max-rounds");
});

test("没有延后、或这一批没跑，都不续跑", () => {
  assert.equal(nextDrain({ ran: true, deferred: 0, cursor: 40, cursorFrom: 10, rounds: 0, maxDrain: 5 }).drain, false);
  assert.equal(nextDrain({ ran: false, deferred: 3, cursor: 40, cursorFrom: 10, rounds: 0, maxDrain: 5 }).reason, "done");
});
