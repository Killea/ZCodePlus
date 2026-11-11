import {
  CoreErrorType,
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  createCoreError,
  modelMessageContentToText,
  readImageDataUrlSize,
  traceContextToLogContext,
} from "../deps.js";
import type {
  Logger,
  ModelInputFormat,
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import {
  officialCuaImageRefIndexesForUnavailableMedia,
  officialCuaRasterUnavailableBlock,
} from "./official-cua-media.js";
import { findLatestRealUserMessageIndex } from "./conversation.js";
import {
  projectMessagesForInputFormat,
  type MediaCapabilityProjection,
} from "./media-capability.js";

// 独立的视频预算无法约束请求总量；所有媒体统一按编码后的体积计入 40MiB，
// 为正文等非媒体内容预留空间。单文件原始字节限制由附件输入/Read 层负责。
export const DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES = 40 * 1024 * 1024;

interface MediaBlockRef {
  blockIndex: number;
  requestBytes: number;
  visionTokens: number;
  messageIndex: number;
  protected: boolean;
}

export interface MediaBudgetProjection {
  messages: ModelInputMessage[];
  omittedMediaCount: number;
  projectedMediaBytes: number;
  projectedVisionTokens: number;
  retainedMediaCount: number;
  totalMediaBytes: number;
  totalVisionTokens: number;
}

export interface ModelMediaPolicyProjection {
  capabilityProjection: MediaCapabilityProjection;
  mediaBudgetProjection: MediaBudgetProjection;
  messages: ModelInputMessage[];
}

export function projectMessagesForModelMediaPolicy(
  messages: ModelInputMessage[],
  inputFormat: ModelInputFormat,
  options: { latestRealUserMessageIndex?: number; maxVisionTokens?: number } = {},
): ModelMediaPolicyProjection {
  // 直接调用 Model 的辅助链路曾只补 capability、漏掉聚合预算；两阶段必须
  // 在同一个请求策略边界串联，避免新增消费者继续手工拼装而遗漏其中一半。
  const capabilityProjection = projectMessagesForInputFormat(messages, inputFormat);
  const mediaBudgetProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
    maxVisionTokens: options.maxVisionTokens,
  });
  return {
    capabilityProjection,
    mediaBudgetProjection,
    messages: mediaBudgetProjection.messages,
  };
}

interface MediaBudgetProjectionOptions {
  latestRealUserMessageIndex?: number;
  maxMediaBytes?: number;
  /**
   * provider 公布的单请求视觉 token 上限（如 ninfer `max_vision_tokens`）。
   * 配置后图片按像素尺寸折算 token 计入第二预算；缺省只执行字节预算。
   */
  maxVisionTokens?: number;
  preserveLatestUserMedia?: boolean;
}

