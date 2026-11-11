import type { DevinAcpUpdate } from "./bridge.js";

/**
 * ACP session/update 通知 → DevinAcpUpdate 的归一化，以及
 * request_permission 反向请求的自动应答。从 bridge.ts 拆出（400 行限制）。
 */

/**
 * 工具/plan 标记的去重状态（每 ACP session 一份）。
 * toolCallId -> 已发出的标题；plan -> 已发出的格式化文本。
 */
export interface UpdateMarkerState {
  readonly emitted: Map<string, string>;
}

export function createUpdateMarkerState(): UpdateMarkerState {
  return { emitted: new Map() };
}

const PLAN_MARKER_KEY = "__plan__";

export function normalizeSessionUpdate(
  update: unknown,
  markerState?: UpdateMarkerState,
): DevinAcpUpdate | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const record = update as Record<string, unknown>;
  const kind = record.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = contentText(record.content);
    return text === undefined ? undefined : { kind: "text", text };
  }
  if (kind === "agent_thought_chunk") {
    const text = contentText(record.content);
    return text === undefined ? undefined : { kind: "thought", text };
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    // 纯状态心跳没有信息量（"[devin tool] tool (in_progress)" 刷屏来源），丢弃；
    // 同一 toolCallId+title 只报第一条，收敛到每个工具一行。
    const title =
      typeof record.title === "string" && record.title.trim()
        ? record.title
        : undefined;
    if (!title) return undefined;
    const toolCallId =
      typeof record.toolCallId === "string" && record.toolCallId
        ? record.toolCallId
        : title;
    if (markerState?.emitted.get(toolCallId) === title) return undefined;
    markerState?.emitted.set(toolCallId, title);
    // in_progress/pending 状态会留在最终文本里产生"永远进行中"的假象；
    // 只有终态/错误类状态值得展示。
    const rawStatus = typeof record.status === "string" ? record.status : undefined;
    const status =
      rawStatus && rawStatus !== "in_progress" && rawStatus !== "pending"
        ? rawStatus
        : undefined;
    return { kind: "tool", title, ...(status === undefined ? {} : { status }) };
  }
  if (kind === "plan") {
    const text = formatPlan(record.entries);
    // plan 更新按内容全量重发；内容没变就丢，避免同一计划反复刷屏。
    if (!text.trim()) return undefined;
    if (markerState?.emitted.get(PLAN_MARKER_KEY) === text) return undefined;
    markerState?.emitted.set(PLAN_MARKER_KEY, text);
    return { kind: "plan", text };
  }
  if (kind === "usage_update") {
    const used = nonNegativeFiniteNumber(record.used);
    const size = nonNegativeFiniteNumber(record.size);
    // used/size 缺任一都不是可展示的用量，整条丢弃（meter 保持隐藏而不是渲染假 0%）。
    if (used === undefined || size === undefined || size <= 0) return undefined;
    const cost = normalizeAcpCost(record.cost);
    return { kind: "usage", used, size, ...(cost ? { cost } : {}) };
  }
  return undefined;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function normalizeAcpCost(
  value: unknown,
): { amount: number; currency: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { amount?: unknown; currency?: unknown };
  if (typeof record.amount !== "number" || !Number.isFinite(record.amount)) {
    return undefined;
  }
  if (typeof record.currency !== "string" || !record.currency) return undefined;
  return { amount: record.amount, currency: record.currency };
}

function contentText(content: unknown): string | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const block = content as { type?: string; text?: string };
  return block.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

function formatPlan(entries: unknown): string {
  if (!Array.isArray(entries)) return "";
  const lines = entries.map((entry) => {
    const item = entry as { content?: string; status?: string; priority?: string };
    const status = item.status ? `[${item.status}] ` : "";
    return `${status}${item.content ?? ""}`;
  });
  return `\n[plan]\n${lines.join("\n")}\n`;
}

/**
 * request_permission 自动应答：权限策略由 Devin CLI 自身 mode 控制（用户决策），
 * 这里只兜底保证 ACP 反向请求不悬挂。
 */
export function resolvePermissionOutcome(params: unknown): unknown {
  const request = params as {
    options?: Array<{ optionId?: string; kind?: string }>;
  };
  const options = request.options ?? [];
  // 只选 allow_once：allow_always 会把规则永久写进 Devin 配置，等于绕过
  // 用户选的 ask/plan 模式。没有 once 选项就 cancelled——宁可阻断也不能
  // 替用户签永久授权。
  // 产品边界（暂缓）：当前实际使用以 bypass/完全权限模式为主，Devin 不会
  // 发 request_permission，自动批准的路径基本不触发；接入真正的审批 UI
  // 通道（elicitation）前不做进一步处理。
  const allow = options.find((option) => option.kind === "allow_once");
  if (allow?.optionId) {
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** race promise vs AbortSignal：只解除本调用等待，不取消共享操作本身。 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new Error("Devin ACP request aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Devin ACP request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
