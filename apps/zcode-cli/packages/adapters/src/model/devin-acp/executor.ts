import { createHash, randomUUID } from "node:crypto";
import {
  getCurrentModelInvocationContext,
  modelMessageContentToText,
  type ModelEvent,
  type ModelResult,
} from "@zcode/contracts";
import type { ModelExecutionRequest, ModelExecutor } from "../model.js";
import {
  DEVIN_CONTEXT_RESOURCE_URI,
  DevinAcpBridge,
  type DevinAcpBridgeOptions,
  type DevinAcpPromptPart,
  type DevinAcpUpdate,
} from "./bridge.js";
import {
  extractForwardableContext,
  flattenTranscriptForNewSession,
  serializeTranscriptMessage,
  type DevinContextForwardPolicy,
} from "./context-filter.js";

/** bridge 进程池容量：超出时 LRU 驱逐并 dispose，避免配置变更累积僵尸 devin 进程。 */
const BRIDGE_POOL_MAX = 4;
const TEXT_BLOCK_ID = "devin-text";
const REASONING_BLOCK_ID = "devin-thought";

/**
 * 桥接进程池 key：覆盖一切改变子进程握手结果的配置。
 * apiKey 只算哈希不进明文，避免 key 意外落日志时泄露。
 */
function bridgePoolKey(options: DevinModelExecutorOptions): string {
  return JSON.stringify({
    binaryPath: options.binaryPath ?? null,
    apiKey: options.apiKey ? hashSecret(options.apiKey) : null,
    modelId: options.modelId ?? null,
    mode: options.mode ?? null,
    cwd: options.cwd,
    // promptTimeoutMs 不进 key：它是请求期参数，经 updateDeps 热更新，
    // 改超时不应白白重启 devin 进程（重启=重新 authenticate）。
    mcpPassthrough: options.listMcpServers ? true : false,
  });
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

export interface DevinModelExecutorOptions extends DevinAcpBridgeOptions {
  readonly contextForward?: DevinContextForwardPolicy | null;
}

/**
 * Devin ACP 模型执行器：把 ZCode ModelRequest 翻译成 session/prompt，
 * 把 session/update 通知翻译成 ZCode 流事件。
 * ZCode 原生 tool schema 不转发（Devin 无法执行它们，prompt 注入只会诱发幻觉）。
 */
export class DevinModelExecutor implements ModelExecutor {
  /**
   * bridge 进程池：modelFactory 每次调用都会新建 executor，
   * 但 devin acp 子进程 + authenticate 很贵（无持久凭证时浏览器 PKCE）。
   * 同一配置共享一个 bridge，authenticate 每进程生命周期只发生一次，
   * ACP session 也得以跨调用保留（真续聊，不靠历史前缀重发）。
   */
  private static readonly bridgePool = new Map<string, DevinAcpBridge>();

  private readonly bridge: DevinAcpBridge;
  private readonly contextForward: DevinContextForwardPolicy;

  constructor(options: DevinModelExecutorOptions) {
    const key = bridgePoolKey(options);
    const pool = DevinModelExecutor.bridgePool;
    let bridge = pool.get(key);
    if (bridge === undefined) {
      bridge = new DevinAcpBridge(options);
      pool.set(key, bridge);
      // Map 保序=插入序；超限驱逐最旧项并 dispose，否则配置每次变更
      // 都会多留一个常驻 devin acp 子进程陪跑到 agent 退出。
      while (pool.size > BRIDGE_POOL_MAX) {
        // 跳过还有在途 prompt 的 bridge：dispose 会杀掉正在跑的任务。
        const evictable = [...pool.entries()].find(([, b]) => b.inFlight === 0);
        if (!evictable) break;
        pool.delete(evictable[0]);
        void evictable[1].dispose();
      }
    } else {
      // 同 key 复用时刷新注入依赖（logger / listMcpServers getter / 超时可变）。
      bridge.updateDeps(options);
      // LRU touch：移到末尾。
      pool.delete(key);
      pool.set(key, bridge);
    }
    this.bridge = bridge;
    this.contextForward = options.contextForward ?? "memory-only";
  }

  /** 连通性测试入口：执行真实的 spawn+initialize+authenticate，不发 prompt。 */
  async probe(): Promise<{ version?: string }> {
    return this.bridge.probe();
  }

  async generateText(request: ModelExecutionRequest): Promise<ModelResult> {
    let text = "";
    let finishReason = "stop";
    let usage: ModelResult["usage"] = {};
    for await (const event of this.streamText(request)) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "finish") {
        finishReason = event.finishReason;
        usage = event.usage;
      }
    }
    return { text, finishReason, usage };
  }

  async *streamText(request: ModelExecutionRequest): AsyncGenerator<ModelEvent> {
    yield { type: "start" };
    const invocation = getCurrentModelInvocationContext();
    const operation = invocation?.modelCall?.operation;
    // sessionId 缺失时用随机 key：牺牲续聊换隔离，避免不明来源的调用
    // 把多个 ZCode session 混进同一个 ACP session（跨会话污染）。
    const sessionId = invocation?.traceContext?.sessionId ?? randomUUID();
    // compact/标题/记忆提取等 sidecar 调用是自包含任务，不是会话续聊：
    // 若打进主 ACP session，"总结对话"这类指令会成为 Devin 的真实上下文并污染
    // 后续回复（表现为压缩后"指令丢失"）。sidecar 一律按 operation 分键走独立 session。
    const isMainTurn = operation === undefined || operation === "agent_step";
    const sessionKey = isMainTurn ? sessionId : `${sessionId}#${operation}`;
    let handle = await this.bridge.ensureSession(sessionKey);
    if (isMainTurn && !handle.isNew) {
      // ZCode 侧历史可能被编辑/回滚/fork/换模型——用"Devin 已见前缀 hash"
      // 校验续聊前提；不一致时废弃 ACP session 重建，否则增量续聊会让
      // Devin 在错误历史上继续（又一种"上下文丢失"）。
      const prefixHash = hashMessagesForSync(
        request.messages.slice(0, unseenStartIndex(request.messages)),
      );
      if (handle.syncedHash !== prefixHash) {
        await this.bridge.invalidateSession(sessionKey);
        handle = await this.bridge.ensureSession(sessionKey);
      }
    }
    const parts = isMainTurn
      ? this.buildPromptParts(request.messages, handle.isNew)
      : this.buildSidecarParts(request.messages);
    if (parts.length === 0) {
      yield { type: "finish", finishReason: "stop", usage: {} };
      return;
    }

    const updates = new UpdateQueue();
    // 交叉的 text/thought 段必须各开各的块（递增 id），否则渲染层按块建序
    // 会把后建的块整段挪到结尾——工具标记/思考都跑到正文之后。
    let blockSeq = 0;
    let openTextId: string | undefined;
    let openReasoningId: string | undefined;
    // Devin usage_update 可能在一轮 prompt 内多次到达（流式中途 + 结束时），
    // finish.usage 只带最后一份快照；meter 语义是"当前占用"而不是累计值。
    let latestUsage: Extract<DevinAcpUpdate, { kind: "usage" }> | undefined;
    const closeReasoning = function* (): Generator<ModelEvent> {
      if (openReasoningId) {
        const id = openReasoningId;
        openReasoningId = undefined;
        yield { type: "reasoning_end", id };
      }
    };
    const closeText = function* (): Generator<ModelEvent> {
      if (openTextId) {
        const id = openTextId;
        openTextId = undefined;
        yield { type: "text_end", id };
      }
    };

    // 用自有 AbortController 合并外部 signal：generator 被丢弃时 abort() 既让
    // 在途请求走 session/cancel，也让排队中的 prompt 根本不再发出——不能直接
    // cancel session（那会误伤同 session 上别人正在跑的 prompt）。
    const cancel = new AbortController();
    const upstream = request.abortSignal;
    if (upstream) {
      if (upstream.aborted) cancel.abort();
      else upstream.addEventListener("abort", () => cancel.abort(), { once: true });
    }
    let promptSettled = false;
    try {
      const promptDone = this.bridge.runPrompt({
        acpSessionId: handle.acpSessionId,
        parts,
        signal: cancel.signal,
        onUpdate: (update) => updates.push(update),
      });
      promptDone.then(
        (result) => {
          promptSettled = true;
          // prompt 成功送达并完成：记录 Devin 已见历史前缀，供下轮续聊校验。
          if (isMainTurn) {
            this.bridge.setSyncedHash(
              sessionKey,
              hashMessagesForSync(request.messages),
            );
          }
          updates.complete(result.stopReason);
        },
        (error: unknown) => {
          promptSettled = true;
          updates.fail(error);
        },
      );

      let stopReason = "end_turn";
      for (;;) {
        const next = await updates.next();
        if (next.done) {
          stopReason = next.stopReason;
          break;
        }
        const update = next.value;
        // usage 快照不产生文本/推理块，只暂存供 finish.usage 使用。
        if (update.kind === "usage") {
          latestUsage = update;
          continue;
        }
        // sidecar 的文本即结果本体（摘要/标题），[devin tool]/[plan] 标记
        // 混进去就是坏数据——标题里出现 "[devin tool] Ran ls" 之类。
        if (!isMainTurn && (update.kind === "tool" || update.kind === "plan")) {
          continue;
        }
        if (update.kind === "thought") {
          yield* closeText();
          if (!openReasoningId) {
            openReasoningId = `${REASONING_BLOCK_ID}-${++blockSeq}`;
            yield { type: "reasoning_start", id: openReasoningId };
          }
          yield { type: "reasoning_delta", id: openReasoningId, text: update.text };
          continue;
        }
        yield* closeReasoning();
        if (!openTextId) {
          openTextId = `${TEXT_BLOCK_ID}-${++blockSeq}`;
          yield { type: "text_start", id: openTextId };
        }
        if (update.kind === "text") {
          yield { type: "text_delta", id: openTextId, text: update.text };
        } else if (update.kind === "tool") {
          const status = update.status ? ` (${update.status})` : "";
          yield { type: "text_delta", id: openTextId, text: `\n[devin tool] ${update.title}${status}\n` };
        } else if (update.kind === "plan" && update.text) {
          yield { type: "text_delta", id: openTextId, text: update.text };
        }
      }
      yield* closeReasoning();
      yield* closeText();
      yield {
        type: "finish",
        finishReason: mapStopReason(stopReason),
        usage: latestUsage
          ? { contextTokens: latestUsage.used, contextWindow: latestUsage.size }
          : {},
        providerMetadata: {
          devinStopReason: stopReason,
          ...(latestUsage?.cost ? { devinCost: latestUsage.cost } : {}),
        },
      };
    } catch (error) {
      yield* closeReasoning();
      yield* closeText();
      throw error;
    } finally {
      // 消费方提前 break/丢弃 generator（非 abortSignal 路径）时 abort：
      // 在途请求走 cancel；排队中的 prompt 因此不再发出。
      if (!promptSettled) cancel.abort();
      // sidecar session 一次性使用：复用会让每次 compact/标题调用的完整
      // 转录在同一 ACP session 里累积膨胀并互相污染。
      if (!isMainTurn) await this.bridge.invalidateSession(sessionKey);
    }
  }

  /**
   * 组装 prompt parts：[上下文 resource] + [新 session 历史前缀] + [未见增量]。
   * 多轮历史由 Devin ACP session 自己维护；只有 isNew（新 session/恢复失败/
   * 历史分叉重建）才把 ZCode 历史序列化为文本前缀。
   * 增量是"最后一条 assistant 之后的全部消息"，不是只有最后一条 user：
   * steer、附件（prompt_attachment 单独成 user/system 消息）、reminder 等
   * 同轮多条消息都必须送达。
   */
  private buildPromptParts(
    messages: ModelExecutionRequest["messages"],
    isNewSession: boolean,
  ): DevinAcpPromptPart[] {
    if (findLastUserMessageIndex(messages) < 0) return [];
    const unseenStart = unseenStartIndex(messages);
    const parts: DevinAcpPromptPart[] = [];

    if (isNewSession) {
      const context = extractForwardableContext(messages, this.contextForward);
      if (context) {
        parts.push({
          type: "resource",
          resource: { uri: DEVIN_CONTEXT_RESOURCE_URI, text: context, mimeType: "text/markdown" },
        });
      }
      const history = messages.slice(0, unseenStart);
      if (history.length > 0) {
        parts.push({ type: "text", text: flattenTranscriptForNewSession(history) });
      }
    }

    for (const message of messages.slice(unseenStart)) {
      const text =
        message.role === "user"
          ? modelMessageContentToText(message.content)
          : serializeTranscriptMessage(message);
      if (text) parts.push({ type: "text", text });
    }
    return parts;
  }

  /**
   * sidecar 任务（compact/title/…）是自包含调用：payload 在 messages 里，
   * 不做 contextForward 注入、不靠"最新 user 消息"捷径——逐条序列化全部内容。
   */
  private buildSidecarParts(
    messages: ModelExecutionRequest["messages"],
  ): DevinAcpPromptPart[] {
    const text = flattenTranscriptForNewSession(messages, {
      // sidecar 的 messages 即任务主体（如 compact 的转录+指令），不是会话历史：
      // 总上限与单条上限都放宽、tool 结果不再只留一行——否则摘要输入严重失真。
      maxChars: 400_000,
      messageMaxChars: 50_000,
      toolMaxChars: 2_000,
      header: "以下是本次调用的完整输入内容：",
      includeSystem: true,
    });
    return text ? [{ type: "text", text }] : [];
  }
}