export function projectMessagesForMediaBudget(
  messages: ModelInputMessage[],
  options: MediaBudgetProjectionOptions = {},
): MediaBudgetProjection {
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES;
  if (!Number.isFinite(maxMediaBytes) || maxMediaBytes < 0) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Invalid model request media budget", {
      context: { maxMediaBytes },
      recoverable: true,
    });
  }
  const maxVisionTokens = options.maxVisionTokens;
  if (maxVisionTokens !== undefined && (!Number.isFinite(maxVisionTokens) || maxVisionTokens < 0)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Invalid model request media vision token budget",
      { context: { maxVisionTokens }, recoverable: true },
    );
  }
  const latestUserIndex =
    options.preserveLatestUserMedia === false
      ? -1
      : resolveLatestRealUserMessageIndex(messages, options.latestRealUserMessageIndex);
  const mediaBlocks = collectMediaBlocks(
    messages,
    latestUserIndex,
    maxVisionTokens !== undefined,
  );
  const totalMediaBytes = sumMediaBytes(mediaBlocks);
  const totalVisionTokens = sumMediaVisionTokens(mediaBlocks);

  const overByteBudget = totalMediaBytes > maxMediaBytes;
  const overVisionBudget = maxVisionTokens !== undefined && totalVisionTokens > maxVisionTokens;
  if (!overByteBudget && !overVisionBudget) {
    return {
      messages,
      omittedMediaCount: 0,
      projectedMediaBytes: totalMediaBytes,
      projectedVisionTokens: totalVisionTokens,
      retainedMediaCount: mediaBlocks.length,
      totalMediaBytes,
      totalVisionTokens,
    };
  }

  const protectedMedia = mediaBlocks.filter((block) => block.protected);
  const protectedMediaBytes = sumMediaBytes(protectedMedia);
  const protectedVisionTokens = sumMediaVisionTokens(protectedMedia);
  if (
    protectedMediaBytes > maxMediaBytes ||
    (maxVisionTokens !== undefined && protectedVisionTokens > maxVisionTokens)
  ) {
    const errorCode = MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE;
    const error = createCoreError(
      CoreErrorType.InvalidInput,
      "Current attachments are too large to send. Remove or compress attachments and try again.",
      {
        context: {
          code: errorCode,
          maxMediaBytes,
          maxVisionTokens,
          protectedMediaBytes,
          protectedVisionTokens,
          totalMediaBytes,
          totalVisionTokens,
        },
        recoverable: true,
      },
    );
    // 跨进程只传通用 INVALID_INPUT 会丢失本地化语义；请求总量错误
    // 必须使用统一附件码，避免把 PDF 或混合附件误报成图片/视频错误。
    error.code = errorCode;
    throw error;
  }

  const retainedKeys = new Set(protectedMedia.map(mediaKey));
  let remainingBytes = maxMediaBytes - protectedMediaBytes;
  let remainingVisionTokens =
    maxVisionTokens === undefined
      ? Number.POSITIVE_INFINITY
      : maxVisionTokens - protectedVisionTokens;
  const historicalMedia = mediaBlocks
    .filter((block) => !block.protected)
    .sort(
      (left, right) => right.messageIndex - left.messageIndex || right.blockIndex - left.blockIndex,
    );
  for (const media of historicalMedia) {
    if (media.requestBytes > remainingBytes || media.visionTokens > remainingVisionTokens) continue;
    retainedKeys.add(mediaKey(media));
    remainingBytes -= media.requestBytes;
    remainingVisionTokens -= media.visionTokens;
  }

  const messagesWithBudget = messages.map((message, messageIndex) => ({
    ...message,
    content: projectContent(message.content, messageIndex, retainedKeys),
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
  }));
  const retainedMediaCount = retainedKeys.size;
  const retainedMedia = mediaBlocks.filter((block) => retainedKeys.has(mediaKey(block)));

  return {
    messages: messagesWithBudget,
    omittedMediaCount: mediaBlocks.length - retainedMediaCount,
    projectedMediaBytes: retainedMedia.reduce((total, block) => total + block.requestBytes, 0),
    projectedVisionTokens: retainedMedia.reduce((total, block) => total + block.visionTokens, 0),
    retainedMediaCount,
    totalMediaBytes,
    totalVisionTokens,
  };
}

function resolveLatestRealUserMessageIndex(
  messages: ModelInputMessage[],
  latestRealUserMessageIndex: number | undefined,
): number {
  // cacheControl 现在是 provider cache marker，latest real user 身份由
  // provider projection 传入的 request-local index 承接；-1 明确表示没有真实用户，缺失时才回退到文本启发式。
  if (
    latestRealUserMessageIndex !== undefined &&
    Number.isInteger(latestRealUserMessageIndex) &&
    latestRealUserMessageIndex >= -1 &&
    latestRealUserMessageIndex < messages.length
  ) {
    return latestRealUserMessageIndex;
  }
  return findLatestRealUserMessageIndex(messages);
}

export function logMediaBudgetProjection(
  logger: Logger | undefined,
  traceContext: TraceContext,
  projection: MediaBudgetProjection,
  options: { event: string; message: string },
): void {
  if (projection.omittedMediaCount === 0) return;
  logger?.debug(options.message, {
    ...traceContextToLogContext(traceContext),
    event: options.event,
    module: "core.runtime",
    status: "completed",
    omittedMediaCount: projection.omittedMediaCount,
    projectedMediaBytes: projection.projectedMediaBytes,
    projectedVisionTokens: projection.projectedVisionTokens,
    retainedMediaCount: projection.retainedMediaCount,
    totalMediaBytes: projection.totalMediaBytes,
    totalVisionTokens: projection.totalVisionTokens,
  });
}

