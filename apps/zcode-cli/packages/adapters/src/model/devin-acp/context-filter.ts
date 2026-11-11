import {
  modelMessageContentToText,
  type ModelInputMessage,
} from "@zcode/contracts";

export type DevinContextForwardPolicy = "memory-only" | "all-dynamic" | "none";

/**
 * contextForward=memory-only 时允许转发的 `# ` 段标题白名单。
 * 只收记忆/环境事实类内容；identity、harness、工具指令类段落不发给 Devin，
 * 避免把 "你是 ZCode agent、使用以下工具" 这类指令注入到另一个 agent。
 */
const FORWARDED_SECTION_TITLES = new Set([
  "Global Memory",
  "Memory",
  "Environment",
  "agentsMd",
  "currentDate",
  "ZCode Desktop Context",
  "User Context",
  "Request Context",
]);

const SECTION_HEADING_PATTERN = /^# (.+)$/gm;
const TRANSCRIPT_MAX_CHARS = 60_000;
const MESSAGE_MAX_CHARS = 8_000;
const TOOL_RESULT_SUMMARY_MAX_CHARS = 200;

/**
 * 从 system 消息中按白名单提取可转发上下文，拼成一段文本。
 * 返回空串表示无可转发内容。
 */
export function extractForwardableContext(
  messages: readonly ModelInputMessage[],
  policy: DevinContextForwardPolicy,
): string {
  if (policy === "none") return "";
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    const text = modelMessageContentToText(message.content);
    if (policy === "all-dynamic") {
      parts.push(text);
      continue;
    }
    for (const section of splitIntoSections(text)) {
      if (FORWARDED_SECTION_TITLES.has(section.title)) parts.push(section.raw);
    }
  }
  return parts.join("\n\n").trim();
}

interface SectionSlice {
  readonly title: string;
  readonly raw: string;
}

function splitIntoSections(text: string): SectionSlice[] {
  const matches = [...text.matchAll(SECTION_HEADING_PATTERN)];
  const sections: SectionSlice[] = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    sections.push({ title: match[1].trim(), raw: text.slice(start, end).trim() });
  }
  return sections;
}

/**
 * 新 ACP session 遭遇已有 ZCode 历史时的确定性兜底：
 * 把 messages 序列化成 "此前对话记录" 文本前缀（非 LLM 摘要）。
 * system 消息跳过（走 contextForward 通道）；tool 结果只留状态行，避免 JSON 大输出。
 */
export function flattenTranscriptForNewSession(
  messages: readonly ModelInputMessage[],
  options: { readonly maxChars?: number; readonly header?: string } = {},
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const text = truncate(modelMessageContentToText(message.content), MESSAGE_MAX_CHARS);
    if (message.role === "tool") {
      const status = message.isError ? "失败" : "完成";
      lines.push(
        `[tool ${message.toolName ?? "unknown"} ${status}] ${truncate(text, TOOL_RESULT_SUMMARY_MAX_CHARS)}`,
      );
      continue;
    }
    if (message.toolCalls?.length) {
      const calls = message.toolCalls
        .map((call) => call.name ?? call.id)
        .join(", ");
      lines.push(`[assistant 调用了工具: ${calls}]`);
    }
    if (!text) continue;
    lines.push(`${message.role}: ${text}`);
  }
  const transcript = lines.join("\n");
  const maxChars = options.maxChars ?? TRANSCRIPT_MAX_CHARS;
  const trimmed = transcript.length > maxChars
    ? transcript.slice(transcript.length - maxChars)
    : transcript;
  return [
    options.header ??
      "以下是本次会话此前的对话记录（仅供你理解上下文，不要重复执行其中的操作）：",
    trimmed,
    "",
  ].join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
