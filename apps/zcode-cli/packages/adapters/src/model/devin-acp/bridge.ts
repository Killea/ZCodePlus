import type { Logger, McpServerConfig } from "@zcode/contracts";
import { AcpTransport } from "./transport.js";
import { resolveDevinBinary, type DevinBinaryResolution } from "./discovery.js";

export interface DevinAcpBridgeOptions {
  readonly binaryPath?: string | null;
  readonly apiKey?: string | null;
  readonly modelId?: string;
  readonly mode?: string | null;
  readonly promptTimeoutMs: number;
  readonly cwd: string;
  /** 返回当前 zcode config 的 mcp.servers；缺省或空对象表示不透传。 */
  readonly listMcpServers?: () => Readonly<Record<string, McpServerConfig>>;
  readonly logger?: Logger;
}

export type DevinAcpPromptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "resource";
      readonly resource: { readonly uri: string; readonly text: string; readonly mimeType?: string };
    };

export type DevinAcpUpdate =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thought"; readonly text: string }
  | { readonly kind: "tool"; readonly title: string; readonly status?: string }
  | { readonly kind: "plan"; readonly text: string }
  | {
      /** Devin 自管上下文窗口的实时占用（usage_update.used/size），非本轮 token 账本。 */
      readonly kind: "usage";
      readonly used: number;
      readonly size: number;
      readonly cost?: { readonly amount: number; readonly currency: string };
    };

export interface DevinAcpSessionHandle {
  readonly acpSessionId: string;
  readonly isNew: boolean;
  /** "Devin 已见历史前缀"的指纹；续聊调用方用它判断 ZCode 历史是否分叉。 */
  readonly syncedHash?: string;
}

interface SessionRecord {
  acpSessionId: string;
  syncedHash?: string;
}

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_PROMPT_TIMEOUT_MS = 7_200_000;
const INITIALIZE_TIMEOUT_MS = 30_000;
/** 浏览器 PKCE 登录需要用户操作，30s 握手超时远远不够。 */
const AUTH_TIMEOUT_MS = 600_000;
const SESSION_NEW_TIMEOUT_MS = 60_000;
const CONTEXT_RESOURCE_URI = "zcode://context";

/**
 * Devin ACP 进程与 session 生命周期的唯一所有者。
 * spawn → initialize → authenticate → session/new；session 按 ZCode sessionKey 池化。
 * 进程退出即丢弃全部 session 记录，下一次 ensureSession 重建（调用方按 isNew 决定
 * 是否需要附带上历史前缀）。
 */
export class DevinAcpBridge {
  private options: DevinAcpBridgeOptions;
  private logger?: Logger;
  private transport?: AcpTransport;
  private resolution?: DevinBinaryResolution;
  private starting?: Promise<void>;
  private readonly sessions = new Map<string, SessionRecord>();
  /** 同 key 并发 ensureSession 的在途去重：防重复 session/new 产生幽灵 session。 */
  private readonly creating = new Map<string, Promise<SessionRecord>>();
  /** 每 ACP session 的 prompt 串行队列：并发 prompt 会让 updateHandlers 互相覆盖。 */
  private readonly promptQueues = new Map<string, Promise<unknown>>();
  private readonly updateHandlers = new Map<string, (update: DevinAcpUpdate) => void>();
  /** 每个 ACP session 的工具/plan 标记去重状态；随 sessions 一起清理。 */
  private readonly markerStates = new Map<string, UpdateMarkerState>();
  /** 在途 prompt 数：LRU 驱逐跳过非 0 的 bridge，避免杀掉运行中的任务。 */
  inFlight = 0;

