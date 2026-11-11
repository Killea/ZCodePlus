import { describe, expect, it } from "vitest";
import { CoreErrorType, createSessionId, type ModelInputMessage } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import {
  DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES,
  projectMessagesForMediaBudget,
} from "../src/runtime/helpers/media-budget.js";
import { projectCompactMediaForRetry } from "../src/runtime/helpers/compact-media.js";
import { isModelMediaTooLargeError } from "../src/runtime/helpers/model-errors.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestImageArtifactStore } from "./test-image-artifact-store.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("model request media budget", () => {
  it("keeps latest user media and strips older media when the budget is exceeded", () => {
    const oldImage = imageBlock("old", 80);
    const currentImage = imageBlock("current", 60);
    const result = projectMessagesForMediaBudget(
      [
        { role: "user", content: [{ type: "text", text: "old" }, oldImage] },
        { role: "assistant", content: "old answer" },
        { role: "user", content: [{ type: "text", text: "current" }, currentImage] },
      ],
      { maxMediaBytes: currentImage.dataUrl.length + 10 },
    );

    const oldContent = result.messages[0]!.content;
    const currentContent = result.messages[2]!.content;
    expect(result.omittedMediaCount).toBe(1);
    expect(Array.isArray(oldContent) ? oldContent[1] : undefined).toMatchObject({
      type: "text",
      text: expect.stringContaining("Media omitted"),
    });
    expect(Array.isArray(currentContent) ? currentContent[1] : undefined).toMatchObject({
      type: "image",
      source: { placeholder: "current" },
    });
  });

  it("does not treat cache-control on a meta user message as the latest real user media marker", () => {
    const currentImage = imageBlock("current", 60);
    const metaImage = imageBlock("meta", 120);
    const result = projectMessagesForMediaBudget(
      [
        {
          role: "user",
          content: [{ type: "text", text: "current prompt" }, currentImage],
        },
        {
          role: "user",
          cacheControl: { type: "ephemeral" },
          content: [
            {
              type: "text",
              text: "<system-reminder>\noutput style reminder\n</system-reminder>",
            },
            metaImage,
          ],
        },
      ],
      { maxMediaBytes: currentImage.dataUrl.length + 10 },
    );

    const currentContent = result.messages[0]!.content;
    const metaContent = result.messages[1]!.content;
    expect(result.omittedMediaCount).toBe(1);
    expect(Array.isArray(currentContent) ? currentContent[1] : undefined).toMatchObject({
      type: "image",
      source: { placeholder: "current" },
    });
    expect(Array.isArray(metaContent) ? metaContent[1] : undefined).toMatchObject({
      type: "text",
      text: expect.stringContaining("Media omitted"),
    });
  });

  it("throws before provider calls when the current user media exceeds the budget", () => {
    const tooLargeImage = imageBlock("current", 128);
    let thrown: unknown;

    try {
      projectMessagesForMediaBudget([{ role: "user", content: [tooLargeImage] }], {
        maxMediaBytes: tooLargeImage.dataUrl.length - 1,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
      context: expect.objectContaining({
        code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
      }),
      type: CoreErrorType.InvalidInput,
      recoverable: true,
    });
  });

  it("throws for oversized current user media when the prompt starts with a literal system-reminder tag", async () => {
    let modelCallCount = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-media-budget-literal-system-reminder"),
      {
        mode: "plan",
        workingDirectory: "/tmp/zcode-runtime-media-budget-literal-system-reminder",
      },
      {
        artifactStore: createTestImageArtifactStore(),
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCallCount++;
            return {
              finishReason: "stop",
              text: "unexpected",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );
    // 16 个附件共享同一字符串引用：逻辑请求体超过 40MiB，同时避免测试重复分配大 payload。
    const sharedImageDataUrl = imageDataUrl(5 * 1024 * 1024);
    const attachments = Array.from({ length: 16 }, (_, index) => ({
      type: "image" as const,
      path: `[image #${index + 1}]`,
      content: sharedImageDataUrl,
    }));
    let thrown: unknown;

    try {
      await runtime.executeTurn(
        "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        attachments,
      );
    } catch (error) {
      thrown = error;
    }

    expect(modelCallCount).toBe(0);
    expect((thrown as { cause?: unknown }).cause).toMatchObject({
      type: CoreErrorType.InvalidInput,
      recoverable: true,
    });
  });

  it("strips all media for zero-budget generic projections", () => {
    const image = imageBlock("old", 32);
    const result = projectMessagesForMediaBudget(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "old" },
            image,
            { type: "video", mediaType: "video/mp4", dataUrl: "data:video/mp4;base64,AAAA" },
          ],
        },
      ],
      { maxMediaBytes: 0, preserveLatestUserMedia: false },
    );

    expect(result.retainedMediaCount).toBe(0);
    expect(result.omittedMediaCount).toBe(2);
    expect(result.projectedMediaBytes).toBe(0);
  });

  it("does not count unchanged compact text blocks as replaced media", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "already text" },
          { type: "text", text: "still text" },
        ],
      },
    ];

    const result = projectCompactMediaForRetry(messages);

    expect(result.replacedMediaCount).toBe(0);
    expect(result.messages[0]).toBe(messages[0]);
  });

  it.each([
    { type: "image" as const, dataUrl: "data:image/png;base64,/w==" },
    { type: "video" as const, mediaType: "video/mp4", dataUrl: "data:video/mp4;base64,/w==" },
    {
      type: "file" as const,
      mediaType: "application/pdf",
      dataUrl: "data:application/pdf;base64,/w==",
    },
    { type: "file" as const, mediaType: "audio/wav", dataUrl: "data:audio/wav;base64,/w==" },
  ])("counts the complete $type data URL and uses the shared error code", (block) => {
    const messages: ModelInputMessage[] = [{ role: "user", content: [block] }];
    const bytes = Buffer.byteLength(block.dataUrl);
    const result = projectMessagesForMediaBudget(messages, { maxMediaBytes: bytes });

    expect(result.messages).toBe(messages);
    expect(result.totalMediaBytes).toBe(bytes);
    expect(() => projectMessagesForMediaBudget(messages, { maxMediaBytes: bytes - 1 })).toThrow(
      expect.objectContaining({
        code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
        type: CoreErrorType.InvalidInput,
        recoverable: true,
      }),
    );
  });

  it("shares one budget across current image and video attachments", () => {
    const image = imageBlock("current", 20);
    const video = {
      type: "video" as const,
      mediaType: "video/mp4",
      dataUrl: "data:video/mp4;base64,AAAA",
    };
    const messages: ModelInputMessage[] = [{ role: "user", content: [image, video] }];
    const total = Buffer.byteLength(image.dataUrl) + Buffer.byteLength(video.dataUrl);

    // 两个附件单独均可容纳；只有合计超限才应拒绝，避免测试被单附件超限误满足。
    expect(
      projectMessagesForMediaBudget([{ role: "user", content: [image] }], {
        maxMediaBytes: total - 1,
      }).omittedMediaCount,
    ).toBe(0);
    expect(
      projectMessagesForMediaBudget([{ role: "user", content: [video] }], {
        maxMediaBytes: total - 1,
      }).omittedMediaCount,
    ).toBe(0);
    expect(projectMessagesForMediaBudget(messages, { maxMediaBytes: total }).messages).toBe(
      messages,
    );
    expect(() => projectMessagesForMediaBudget(messages, { maxMediaBytes: total - 1 })).toThrow(
      expect.objectContaining({
        code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
        context: expect.objectContaining({
          maxMediaBytes: total - 1,
          protectedMediaBytes: total,
          totalMediaBytes: total,
        }),
      }),
    );
  });

  it("counts base64 expansion and the URL prefix against the default video budget", () => {
    const video = {
      type: "video" as const,
      mediaType: "video/mp4",
      dataUrl: `data:video/mp4;base64,${Buffer.alloc(30 * 1024 * 1024).toString("base64")}`,
    };
    expect(() => projectMessagesForMediaBudget([{ role: "user", content: [video] }])).toThrow(
      expect.objectContaining({ code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE" }),
    );
  });

  it.each([false, true])(
    "retains mixed history newest-first after protecting current media (video newest: %s)",
    (videoNewest) => {
      const image = imageBlock("old image", 20);
      const video = {
        type: "video" as const,
        mediaType: "video/mp4",
        dataUrl: "data:video/mp4;base64,AAAA",
      };
      const current = imageBlock("current", 4);
      const [older, newer] = videoNewest ? [image, video] : [video, image];
      const messages: ModelInputMessage[] = [
        { role: "tool", toolCallId: "old", content: [older] },
        { role: "user", content: [current] },
        { role: "tool", toolCallId: "new", content: [newer] },
      ];
      const original = structuredClone(messages);
      const budget = Buffer.byteLength(current.dataUrl) + Buffer.byteLength(newer.dataUrl);
      const result = projectMessagesForMediaBudget(messages, {
        maxMediaBytes: budget,
        latestRealUserMessageIndex: 1,
      });

      expect(result.omittedMediaCount).toBe(1);
      expect(result.projectedMediaBytes).toBe(budget);
      expect(result.totalMediaBytes).toBe(budget + Buffer.byteLength(older.dataUrl));
      expect(result.messages[0]!.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Media omitted") }),
      ]);
      expect(result.messages[1]!.content).toEqual([current]);
      expect(result.messages[2]!.content).toEqual([newer]);
      expect(messages).toEqual(original);
    },
  );

  it("protects current attachments before a newer tool video and excludes text-backed files", () => {
    const current = imageBlock("current", 4);
    const video = {
      type: "video" as const,
      mediaType: "video/mp4",
      dataUrl: "data:video/mp4;base64,AAAA",
    };
    const textFile = {
      type: "file" as const,
      mediaType: "text/plain",
      text: "file text",
      dataUrl: "data:text/plain;base64,dGV4dA==",
    };
    const result = projectMessagesForMediaBudget(
      [
        { role: "user", content: [current, textFile] },
        { role: "tool", toolCallId: "video", content: [video] },
      ],
      { maxMediaBytes: Buffer.byteLength(current.dataUrl), latestRealUserMessageIndex: 0 },
    );

    expect(result.messages[0]!.content).toEqual([current, textFile]);
    expect(result.omittedMediaCount).toBe(1);
    expect(result.messages[1]!.content).toEqual([expect.objectContaining({ type: "text" })]);
  });

  it("replaces video blocks with placeholders on retry like image blocks", () => {
    // video 与 image 同语义：retry 时媒体降占位；漏掉会让大体积视频打穿 retry 的媒体瘦身。
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "video please" },
          {
            type: "video" as const,
            mediaType: "video/mp4",
            dataUrl: `data:video/mp4;base64,${"v".repeat(64)}`,
          },
        ],
      },
    ];

    const result = projectCompactMediaForRetry(messages);

    expect(result.replacedMediaCount).toBe(1);
    const content = result.messages[0]!.content;
    expect(Array.isArray(content) ? content[1] : undefined).toEqual({
      type: "text",
      text: "[video]",
    });
  });

  it("does not classify generic media payload wording as media-too-large", () => {
    expect(isModelMediaTooLargeError(new Error("media payload checksum failed"))).toBe(false);
    expect(isModelMediaTooLargeError(new Error("image payload is too large"))).toBe(true);
    expect(isModelMediaTooLargeError({ message: "document payload exceeds provider limit" })).toBe(
      true,
    );
  });

  it("retries compact summary requests with media placeholders after a media-too-large response", async () => {
    const requests: ModelInputMessage[][] = [];
    let compactAttempts = 0;
    const generateText = async (request: { messages: ModelInputMessage[] }) => {
      requests.push(request.messages);
      const requestText = requestTextBlocks(request.messages).join("\n");
      const isCompact = requestText.includes("create a detailed summary");
      if (isCompact) {
        compactAttempts++;
        if (compactAttempts === 1) {
          expect(requestImageBlocks(request.messages)).toHaveLength(1);
          throw Object.assign(new Error("media payload is too large"), {
            code: "media_too_large",
            type: "media_too_large",
          });
        }
      }
      return {
        finishReason: "stop",
        text: isCompact ? "<summary>Media compact summary.</summary>" : "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    };
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-compact-media-budget"),
      {
        mode: "plan",
        workingDirectory: "/tmp/zcode-runtime-compact-media-budget",
      },
      {
        artifactStore: createTestImageArtifactStore(),
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          generateText,
          async *streamText(request: { messages: ModelInputMessage[] }) {
            const result = await generateText(request);
            if (result.text) {
              yield { id: "compact-media-text", type: "text_start" };
              yield { id: "compact-media-text", text: result.text, type: "text_delta" };
              yield { id: "compact-media-text", type: "text_end" };
            }
            yield {
              finishReason: result.finishReason,
              type: "finish",
              usage: result.usage,
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("old screenshot", [
      { type: "image", path: "[image #1]", content: imageDataUrl(128) },
    ]);
    runtime["messageHistory"].addUser(
      [
        { type: "text", text: "old document attachment" },
        {
          type: "file",
          mediaType: "application/pdf",
          name: "requirements.pdf",
          dataUrl: "data:application/pdf;base64,AAAA",
        },
      ],
      { source: "real_user" },
    );
    await runtime.executeTurn("second turn");
    await runtime.executeTurn("/compact");

    const compactRequest = requests[2] ?? [];
    const retryCompactRequest = requests[3] ?? [];
    const retryCompactRequestText = requestTextBlocks(retryCompactRequest).join("\n");
    expect(requestImageBlocks(compactRequest)).toHaveLength(1);
    expect(requestImageBlocks(retryCompactRequest)).toHaveLength(0);
    expect(requestFileBlocks(compactRequest)).toHaveLength(1);
    expect(requestFileBlocks(retryCompactRequest)).toHaveLength(0);
    expect(retryCompactRequestText).toContain("[image]");
    expect(retryCompactRequestText).toContain("[document]");
    expect(retryCompactRequestText).not.toContain("Media omitted from provider request");
    expect(retryCompactRequestText).toContain("create a detailed summary");
  });

  it("textifies current user media for text-only models before applying media budget", async () => {
    const requests: ModelInputMessage[][] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-media-capability-text-only"),
      {
        mode: "plan",
        workingDirectory: "/tmp/zcode-runtime-media-capability-text-only",
      },
      {
        artifactStore: createTestImageArtifactStore(),
        eventStore: createTestSessionEventStore(),
        modelFactory: () =>
          createTestRuntimeModel({
            inputFormat: { supportsImage: false },
            async generateText(request) {
              requests.push(request.messages);
              return {
                finishReason: "stop",
                text: "ok",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          }),
      },
    );

    await runtime.executeTurn("describe [image #1]", [
      { type: "image", path: "[image #1]", content: imageDataUrl(5 * 1024 * 1024) },
    ]);

    expect(requestImageBlocks(requests[0] ?? [])).toHaveLength(0);
    expect(requestTextBlocks(requests[0] ?? []).join("\n")).toContain(
      "does not support image input",
    );
  });

  it("keeps current user media for models that support image input", async () => {
    const requests: ModelInputMessage[][] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-media-capability-unknown"),
      {
        mode: "plan",
        workingDirectory: "/tmp/zcode-runtime-media-capability-unknown",
      },
      {
        artifactStore: createTestImageArtifactStore(),
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: ModelInputMessage[] }) {
            requests.push(request.messages);
            return {
              finishReason: "stop",
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("describe [image #1]", [
      { type: "image", path: "[image #1]", content: imageDataUrl(128) },
    ]);

    expect(requestImageBlocks(requests[0] ?? [])).toHaveLength(1);
  });

  it("applies the shared 40 MiB budget to mixed runtime requests", async () => {
    const requests: ModelInputMessage[][] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-media-budget"),
      {
        mode: "plan",
        workingDirectory: "/tmp/zcode-runtime-media-budget",
      },
      {
        artifactStore: createTestImageArtifactStore(),
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: ModelInputMessage[] }) {
            requests.push(request.messages);
            return {
              finishReason: "stop",
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("old screenshot", [
      { type: "image", path: "[image #1]", content: imageDataUrl(3 * 1024 * 1024) },
    ]);
    await runtime.executeTurn("current screenshot", [
      { type: "image", path: "[image #2]", content: imageDataUrl(2 * 1024 * 1024) },
    ]);

    const secondRequestImages = requestImageBlocks(requests[1] ?? []);
    const secondRequestText = requestTextBlocks(requests[1] ?? []).join("\n");
    expect(DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES).toBe(40 * 1024 * 1024);
    expect(secondRequestImages.map((image) => image.source?.placeholder)).toEqual([
      "[image #1]",
      "[image #2]",
    ]);
    expect(secondRequestText).not.toContain("Media omitted from provider request");

    // 36MiB 编码视频单独合法，但与两张历史图片合计超过 40MiB；只裁剪最旧图片。
    const videoDataUrl = `data:video/mp4;base64,${Buffer.alloc(27 * 1024 * 1024).toString("base64")}`;
    await runtime.executeTurn("current video", [
      { type: "video", filename: "current.mp4", content: videoDataUrl },
    ]);
    const thirdRequest = requests[2] ?? [];
    const images = requestImageBlocks(thirdRequest);
    const videos = thirdRequest.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "video")
        : [],
    );
    expect(images.map((image) => image.source?.placeholder)).toEqual(["[image #2]"]);
    expect(videos.map((video) => video.dataUrl)).toEqual([videoDataUrl]);
    expect(
      Buffer.byteLength(videoDataUrl) + Buffer.byteLength(images[0]!.dataUrl),
    ).toBeLessThanOrEqual(DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES);
    expect(requestTextBlocks(thirdRequest).join("\n")).toContain(
      "Media omitted from provider request",
    );
    expect(requestImageBlocks(requests[1] ?? [])).toHaveLength(2);
  });

  it("keeps the paired text when the adjacent image stays within budget", () => {
    const imageRefText =
      '{"image_ref":{"frame_id":"frame-keep","width":32,"height":32,"actionable":true}}';
    const smallImage = imageBlock("keep-frame", 32);
    const result = projectMessagesForMediaBudget(
      [
        {
          role: "tool",
          content: [smallImage, { type: "text", text: imageRefText }],
          toolCallId: "call_keep",
          toolName: "screenshot",
        },
        { role: "user", content: "latest" },
      ],
      { maxMediaBytes: 64 * 1024, latestRealUserMessageIndex: 1 },
    );

    expect(requestTextBlocks(result.messages).join("\n")).toContain("frame-keep");
    expect(requestImageBlocks(result.messages)).toHaveLength(1);
  });

  it("keeps a non-adjacent status text when its image is budget-omitted (SG-01)", () => {
    const statusText = "处理失败：超时";
    const captionText = "附截图供诊断";
    const result = projectMessagesForMediaBudget(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: statusText },
            { type: "text", text: captionText },
            imageBlock("plain-diag", 4096),
          ],
          toolCallId: "call_plain",
          toolName: "plain_check",
        },
        { role: "user", content: [{ type: "text", text: "latest" }, imageBlock("current", 32)] },
      ],
      { maxMediaBytes: 64, latestRealUserMessageIndex: 1 },
    );

    const joined = requestTextBlocks(result.messages).join("\n");
    // 谓词化后：普通 caption 不是媒体凭证，不再随图移除（通用工具的媒体
    // 语义保持 pre-CUA 行为）；只有 producer 帧凭证才原子配对。
    expect(joined).toContain(statusText);
    expect(joined).toContain(captionText);
  });

  it("keeps plain-text-only tool results byte-identical under any budget pressure", () => {
    const result = projectMessagesForMediaBudget(
      [
        {
          role: "tool",
          content: [{ type: "text", text: "3 files changed" }],
          toolCallId: "call_text",
          toolName: "diff_summary",
        },
        { role: "user", content: "latest" },
      ],
      { maxMediaBytes: 0, latestRealUserMessageIndex: 1 },
    );

    expect(requestTextBlocks(result.messages).join("\n")).toContain("3 files changed");
  });
});

