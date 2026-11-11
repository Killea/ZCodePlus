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
    promptTimeoutMs: options.promptTimeoutMs,
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
        const oldestKey = pool.keys().next().value;
        if (oldestKey === undefined) break;
        const evicted = pool.get(oldestKey);
        pool.delete(oldestKey);
        void evicted?.dispose();
      }
    } else {
      // 同 key 复用时刷新注入依赖（logger / listMcpServers getter 可能换了实例）。
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
    const handle = await this.bridge.ensureSession(sessionKey);
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

    let promptSettled = false;
    try {
      const promptDone = this.bridge.runPrompt({
        acpSessionId: handle.acpSessionId,
        parts,
        ...(request.abortSignal ? { signal: request.abortSignal } : {}),
        onUpdate: (update) => updates.push(update),
      });
      promptDone.then(
        (result) => {
          promptSettled = true;
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
      // 消费方提前 break/丢弃 generator（非 abortSignal 路径）时，Devin 侧任务
      // 仍在跑且 updates 无界堆积；尽力取消避免泄漏。
      if (!promptSettled) this.bridge.cancelPrompt(handle.acpSessionId);
    }
  }

  /**
   * 组装 prompt parts：[上下文 resource] + [新 session 历史前缀] + [当前 user 文本]。
   * 多轮历史由 Devin ACP session 自己维护；只有 isNew（新 session/恢复失败/切模型）
   * 才把 ZCode 历史序列化为文本前缀。
   */
  private buildPromptParts(
    messages: ModelExecutionRequest["messages"],
    isNewSession: boolean,
  ): DevinAcpPromptPart[] {
    const lastUserIndex = findLastUserMessageIndex(messages);
    if (lastUserIndex < 0) return [];
    const parts: DevinAcpPromptPart[] = [];

    if (isNewSession) {
      const context = extractForwardableContext(messages, this.contextForward);
      if (context) {
        parts.push({
          type: "resource",
          resource: { uri: DEVIN_CONTEXT_RESOURCE_URI, text: context, mimeType: "text/markdown" },
        });
      }
      const history = messages.slice(0, lastUserIndex);
      if (history.length > 0) {
        parts.push({ type: "text", text: flattenTranscriptForNewSession(history) });
      }
    }

    parts.push({
      type: "text",
      text: modelMessageContentToText(messages[lastUserIndex].content),
    });
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
      // 上限放宽避免摘要输入被砍到失真；system 角色也是 payload 的一部分。
      maxChars: 400_000,
      header: "以下是本次调用的完整输入内容：",
      includeSystem: true,
    });
    return text ? [{ type: "text", text }] : [];
  }
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