/** Devin 未见增量的起点：最后一条 assistant 消息之后（历史以 assistant 结尾）。 */
function unseenStartIndex(
  messages: ModelExecutionRequest["messages"],
): number {
  const lastUserIndex = findLastUserMessageIndex(messages);
  const end = lastUserIndex < 0 ? messages.length : lastUserIndex;
  for (let index = end - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") return index + 1;
  }
  return 0;
}

/** "Devin 已见历史前缀"的稳定指纹：前缀分叉（编辑/回滚/换模型）时触发重建。 */
function hashMessagesForSync(
  messages: ModelExecutionRequest["messages"],
): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash
      .update(message.role)
      .update("\0")
      .update(modelMessageContentToText(message.content))
      .update("\0");
  }
  return hash.digest("hex");
}

function findLastUserMessageIndex(
  messages: ModelExecutionRequest["messages"],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

function mapStopReason(stopReason: string): string {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "refusal":
      return "content-filter";
    case "cancelled":
      return "cancelled";
    default:
      return "stop";
  }
}

/**
 * runPrompt 的回调式 update → async generator 拉取队列。
 * 完成时带上 stopReason；失败时让 next() 抛出原始错误。
 */
class UpdateQueue {
  private readonly queue: DevinAcpUpdate[] = [];
  private waiter?: (result: IteratorResult<DevinAcpUpdate>) => void;
  private finished = false;
  private stopReason = "end_turn";
  private error?: unknown;

  push(update: DevinAcpUpdate): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: update, done: false });
      return;
    }
    this.queue.push(update);
  }

  complete(stopReason: string): void {
    this.finished = true;
    this.stopReason = stopReason;
    this.flushWaiter();
  }

  fail(error: unknown): void {
    this.finished = true;
    this.error = error;
    this.flushWaiter();
  }

  async next(): Promise<
    | { done: true; value?: undefined; stopReason: string }
    | { done: false; value: DevinAcpUpdate }
  > {
    if (this.queue.length > 0) {
      return { done: false, value: this.queue.shift()! };
    }
    if (this.error) throw this.error;
    if (this.finished) return { done: true, stopReason: this.stopReason };
    const item = await new Promise<IteratorResult<DevinAcpUpdate>>((resolve) => {
      this.waiter = resolve;
    });
    if (item.done) {
      if (this.error) throw this.error;
      return { done: true, stopReason: this.stopReason };
    }
    return { done: false, value: item.value };
  }

  private flushWaiter(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined as never, done: true });
  }
}