function imageBlock(placeholder: string, payloadBytes: number) {
  return {
    type: "image" as const,
    mediaType: "image/png",
    dataUrl: imageDataUrl(payloadBytes),
    source: {
      id: placeholder,
      kind: "inline" as const,
      mimeType: "image/png",
      placeholder,
    },
  };
}

function imageDataUrl(payloadBytes: number): string {
  return `data:image/png;base64,${"A".repeat(payloadBytes)}`;
}

function requestImageBlocks(messages: ModelInputMessage[]) {
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : [],
  );
}

function requestFileBlocks(messages: ModelInputMessage[]) {
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === "file") : [],
  );
}

function requestTextBlocks(messages: ModelInputMessage[]): string[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
      : [message.content],
  );
}

it("does not protect older media when the latest genuine user was projected to system", () => {
  const olderImage = imageBlock("old", 128);
  const result = projectMessagesForMediaBudget(
    [
      { role: "user", content: [olderImage] },
      { role: "assistant", content: "working" },
      { role: "system", content: "The user sent a new message while you were working:\nnew text" },
    ],
    { latestRealUserMessageIndex: 2, maxMediaBytes: 1 },
  );
  expect(result.omittedMediaCount).toBe(1);
});

it("honors explicit absence of a genuine user without guessing from provider user roles", () => {
  const result = projectMessagesForMediaBudget(
    [{ role: "user", content: [imageBlock("coordinator", 128)] }],
    { latestRealUserMessageIndex: -1, maxMediaBytes: 1 },
  );
  expect(result.omittedMediaCount).toBe(1);
});