function collectMediaBlocks(
  messages: ModelInputMessage[],
  latestUserIndex: number,
  visionBudgetEnabled: boolean,
): MediaBlockRef[] {
  const mediaBlocks: MediaBlockRef[] = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      const requestBytes = mediaRequestBytes(block);
      if (requestBytes === 0) return;
      mediaBlocks.push({
        blockIndex,
        requestBytes,
        // 未配置 maxVisionTokens 时跳过头部解码，零成本路径保持原状。
        visionTokens: visionBudgetEnabled ? mediaVisionTokens(block) : 0,
        messageIndex,
        protected: messageIndex === latestUserIndex,
      });
    });
  });
  return mediaBlocks;
}

function projectContent(
  content: ModelMessageContent,
  messageIndex: number,
  retainedKeys: Set<string>,
): ModelMessageContent {
  if (!Array.isArray(content)) return content;

  const omittedBlockIndexes = new Set<number>();
  content.forEach((block, blockIndex) => {
    if (mediaRequestBytes(block) === 0) return;
    if (!retainedKeys.has(mediaKey({ blockIndex, messageIndex }))) {
      omittedBlockIndexes.add(blockIndex);
    }
  });

  const pairedTextIndexes = officialCuaImageRefIndexesForUnavailableMedia(
    content,
    omittedBlockIndexes,
  );

  return content.map((block, blockIndex) => {
    if (pairedTextIndexes.has(blockIndex)) {
      return { type: "text", text: "" };
    }
    if (mediaRequestBytes(block) === 0) return cloneContentBlock(block);
    const key = mediaKey({ blockIndex, messageIndex });
    if (retainedKeys.has(key)) return cloneContentBlock(block);
    return pairedTextIndexes.has(blockIndex + 1)
      ? officialCuaRasterUnavailableBlock()
      : mediaOmittedTextBlock(block);
  });
}

function mediaRequestBytes(block: ModelMessageContentBlock): number {
  if (block.type === "image" || block.type === "video") {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  if (block.type === "file" && block.dataUrl && !block.text) {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  return 0;
}

// ninfer 按 merged vision token 计媒体聚合：一个 merged token = 2×2 个 16px
// patch = 32×32 像素，单图 token = ceil(w/32) × ceil(h/32)。视频帧 token
// 与无法从 data URL 头部解析尺寸的图片无法本地估算，这些块只受字节预算约束；
// 能解析的至少把真实成本计入，避免整串 1080p 截图绕过 provider 上限。
const VISION_TOKEN_SPAN_PX = 32;

function mediaVisionTokens(block: ModelMessageContentBlock): number {
  if (block.type !== "image") return 0;
  const size = readImageDataUrlSize(block.dataUrl);
  return size === undefined
    ? 0
    : Math.ceil(size.width / VISION_TOKEN_SPAN_PX) * Math.ceil(size.height / VISION_TOKEN_SPAN_PX);
}

function mediaOmittedTextBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  const placeholder = modelMessageContentToText([block]) || "[Attached media]";
  return {
    type: "text",
    text: `${placeholder}\n[Media omitted from provider request to keep the request body under the configured media budget.]`,
  };
}

function cloneContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  switch (block.type) {
    case "image":
    case "video":
    case "file":
      return { ...block, source: block.source ? { ...block.source } : undefined };
    case "text":
    case "reasoning":
    case "tool_reference":
    case "resource_link":
      return { ...block };
  }
}

function sumMediaBytes(mediaBlocks: MediaBlockRef[]): number {
  return mediaBlocks.reduce((total, block) => total + block.requestBytes, 0);
}

function sumMediaVisionTokens(mediaBlocks: MediaBlockRef[]): number {
  return mediaBlocks.reduce((total, block) => total + block.visionTokens, 0);
}

function mediaKey(input: Pick<MediaBlockRef, "blockIndex" | "messageIndex">): string {
  return `${input.messageIndex}:${input.blockIndex}`;
}