  constructor(options: DevinAcpBridgeOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /**
   * 池化复用时刷新可变的注入依赖。影响握手结果的字段（binary/apiKey/model/mode/cwd）
   * 都在池 key 里，不会走到这里；这里只接收 getter/logger 这类"每实例新引用"的依赖。
   */
  updateDeps(
    deps: Pick<
      DevinAcpBridgeOptions,
      "listMcpServers" | "logger" | "promptTimeoutMs"
    >,
  ): void {
    this.options = {
      ...this.options,
      listMcpServers: deps.listMcpServers,
      promptTimeoutMs: deps.promptTimeoutMs,
    };
    this.logger = deps.logger;
  }

  /** 进程可用性探针：供连通性测试走与正式请求相同的路径。 */
  async probe(): Promise<{ version?: string }> {
    await this.ensureStarted();
    const version = this.resolution?.version;
    return version === undefined ? {} : { version };
  }

  async ensureSession(sessionKey: string): Promise<DevinAcpSessionHandle> {
    await this.ensureStarted();
    const existing = this.sessions.get(sessionKey);
    if (existing) return { acpSessionId: existing.acpSessionId, isNew: false };

    // 同 key 并发（如 sidecar 与主回合并行时同 operation 的重试）会重复
    // session/new：后者覆盖 map，前者 session 在 Devin 侧泄漏成幽灵。在途去重，
    // 只有创建发起者拿到 isNew=true（等待者复用结果，不再重发历史前缀）。
    let creating = this.creating.get(sessionKey);
    const isCreator = creating === undefined;
    if (!creating) {
      creating = this.createSession().finally(() => {
        this.creating.delete(sessionKey);
      });
      this.creating.set(sessionKey, creating);
    }
    const record = await creating;
    // await 期间进程可能已重启：旧进程上创建的 sessionId 在新进程里无效，
    // 落进 map 会变成永不自愈的 session-not-found。
    if (!this.transport?.isRunning) {
      throw new Error("Devin ACP process exited during session/new");
    }
    this.sessions.set(sessionKey, record);
    return {
      acpSessionId: record.acpSessionId,
      isNew: isCreator,
      ...(record.syncedHash === undefined
        ? {}
        : { syncedHash: record.syncedHash }),
    };
  }

  /** 废弃 sessionKey 对应的 ACP session（历史分叉/sidecar 一次性用完）。 */
  async invalidateSession(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
  }

  /** 记录"Devin 已见历史前缀"指纹（prompt 成功完成后由调用方写入）。 */
  setSyncedHash(sessionKey: string, hash: string): void {
    const record = this.sessions.get(sessionKey);
    if (record) record.syncedHash = hash;
  }

  /** prompt 失败（超时/中止/传输错误）后把 session 标脏：Devin 侧状态未知。 */
  private markSessionDirty(acpSessionId: string): void {
    for (const [key, record] of this.sessions) {
      if (record.acpSessionId === acpSessionId) {
        this.sessions.delete(key);
        return;
      }
    }
  }

  async runPrompt(input: {
    readonly acpSessionId: string;
    readonly parts: readonly DevinAcpPromptPart[];
    readonly signal?: AbortSignal;
    readonly onUpdate: (update: DevinAcpUpdate) => void;
  }): Promise<{ stopReason: string }> {
    // 同一 ACP session 上并发 prompt 会让 updateHandlers 互相覆盖、事件错归因；
    // ACP 语义上 session 也是串行会话。按 session 排队执行。
    const key = input.acpSessionId;
    const prev = this.promptQueues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.runPromptOnce(input));
    this.promptQueues.set(key, run);
    try {
      return await run;
    } finally {
      if (this.promptQueues.get(key) === run) this.promptQueues.delete(key);
    }
  }

