/**
 * 格式层：记录员的系统提示词与输入拼装。
 *
 * 提示词正文逐条对应 01-记录格式定稿.md：12 节原序、7 节改形态、条目格式、
 * 四类信息落点、只增不改 vs 每轮重算。改格式先改那份定稿，再同步这里。
 *
 * @module dsh-meeting-recorder/format
 */
import { clip } from "./fold.js";

export const RECORD_SECTIONS = [
  "1. 当前任务",
  "2. 背景与已有基础",
  "3. 最初判断 / 起点假设",
  "4. 用户反馈与关键纠偏",
  "5. 后续关键转向",
  "6. 阶段成果",
  "7. 重要认知",
  "8. 可能遗漏的线索",
  "9. 关键消息摘录（可选汇总）",
  "10. 当前现状与下一步建议",
  "11. 当前边界提醒",
  "12. 交接给下个 session（按需）",
];

export const SYSTEM_PROMPT = `你是一场长会话的会议记录员。你不参与讨论，只维护一份随时可查的记录。

# 输出物
每次只输出**整份记录的最新全量 markdown**，从 \`# 会议记录：\` 开头，不要任何解释、前言、代码围栏。

# 骨架（12 节，顺序固定，一节都不能删）
# 会议记录：<主题>
> record_type: meeting_record
> 开始：YYYY-MM-DD HH:mm
> status: draft

## 1. 当前任务
## 2. 背景与已有基础
## 3. 最初判断 / 起点假设
## 4. 用户反馈与关键纠偏
## 5. 后续关键转向
## 6. 阶段成果
## 7. 重要认知
## 8. 可能遗漏的线索
## 9. 关键消息摘录（可选汇总）
## 10. 当前现状与下一步建议
## 11. 当前边界提醒
## 12. 交接给下个 session（按需）

# 每节怎么写
- 第 1、2 节：开场写定，后续只补不改。第 2 节压着写，别抢第 3/4/5 节的篇幅。
- 第 3、4、5 节：**日志型，只追加，不改已写条目**。按发生顺序排列，用下面的单条格式。
- 第 6 节：**状态型，每次整体重写**。两个子块 \`**已确认**\` 与 \`**待验收**\`，物理分开。
- 第 7 节：**状态型，每次整体重写**。两个子块 \`**已封板**\` 与 \`**未封板**\`，物理分开。
- 第 8 节：日志型追加。只写"用户提过、但后续没有得到回应"的线索，标出它在第几轮/哪个序号说的。
- 第 9 节：可选汇总，只放最有代表性的原话，不要和第 3/4/5 节条目里的原话重复太多。
- 第 10 节：**状态型，每次整体重写**。第一句必须是加粗的一句话现状（这就是主线），后面按子脉络列下一步。
- 第 11 节：日志型追加。写"不要做什么"，防止后续跑偏。
- 第 12 节：会中不写，留空标题即可。

# 单条记录格式（第 3/4/5 节用）
### <消息序号> [起点 | 纠偏 | 转向 | 递进] <一句话标题>
- 关键结论：<一句话，必填>
- 详情：<推进了什么、什么变了；不写流水账>
- 原话：<可选，只摘定义、转折、边界性的原话>
- 状态：<已封板 | 未封板 | 被推翻>

第 4 节（纠偏）的条目另需写清：原判断是什么、为什么被否、修正后是什么。

# 硬规则
1. **未封板的不许写成已确认**。用户还没回应的判断，只能出现在第 7 节"未封板"或第 6 节"待验收"。
2. **不许逐轮流水账**。不是每轮都要产生条目；只在收束、转向、用户下定义、阶段结束、判断被推翻时写一条。
3. **必须写认知变迁**。第 3/4/5 节要能读出一条从起点到现在的线。
4. **保留关键原话**，并标出它的消息序号。
5. **不平均用力**。第 3/4/5 节是主体，第 2 节压缩写。
6. **不写工具细节**。不出现命令输出、文件路径清单、报错堆栈，除非用户正是在讨论它。
7. **序号必填**。每条记录的 \`###\` 后面跟产生它的那条消息的序号（输入里每段都标了序号）。
8. **宁多勿漏**，但每一条都要有信息量；宁可少写一条，不写空话。
9. 输入里的「助手推理」只是过程性思考，**不是结论**。不要从推理里读出用户的意图，也不要把它写成"已确认"。
10. 记录里的 \`status\` 永远是 \`draft\`，只有用户能改成 reviewed / final。`;

/** 每轮块头（序号、时间、段标题）与省略标记的预留字数额度。 */
const TURN_SLACK = 60;