describe("model request media vision token budget", () => {
  // ninfer merged vision token = 32×32 像素（2×2 个 16px patch）。
  // 1920×1080 → ceil(1920/32) × ceil(1080/32) = 60 × 34 = 2040 tokens。
  const TOKENS_1080P = 2040;

  it("counts merged vision tokens from image pixel dimensions", () => {
    const result = projectMessagesForMediaBudget(
      [{ role: "user", content: [visionImageBlock("shot", 1920, 1080)] }],
      { maxVisionTokens: TOKENS_1080P },
    );

    expect(result.totalVisionTokens).toBe(TOKENS_1080P);
    expect(result.projectedVisionTokens).toBe(TOKENS_1080P);
    expect(result.omittedMediaCount).toBe(0);
  });

  it("drops the oldest images when only the vision token budget is exceeded", () => {
    const result = projectMessagesForMediaBudget(
      [
        { role: "tool", toolCallId: "old", content: [visionImageBlock("old", 1920, 1080)] },
        { role: "tool", toolCallId: "mid", content: [visionImageBlock("mid", 1920, 1080)] },
        { role: "user", content: [visionImageBlock("current", 1920, 1080)] },
      ],
      { maxVisionTokens: TOKENS_1080P * 2, latestRealUserMessageIndex: 2 },
    );

    expect(result.omittedMediaCount).toBe(1);
    expect(result.projectedVisionTokens).toBe(TOKENS_1080P * 2);
    expect(result.messages[0]!.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Media omitted") }),
    ]);
    expect(result.messages[1]!.content).toEqual([
      expect.objectContaining({ type: "image", source: expect.objectContaining({ placeholder: "mid" }) }),
    ]);
    expect(result.messages[2]!.content).toEqual([
      expect.objectContaining({
        type: "image",
        source: expect.objectContaining({ placeholder: "current" }),
      }),
    ]);
  });

  it("still applies the byte budget when the vision token budget allows everything", () => {
    const video = {
      type: "video" as const,
      mediaType: "video/mp4",
      dataUrl: `data:video/mp4;base64,${"v".repeat(64)}`,
    };
    const result = projectMessagesForMediaBudget(
      [
        { role: "tool", toolCallId: "shot", content: [visionImageBlock("old", 1920, 1080)] },
        { role: "user", content: [video] },
      ],
      {
        maxMediaBytes: Buffer.byteLength(video.dataUrl),
        maxVisionTokens: Number.MAX_SAFE_INTEGER,
        latestRealUserMessageIndex: 1,
      },
    );

    // token 预算不参与 video，字节预算单独裁掉旧图。
    expect(result.totalVisionTokens).toBe(TOKENS_1080P);
    expect(result.omittedMediaCount).toBe(1);
    expect(result.projectedVisionTokens).toBe(0);
  });

  it("bounds a long screenshot history to the published vision token budget", () => {
    // 验收口径：ninfer 默认 262144 max_vision_tokens 恰好容纳 128 张 2040-token
    // 截图（128×2040=261120）；第 129 张及更早的历史必须换占位文本。
    const history = Array.from({ length: 129 }, (_, index) => ({
      role: "tool" as const,
      toolCallId: `shot-${index}`,
      content: [visionImageBlock(`shot-${index}`, 1920, 1080)],
    }));
    const messages: ModelInputMessage[] = [
      ...history,
      { role: "user", content: [visionImageBlock("current", 1920, 1080)] },
    ];

    const result = projectMessagesForMediaBudget(messages, { maxVisionTokens: 262_144 });

    expect(result.projectedVisionTokens).toBeLessThanOrEqual(262_144);
    expect(result.retainedMediaCount).toBe(128);
    expect(result.omittedMediaCount).toBe(2);
    expect(result.messages[0]!.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Media omitted") }),
    ]);
    expect(result.messages[1]!.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Media omitted") }),
    ]);
    expect(result.messages.at(-1)!.content).toEqual([
      expect.objectContaining({
        type: "image",
        source: expect.objectContaining({ placeholder: "current" }),
      }),
    ]);
  });

  it("throws the shared error code when current media exceeds the vision budget", () => {
    expect(() =>
      projectMessagesForMediaBudget(
        [
          {
            role: "user",
            content: [
              visionImageBlock("a", 1920, 1080),
              visionImageBlock("b", 1920, 1080),
            ],
          },
        ],
        { maxVisionTokens: TOKENS_1080P },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
        type: CoreErrorType.InvalidInput,
        context: expect.objectContaining({
          maxVisionTokens: TOKENS_1080P,
          protectedVisionTokens: TOKENS_1080P * 2,
        }),
      }),
    );
  });

  it("counts undecodable image payloads as zero vision tokens", () => {
    const result = projectMessagesForMediaBudget(
      [{ role: "user", content: [imageBlock("fake", 64)] }],
      { maxVisionTokens: 1 },
    );

    expect(result.totalVisionTokens).toBe(0);
    expect(result.omittedMediaCount).toBe(0);
  });

  it("rejects a non-finite or negative vision token budget", () => {
    for (const maxVisionTokens of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => projectMessagesForMediaBudget([], { maxVisionTokens })).toThrow(
        expect.objectContaining({ type: CoreErrorType.ConfigurationError }),
      );
    }
  });
});

function visionImageBlock(placeholder: string, width: number, height: number) {
  return {
    type: "image" as const,
    mediaType: "image/png",
    dataUrl: pngDataUrl(width, height),
    source: {
      id: placeholder,
      kind: "inline" as const,
      mimeType: "image/png",
      placeholder,
    },
  };
}

// 最小合法 PNG 头：8B 签名 + IHDR 块（尺寸字段即预算所需的全部输入）。
function pngDataUrl(width: number, height: number): string {
  const header = Buffer.alloc(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return `data:image/png;base64,${header.toString("base64")}`;
}
