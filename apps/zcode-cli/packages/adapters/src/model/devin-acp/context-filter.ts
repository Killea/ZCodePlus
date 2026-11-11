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
  // 仍按任意 `^# ` 切段（非白名单段如 # Tools 也是真边界），但排除代码块
  // 内的 `# ` 行——记忆内容里 fenced code 的 `# 注释` 不应把 Memory 段截断。
  const matches = [...text.matchAll(SECTION_HEADING_PATTERN)].filter(
    (match) => !isInsideCodeFence(text, match.index ?? 0),
  );
  const sections: SectionSlice[] = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    sections.push({ title: match[1].trim(), raw: text.slice(start, end).trim() });
  }
  return sections;
}

const CODE_FENCE_PATTERN = /^```/gm;

function isInsideCodeFence(text: string, index: number): boolean {
  let fences = 0;
  CODE_FENCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_FENCE_PATTERN.exec(text)) !== null) {
    if (match.index >= index) break;
    fences += 1;
  }
  return fences % 2 === 1;
}

/**
 * 新 ACP session 遭遇已有 ZCode 历史时的确定性兜底：
 * 把 messages 序列化成 "此前对话记录" 文本前缀（非 LLM 摘要）。
 * system 消息跳过（走 contextForward 通道）；tool 结果只留状态行，避免 JSON 大输出。
 */
export function flattenTranscriptForNewSession(
  messages: readonly ModelInputMessage[],
  options: {
    readonly maxChars?: number;
    readonly header?: string;
    readonly includeSystem?: boolean;
    readonly messageMaxChars?: number;
    readonly toolMaxChars?: number;
  } = {},
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system" && !options.includeSystem) continue;
    const line = serializeTranscriptMessage(message, options);
    if (line !== undefined) lines.push(line);
  }
  if (lines.length === 0) return "";
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

/** 单条消息的转录行（历史前缀与增量续聊共用同一序列化语义）。 */
export function serializeTranscriptMessage(
  message: ModelInputMessage,
  options: { readonly messageMaxChars?: number; readonly toolMaxChars?: number } = {},
): string | undefined {
  const messageMax = options.messageMaxChars ?? MESSAGE_MAX_CHARS;
  const toolMax = options.toolMaxChars ?? TOOL_RESULT_SUMMARY_MAX_CHARS;
  const text = truncate(modelMessageContentToText(message.content), messageMax);
  if (message.role === "tool") {
    const status = message.isError ? "失败" : "完成";
    return `[tool ${message.toolName ?? "unknown"} ${status}] ${truncate(text, toolMax)}`;
  }
  const lines: string[] = [];
  if (message.toolCalls?.length) {
    const calls = message.toolCalls
      .map((call) => call.name ?? call.id)
      .join(", ");
    lines.push(`[assistant 调用了工具: ${calls}]`);
  }
  if (text) lines.push(`${message.role}: ${text}`);
  return lines.length === 0 ? undefined : lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