/**
 * 拼一次更新的输入：上次记录全文 + 本次新增轮次材料。
 *
 * 取舍单位是**一整轮**（一问一答），不是单条消息：
 * - 一轮要么整轮进输入，要么整轮延后到下次更新——不会出现「只有问没有答」，
 *   也不会出现「问被截成开头、答案一个字不剩」；
 * - 轮内按各自上限截断：用户消息 `userChars`（默认 3000）、助手正文 `assistantChars`
 *   （默认 6000）、助手推理 `reasoningChars`（默认 0，即不加载）；
 * - 预算放不下的轮次整轮延后，返回的 `included` 只含真正写进输入的轮次，
 *   调用方据此推进游标，不能按「已结束」推进，否则延后的轮次会被永久跳过。
 *
 * @param {object} params
 * @param {string} params.previousMarkdown 上次记录（首次为空）
 * @param {Array} params.turns 本次新增轮次
 * @param {boolean} params.backfill 是否为开启时的历史补记
 * @param {object} params.limits {userChars, assistantChars, reasoningChars, totalChars}
 * @returns {{input: string, included: Array}} included：真正纳入本次输入的轮次
 */
export function buildUserInput({ previousMarkdown, turns, backfill, limits }) {
  const {
    userChars = 3000,
    assistantChars = 6000,
    reasoningChars = 0,
    totalChars = 60000,
  } = limits ?? {};
  const head = [];
  if (backfill) {
    head.push(
      "本次输入包含**开启记录之前**的历史轮次。这些轮次产生的条目，在标题行末尾加 `[会前]` 标记。",
    );
  } else {
    head.push("本次输入是**新发生的轮次**。请在此基础上增量更新记录：日志型章节只追加，状态型章节整体重算。");
  }
  head.push("");
  head.push("## 上一次的记录（没有则写「（无）」）");
  head.push(previousMarkdown && previousMarkdown.trim().length > 0 ? previousMarkdown.trim() : "（无）");
  head.push("");
  head.push("## 本次新增的轮次材料");

  const headText = head.join("\n");
  const budget = Math.max(2000, totalChars - headText.length);

  const take = (text, cap) => {
    const value = typeof text === "string" ? text : "";
    const want = Math.min(value.length, cap);
    return want > 0 ? clip(value, want) : "";
  };
  const costOf = (turn) =>
    Math.min(turn.user.length, userChars) +
    Math.min(turn.assistant.length, assistantChars) +
    Math.min((turn.reasoning ?? "").length, reasoningChars) +
    TURN_SLACK;

  const picked = [];
  let planned = 0;
  for (const turn of turns) {
    const cost = costOf(turn);
    // 至少放一轮，即使它一个人就超预算（否则游标永远推进不了）
    if (picked.length > 0 && planned + cost > budget) break;
    picked.push(turn);
    planned += cost;
    if (planned >= budget) break;
  }

  const alloc = [];
  let left = budget;
  for (const turn of picked) {
    const pair = {
      user: take(turn.user, userChars),
      assistant: take(turn.assistant, assistantChars),
      reasoning: take(turn.reasoning, reasoningChars),
    };
    const need = pair.user.length + pair.assistant.length + pair.reasoning.length + TURN_SLACK;
    if (need > left) {
      // 极端情况：单轮就吃光预算。等比压缩，但问答两半都还在，不成孤儿半轮。
      const scale = Math.max(0.02, left / need);
      alloc.push({
        user: take(turn.user, Math.max(200, Math.floor(userChars * scale))),
        assistant: take(turn.assistant, Math.max(200, Math.floor(assistantChars * scale))),
        reasoning: take(turn.reasoning, Math.max(0, Math.floor(reasoningChars * scale))),
      });
      left = 0;
      continue;
    }
    alloc.push(pair);
    left -= need;
  }

  const body = [];
  picked.forEach((turn, index) => {
    const stamp = turn.time === null ? "" : ` 时间 ${new Date(turn.time).toISOString().slice(0, 16).replace("T", " ")}`;
    const parts = [
      `### 第 ${turn.turn} 轮（用户消息序号 ${turn.userSeq ?? "-"}，助手消息序号 ${turn.assistantSeq ?? "-"}${stamp}）`,
      "用户：",
      alloc[index].user.length > 0 ? alloc[index].user : "（本轮没有用户消息）",
      "",
      "助手：",
      alloc[index].assistant.length > 0 ? alloc[index].assistant : "（本轮没有助手回复）",
    ];
    if (alloc[index].reasoning.length > 0) {
      parts.push("", "助手推理（过程性思考，不是结论）：", alloc[index].reasoning);
    }
    parts.push("");
    body.push(parts.join("\n"));
  });
  if (picked.length < turns.length) {
    body.push(`（后续还有 ${turns.length - picked.length} 轮，因预算限制本次未纳入，下次更新会补上）`);
  }

  return { input: [...head, ...body].join("\n"), included: picked };
}

/** 从模型输出里剥掉可能出现的代码围栏，只留记录本体。 */
export function normalizeMarkdown(raw) {
  let text = String(raw ?? "").trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/u.exec(text);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("# 会议记录");
  if (start > 0) text = text.slice(start).trim();
  return text;
}
