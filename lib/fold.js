/**
 * 事件折叠层：把会话事件流折成「轮次材料」。
 *
 * 只读 user/message（source.kind === 'user'）与 assistant/message 的正文，
 * 不读 tool/* 事件（见 01-记录格式定稿.md 第七节铁律 7）。
 * 纯函数，无 I/O，可在插件外单独测试。
 *
 * @module dsh-meeting-recorder/fold
 */

/** 取 content 块数组里的文本，按换行拼接。非文本块（图片、工具调用）忽略。 */
export function textOfBlocks(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

/**
 * 把助手消息拆成「正文」与「推理」。
 * 推理体积在实测日志里是正文的 20 倍以上，必须分开存放、单独限额，
 * 不能和正文混在一起抢同一份预算（见 format.buildUserInput 的三档优先级）。
 */
export function splitAssistantBlocks(content) {
  const text = [];
  const reasoning = [];
  if (!Array.isArray(content)) return { text: "", reasoning: "" };
  for (const block of content) {
    if (!block || typeof block.text !== "string" || block.text.length === 0) continue;
    if (block.type === "text") text.push(block.text);
    else if (block.type === "reasoning") reasoning.push(block.text);
  }
  return { text: text.join("\n").trim(), reasoning: reasoning.join("\n").trim() };
}

/**
 * 折出轮次列表。一轮 = turn/start … turn/end 之间的 user/message 与 assistant/message。
 * @param {Array} events 会话事件（升序）
 * @returns {Array<{turn:number,startSeq:number,endSeq:number|null,time:number|null,userSeq:number|null,assistantSeq:number|null,user:string,assistant:string}>}
 */
export function collectTurns(events) {
  const turns = [];
  let cur = null;
  for (const event of events) {
    if (!event || typeof event.seq !== "number") continue;
    switch (event.type) {
      case "turn/start": {
        const declared = event.data?.turn;
        cur = {
          turn: typeof declared === "number" ? declared : turns.length + 1,
          startSeq: event.seq,
          endSeq: null,
          time: typeof event.time === "number" ? event.time : null,
          userSeq: null,
          assistantSeq: null,
          user: "",
          assistant: "",
          reasoning: "",
        };
        turns.push(cur);
        break;
      }
      case "user/message": {
        if (cur === null) break;
        if (event.data?.source?.kind !== "user") break;
        const text = textOfBlocks(event.data.content);
        if (text.length === 0) break;
        cur.user = cur.user.length === 0 ? text : `${cur.user}\n${text}`;
        cur.userSeq = event.seq;
        break;
      }
      case "assistant/message": {
        if (cur === null) break;
        const { text, reasoning } = splitAssistantBlocks(event.data?.message?.content);
        if (text.length > 0) {
          cur.assistant = cur.assistant.length === 0 ? text : `${cur.assistant}\n${text}`;
          cur.assistantSeq = event.seq;
        }
        if (reasoning.length > 0) {
          cur.reasoning = cur.reasoning.length === 0 ? reasoning : `${cur.reasoning}\n${reasoning}`;
        }
        break;
      }
      case "turn/end": {
        if (cur !== null) {
          cur.endSeq = event.seq;
          cur = null;
        }
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

/** 从最近一条 request/header 里取会话实际使用的路由，作为记录员默认模型。 */
export function latestRoute(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "request/header") continue;
    const header = event.data?.header;
    const provider = header?.config?.provider ?? header?.provider ?? header?.route?.provider;
    const model = header?.config?.model ?? header?.model ?? header?.route?.model;
    if (typeof provider === "string" && typeof model === "string") return { provider, model };
  }
  return undefined;
}

/** 一条事件的最高序号（日志为空时 0）。 */
export function lastSeqOf(events) {
  let max = 0;
  for (const event of events) {
    if (typeof event?.seq === "number" && event.seq > max) max = event.seq;
  }
  return max;
}

/**
 * 选出「已结束且尚未记录」的轮次。
 * 判定：轮次里有用户或助手正文，且锚点序号大于游标。
 * 只有用户说话、助手没回的轮次（被打断）同样要记——用户的定义与纠偏常常就在这种轮次里。
 */
export function selectPending(turns, cursorSeq) {
  const pending = [];
  let advancedTo = cursorSeq;
  for (const turn of turns) {
    const finished = turn.endSeq !== null;
    if (finished && typeof turn.endSeq === "number" && turn.endSeq > advancedTo) advancedTo = turn.endSeq;
    if (!finished) continue;
    if (turn.user.length === 0 && turn.assistant.length === 0) continue;
    const anchor = turn.assistantSeq ?? turn.userSeq ?? turn.startSeq;
    if (anchor <= cursorSeq) continue;
    pending.push(turn);
  }
  return { pending, advancedTo };
}

/** 截断长文本，保留头尾，避免单轮吞掉整个上下文预算。 */
export function clip(text, limit) {
  if (typeof text !== "string") return "";
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.7);
  const tail = Math.max(0, limit - head - 20);
  return `${text.slice(0, head)}\n…（中间省略 ${text.length - head - tail} 字）…\n${text.slice(text.length - tail)}`;
}
