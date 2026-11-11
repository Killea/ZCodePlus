import { createHash } from "node:crypto";
import { modelMessageContentToText } from "@zcode/contracts";
import type { ModelExecutionRequest } from "../model.js";
import type { DevinAcpUpdate } from "./bridge.js";

/** executor 的纯函数/队列辅助：从 executor.ts 拆出（400 行限制）。 */

/** Devin 未见增量的起点：最后一条 assistant 消息之后（历史以 assistant 结尾）。 */
export function unseenStartIndex(
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
export function hashMessagesForSync(
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

export function findLastUserMessageIndex(
  messages: ModelExecutionRequest["messages"],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

export function mapStopReason(stopReason: string): string {
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
export class UpdateQueue {
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
