/**
 * 存储层：每个会话一份 JSON + 一份可读的 .md。
 *
 * 为什么不写进会话日志：会话日志的读取路径拒绝解释 KNOWN_SESSION_EVENT_TYPES
 * 之外的未标记事件（见 @deepseek-ai/dsh-session/lib/types/known-event-types.js），
 * 往里追加自定义事件会让整份日志在别的机器/版本上读不出来。记录属于插件，
 * 就存在插件自己的目录。
 *
 * @module dsh-meeting-recorder/store
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 默认目录：~/.dsh/meeting-recorder */
export function defaultStorageDir() {
  return path.join(os.homedir(), ".dsh", "meeting-recorder");
}

/** sessionId 可能含路径分隔符之外的怪字符，落盘前统一收敛。 */
export function safeId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function jsonPath(dir, sessionId) {
  return path.join(dir, `${safeId(sessionId)}.json`);
}

export function markdownPath(dir, sessionId) {
  return path.join(dir, `${safeId(sessionId)}.md`);
}

/** 空状态。override 为 null 表示跟随配置，'on'/'off' 表示本会话显式开关。 */
export function emptyState(sessionId) {
  return {
    sessionId,
    override: null,
    status: "draft",
    createdAt: Date.now(),
    updatedAt: 0,
    cursorSeq: 0,
    lastSeq: 0,
    route: null,
    markdown: "",
    runs: [],
    lastError: null,
  };
}

/** 读状态；文件不存在返回 null。损坏的 JSON 也返回 null（不抛，交给调用方重建）。 */
export async function readState(dir, sessionId) {
  try {
    const raw = await readFile(jsonPath(dir, sessionId), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // 只认本插件写的状态文件：目录里可能还有别的 .json（导出的事件流、手工放的备份），
    // 缺 sessionId 的一律不当记录状态，免得到扫描阶段把路人文件当成会话去恢复。
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) return null;
    return { ...emptyState(sessionId), ...parsed, sessionId };
  } catch {
    return null;
  }
}

/** 原子写：先写 .tmp 再 rename，避免半截 JSON。 */
export async function writeState(dir, sessionId, state) {
  await mkdir(dir, { recursive: true });
  const target = jsonPath(dir, sessionId);
  const tmp = `${target}.tmp`;
  const payload = JSON.stringify({ ...state, sessionId }, null, 2);
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, target);
  if (typeof state.markdown === "string" && state.markdown.length > 0) {
    const md = markdownPath(dir, sessionId);
    const mdTmp = `${md}.tmp`;
    await writeFile(mdTmp, state.markdown, "utf8");
    await rename(mdTmp, md);
  }
  return target;
}

/** 本会话是否启用：显式开关优先，其次看配置的 autoEnable。 */
export function isEnabled(state, autoEnable) {
  if (state?.override === "on") return true;
  if (state?.override === "off") return false;
  return autoEnable === true;
}