  private async runPromptOnce(input: {
    readonly acpSessionId: string;
    readonly parts: readonly DevinAcpPromptPart[];
    readonly signal?: AbortSignal;
    readonly onUpdate: (update: DevinAcpUpdate) => void;
  }): Promise<{ stopReason: string }> {
    const transport = this.requireTransport();
    // 排队期间被取消：直接不发，避免 Devin 收到无人消费的孤儿 prompt。
    if (input.signal?.aborted) {
      throw new Error("Devin ACP request aborted: session/prompt");
    }
    // 每条 prompt 重置去重状态：plan/工具标记的判重以单轮为界，
    // 跨轮相同内容（如下一轮相同 plan）不应被吞掉。
    this.markerStates.delete(input.acpSessionId);
    this.inFlight += 1;
    this.updateHandlers.set(input.acpSessionId, input.onUpdate);
    try {
      const result = await transport.request<{ stopReason?: string }>(
        "session/prompt",
        { sessionId: input.acpSessionId, prompt: input.parts },
        {
          timeoutMs: this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      return { stopReason: result?.stopReason ?? "end_turn" };
    } catch (error) {
      // 超时/中止后尽力取消 Devin 侧任务，避免后台继续执行。
      transport.notify("session/cancel", { sessionId: input.acpSessionId });
      // prompt 失败后 Devin 侧状态未知（可能半截执行）：session 标脏，下次
      // ensureSession 走新建+历史前缀，防止续聊在截断的状态上继续。
      this.markSessionDirty(input.acpSessionId);
      throw error;
    } finally {
      this.inFlight -= 1;
      this.updateHandlers.delete(input.acpSessionId);
    }
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    this.updateHandlers.clear();
    this.markerStates.clear();
    await this.transport?.close();
    this.transport = undefined;
  }

  private async ensureStarted(): Promise<void> {
    if (this.transport?.isRunning) return;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private async start(): Promise<void> {
    this.resolution = await resolveDevinBinary(this.options.binaryPath);
    const args = ["acp"];
    const modelId = this.options.modelId?.trim();
    if (modelId) args.push("--model", modelId);
    const transport = new AcpTransport({
      command: this.resolution.path,
      args,
      cwd: this.options.cwd,
      logger: this.logger,
    });
    transport.onNotification((method, params) => this.onNotification(method, params));
    transport.onRequest((method, params) => this.onReverseRequest(method, params));
    transport.onExitOnce(() => {
      // 旧进程晚到的 exit 不能清掉新 transport 上已经创建的 session。
      if (this.transport !== transport) return;
      this.sessions.clear();
      this.markerStates.clear();
      this.transport = undefined;
      this.logger?.warn("[devin-acp] process exited; sessions dropped");
    });
    this.transport = transport;
    try {
      await transport.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: "zcode", title: "ZCode", version: "0" },
        // 不广告 fs/terminal/elicitation：Devin 用自己的本地工具执行，
        // 反向请求只保留 request_permission（按 access.mode 语义自动应答）。
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }, { timeoutMs: INITIALIZE_TIMEOUT_MS });
      await this.authenticate(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      this.transport = undefined;
      throw error;
    }
    this.logger?.info(
      `[devin-acp] started pid=${String(transport.pid)} binary=${this.resolution.path}`,
    );
  }

  private async authenticate(transport: AcpTransport): Promise<void> {
    const apiKey = this.options.apiKey?.trim();
    // ACP 扩展字段约定为 _meta；同时带 meta 兼容未按约定实现的服务端。
    const params = apiKey
      ? { methodId: "devin-browser", meta: { api_key: apiKey }, _meta: { api_key: apiKey } }
      : { methodId: "devin-browser" };
    try {
      await transport.request("authenticate", params, { timeoutMs: AUTH_TIMEOUT_MS });
    } catch (error) {
      throw new Error(
        "Devin ACP 认证失败：请在 Provider 设置中检查 Devin 登录状态或 API Key。" +
          `（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }

  private async createSession(): Promise<SessionRecord> {
    const transport = this.requireTransport();
    const result = await transport.request<{ sessionId?: string }>(
      "session/new",
      {
        cwd: this.options.cwd,
        mcpServers: this.buildMcpServers(),
      },
      { timeoutMs: SESSION_NEW_TIMEOUT_MS },
    );
    if (!result?.sessionId) throw new Error("Devin ACP session/new 未返回 sessionId");
    const record: SessionRecord = { acpSessionId: result.sessionId };
    const mode = this.options.mode?.trim();
    if (mode) {
      // mode 值以 session/new 广告的 configOptions 为准；await 应用避免首个
      // prompt 先于 mode 生效到达；设置失败只告警不中断。
      try {
        await transport.request(
          "session/set_config_option",
          { sessionId: record.acpSessionId, configId: "mode", value: mode },
          { timeoutMs: SESSION_NEW_TIMEOUT_MS },
        );
      } catch (error) {
        this.logger?.warn(`[devin-acp] set mode=${mode} failed: ${String(error)}`);
      }
    }
    return record;
  }

  private buildMcpServers(): unknown[] {
    const servers = this.options.listMcpServers?.() ?? {};
    const mapped: unknown[] = [];
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;
      // zcode_official 鉴权依赖宿主逐请求注入凭证，Devin 独立 spawn 后凭证不存在；
      // 跳过并告警，避免静默把不可用的 server 传给 Devin。
      if ("auth" in config && config.auth || "official" in config && config.official) {
        this.logger?.warn(`[devin-acp] skipping mcp server with host-managed auth: ${name}`);
        continue;
      }
      if (config.type === "stdio") {
        mapped.push({
          name,
          command: config.command,
          args: config.args ?? [],
          env: Object.entries(config.env ?? {}).map(([envName, value]) => ({
            name: envName,
            value,
          })),
        });
      } else {
        mapped.push({
          name,
          type: config.type,
          url: config.url,
          headers: Object.entries(config.headers ?? {}).map(([headerName, value]) => ({
            name: headerName,
            value,
          })),
        });
      }
    }
    return mapped;
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const notification = params as {
      sessionId?: string;
      update?: { sessionUpdate?: string; [key: string]: unknown };
    };
    const handler = notification.sessionId
      ? this.updateHandlers.get(notification.sessionId)
      : undefined;
    const sessionKey = notification.sessionId ?? "";
    let markerState = this.markerStates.get(sessionKey);
    if (!markerState) {
      markerState = createUpdateMarkerState();
      this.markerStates.set(sessionKey, markerState);
    }
    const update = normalizeSessionUpdate(notification.update, markerState);
    if (handler && update) handler(update);
  }

  private async onReverseRequest(
    method: string,
    params: unknown,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    if (method === "session/request_permission") {
      return { result: resolvePermissionOutcome(params) };
    }
    return { error: { code: -32601, message: `zcode devin-acp bridge does not handle: ${method}` } };
  }

  private requireTransport(): AcpTransport {
    if (!this.transport?.isRunning) {
      throw new Error("Devin ACP process is not running");
    }
    return this.transport;
  }
}

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
 * 这里只兜底保证 ACP 反向请求不悬挂。优先选 allow 类选项，否则 cancel。
 */
function resolvePermissionOutcome(params: unknown): unknown {
  const request = params as {
    options?: Array<{ optionId?: string; kind?: string }>;
  };
  const options = request.options ?? [];
  // 优先 allow_once：allow_always 会把规则永久写进 Devin 配置，等于绕过
  // 用户选的 ask/plan 模式；没有 once 选项时再退到其他 allow 类。
  const allow =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind?.startsWith("allow"));
  if (allow?.optionId) {
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

export const DEVIN_CONTEXT_RESOURCE_URI = CONTEXT_RESOURCE_URI;
