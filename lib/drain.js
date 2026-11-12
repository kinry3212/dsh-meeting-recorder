/**
 * 自动续跑的闸门：一次更新因预算延后了轮次，决定要不要立刻接着跑下一批。
 *
 * 两道闸：
 * ① 游标没前进（原地打转）→ 立刻停，说明有 bug，空转只会白烧 token；
 * ② 连续续跑次数到 `maxDrain`（默认 5）→ 停，并记 warn 日志，不静默。
 *
 * 纯函数，无 I/O，可在插件外单测。
 *
 * @module dsh-meeting-recorder/drain
 */

/**
 * @param {object} params
 * @param {boolean} params.ran 这一批是否真的跑了（模型调用成功并落盘）
 * @param {number} params.deferred 因预算延后、还没纳入的轮次数
 * @param {number} params.cursor 这一批跑完后的游标
 * @param {number} params.cursorFrom 这一批之前的游标
 * @param {number} params.rounds 本会话已经自动续跑过几次
 * @param {number} params.maxDrain 允许的最大续跑次数
 * @returns {{drain: boolean, reason: string, rounds: number}} reason：done / stalled / max-rounds / deferred
 */
export function nextDrain({ ran, deferred, cursor, cursorFrom, rounds, maxDrain }) {
  if (!ran || !(deferred > 0)) return { drain: false, reason: "done", rounds: 0 };
  const advanced = typeof cursor === "number" && typeof cursorFrom === "number" && cursor > cursorFrom;
  if (!advanced) return { drain: false, reason: "stalled", rounds: 0 };
  if (!(maxDrain > 0) || rounds >= maxDrain) return { drain: false, reason: "max-rounds", rounds };
  return { drain: true, reason: "deferred", rounds: rounds + 1 };
}
