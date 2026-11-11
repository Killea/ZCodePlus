import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import type { ModelInputMessage } from "@zcode/contracts";
import { runWithModelInvocationContext } from "@zcode/contracts";
import {
  extractForwardableContext,
  flattenTranscriptForNewSession,
} from "../src/model/devin-acp/context-filter.js";
import { AcpTransport } from "../src/model/devin-acp/transport.js";
import { DevinAcpBridge } from "../src/model/devin-acp/bridge.js";
import {
  createUpdateMarkerState,
  normalizeSessionUpdate,
} from "../src/model/devin-acp/session-updates.js";
import { DevinModelExecutor } from "../src/model/devin-acp/executor.js";

const system = (text: string): ModelInputMessage => ({ role: "system", content: text });
const user = (text: string): ModelInputMessage => ({ role: "user", content: text });
const assistant = (text: string): ModelInputMessage => ({ role: "assistant", content: text });

describe("extractForwardableContext", () => {
  const messages: ModelInputMessage[] = [
    system(
      [
        "# Harness\nYou are ZCode agent. Use the following tools.",
        "# Global Memory\n用户偏好中文回答。",
        "# Environment\nworkspace=/tmp/proj",
        "# Communicating with the user\nUse Read tool first.",
      ].join("\n\n"),
    ),
    user("hello"),
  ];

  it("memory-only 只转发白名单段", () => {
    const result = extractForwardableContext(messages, "memory-only");
    expect(result).toContain("# Global Memory");
    expect(result).toContain("用户偏好中文回答");
    expect(result).toContain("# Environment");
    expect(result).not.toContain("ZCode agent");
    expect(result).not.toContain("Use Read tool");
  });

  it("none 返回空串", () => {
    expect(extractForwardableContext(messages, "none")).toBe("");
  });

  it("all-dynamic 原样转发全部 system 文本", () => {
    const result = extractForwardableContext(messages, "all-dynamic");
    expect(result).toContain("ZCode agent");
    expect(result).toContain("Global Memory");
  });

  it("忽略非 system 消息", () => {
    const result = extractForwardableContext(
      [user("# Global Memory\nfake")],
      "memory-only",
    );
    expect(result).toBe("");
  });
});

describe("flattenTranscriptForNewSession", () => {
  it("按角色序列化历史并跳过 system", () => {
    const transcript = flattenTranscriptForNewSession([
      system("# Global Memory\nnote"),
      user("任务 A"),
      assistant("已完成 A"),
    ]);
    expect(transcript).toContain("user: 任务 A");
    expect(transcript).toContain("assistant: 已完成 A");
    expect(transcript).not.toContain("Global Memory");
    expect(transcript).toContain("此前的对话记录");
  });

  it("tool 消息只保留状态行", () => {
    const hugeOutput = "x".repeat(50_000);
    const transcript = flattenTranscriptForNewSession([
      {
        role: "tool",
        toolName: "Read",
        toolCallId: "t1",
        content: hugeOutput,
      },
    ]);
    expect(transcript).toContain("tool Read");
    expect(transcript.length).toBeLessThan(1000);
  });

  it("includeSystem 时保留 system 消息（sidecar payload）", () => {
    const transcript = flattenTranscriptForNewSession(
      [system("你是摘要器"), user("转录内容")],
      { includeSystem: true },
    );
    expect(transcript).toContain("system: 你是摘要器");
    expect(transcript).toContain("user: 转录内容");
  });

  it("无可序列化内容时返回空串（防空 prompt）", () => {
    expect(flattenTranscriptForNewSession([system("仅系统")])).toBe("");
    expect(flattenTranscriptForNewSession([])).toBe("");
  });
});

describe("AcpTransport", () => {
  function fakeProcess() {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stdin,
      stderr,
      kill: vi.fn(),
      pid: 1,
    });
    return proc;
  }

  async function makeTransport(proc: ReturnType<typeof fakeProcess>) {
    const { spawn } = await import("node:child_process");
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc);
    return new AcpTransport({ command: "devin", args: ["acp"], cwd: "/tmp" });
  }

  it("request/response 按 id 配对", async () => {
    const proc = fakeProcess();
    const transport = await makeTransport(proc);
    const resultPromise = transport.request<{ ok: boolean }>("initialize", { v: 1 });
    const written = await new Promise<string>((resolve) =>
      proc.stdin.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    const frame = JSON.parse(written.trim());
    expect(frame.method).toBe("initialize");
    proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { ok: true } })}\n`);
    await expect(resultPromise).resolves.toEqual({ ok: true });
  });

  it("notification 分发给 handler，reverse request 走 onRequest", async () => {
    const proc = fakeProcess();
    const transport = await makeTransport(proc);
    const updates: string[] = [];
    transport.onNotification((method, params) => {
      if (method === "session/update") updates.push(JSON.stringify(params));
    });
    transport.onRequest((method) =>
      Promise.resolve(
        method === "session/request_permission"
          ? { result: { outcome: { outcome: "cancelled" } } }
          : { error: { code: -32601, message: "unsupported" } },
      ),
    );
    proc.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1" } })}\n`,
    );
    proc.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/request_permission", params: {} })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(updates).toHaveLength(1);
    const reply = await new Promise<string>((resolve) =>
      proc.stdin.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    const frame = JSON.parse(reply.trim());
    expect(frame.id).toBe(9);
    expect(frame.result.outcome.outcome).toBe("cancelled");
  });

  it("进程退出时挂起请求全部 reject", async () => {
    const proc = fakeProcess();
    const transport = await makeTransport(proc);
    const pending = transport.request("session/prompt", {});
    proc.emit("exit", 1);
    await expect(pending).rejects.toThrow(/exited/);
  });
});

describe("normalizeSessionUpdate tool/plan markers", () => {
  const toolUpdate = (extra: Record<string, unknown>) => ({
    sessionUpdate: "tool_call_update",
    ...extra,
  });

  it("丢弃无标题的纯状态心跳", () => {
    const state = createUpdateMarkerState();
    expect(
      normalizeSessionUpdate(
        toolUpdate({ toolCallId: "t1", status: "in_progress" }),
        state,
      ),
    ).toBeUndefined();
    expect(
      normalizeSessionUpdate({ sessionUpdate: "tool_call", status: "pending" }, state),
    ).toBeUndefined();
  });

  it("同一 toolCallId+title 只发第一条，in_progress 状态不展示", () => {
    const state = createUpdateMarkerState();
    const first = normalizeSessionUpdate(
      toolUpdate({ toolCallId: "t1", title: "Ran ls, echo, grep", status: "in_progress" }),
      state,
    );
    expect(first).toEqual({ kind: "tool", title: "Ran ls, echo, grep" });
    // 同 id 同标题的 completed 更新去重 → 每个工具最终一行。
    expect(
      normalizeSessionUpdate(
        toolUpdate({ toolCallId: "t1", title: "Ran ls, echo, grep", status: "completed" }),
        state,
      ),
    ).toBeUndefined();
    // 同 id 新标题（工具换动作）仍发。
    expect(
      normalizeSessionUpdate(
        toolUpdate({ toolCallId: "t1", title: "Ran pytest", status: "completed" }),
        state,
      ),
    ).toEqual({ kind: "tool", title: "Ran pytest", status: "completed" });
  });

  it("plan 内容不变去重，变化才发", () => {
    const state = createUpdateMarkerState();
    const entries = [{ content: "step1", status: "pending" }];
    const first = normalizeSessionUpdate(
      { sessionUpdate: "plan", entries },
      state,
    );
    expect(first?.kind).toBe("plan");
    expect(
      normalizeSessionUpdate({ sessionUpdate: "plan", entries }, state),
    ).toBeUndefined();
    expect(
      normalizeSessionUpdate(
        { sessionUpdate: "plan", entries: [{ content: "step2", status: "pending" }] },
        state,
      )?.kind,
    ).toBe("plan");
  });
});

describe("DevinModelExecutor context usage", () => {
  const request = (text: string) =>
    ({
      messages: [user(text)],
      options: {},
    }) as unknown as Parameters<DevinModelExecutor["streamText"]>[0];

  it("usage_update llega a finish.usage como contextTokens/contextWindow", async () => {
    vi.spyOn(DevinAcpBridge.prototype, "ensureSession").mockResolvedValue({
      acpSessionId: "s1",
      isNew: false,
    });
    vi.spyOn(DevinAcpBridge.prototype, "runPrompt").mockImplementation(
      async (input: { onUpdate: (u: unknown) => void }) => {
        input.onUpdate({ kind: "usage", used: 186_000, size: 262_144 });
        input.onUpdate({ kind: "text", text: "hecho" });
        input.onUpdate({ kind: "usage", used: 190_000, size: 262_144 });
        return { stopReason: "end_turn" };
      },
    );

    const executor = new DevinModelExecutor({ promptTimeoutMs: 1000, cwd: "/tmp" });
    const events = [];
    for await (const event of executor.streamText(request("hola"))) {
      events.push(event);
    }
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.usage).toEqual({ contextTokens: 190_000, contextWindow: 262_144 });
    // La última usage_update gana: es "ocupación actual", no acumulable.
    const texts = events.filter((e) => e.type === "text_delta").map((e) => e.text);
    expect(texts).toContain("hecho");
  });

  it("同配置的两个 executor 共享同一 bridge 实例", async () => {
    const ensure = vi
      .spyOn(DevinAcpBridge.prototype, "ensureSession")
      .mockResolvedValue({ acpSessionId: "s1", isNew: false });
    const run = vi
      .spyOn(DevinAcpBridge.prototype, "runPrompt")
      .mockImplementation(async () => ({ stopReason: "end_turn" }));
    const opts = { promptTimeoutMs: 1000, cwd: "/tmp" };
    const e1 = new DevinModelExecutor(opts);
    const e2 = new DevinModelExecutor(opts);
    for await (const _ of e1.streamText(request("a"))) void _;
    for await (const _ of e2.streamText(request("b"))) void _;
    // 池化证据：两次调用的 ensureSession/runPrompt 都落在同一 this 上。
    const contexts = new Set([...ensure.mock.contexts, ...run.mock.contexts]);
    expect(contexts.size).toBe(1);
  });

  it("交叉的 thought/text 各开独立块，块序=到达序", async () => {
    vi.spyOn(DevinAcpBridge.prototype, "ensureSession").mockResolvedValue({
      acpSessionId: "s1",
      isNew: false,
    });
    vi.spyOn(DevinAcpBridge.prototype, "runPrompt").mockImplementation(
      async (input: { onUpdate: (u: unknown) => void }) => {
        input.onUpdate({ kind: "text", text: "A1" });
        input.onUpdate({ kind: "thought", text: "T1" });
        input.onUpdate({ kind: "tool", title: "Ran ls" });
        input.onUpdate({ kind: "text", text: "A2" });
        return { stopReason: "end_turn" };
      },
    );
    const executor = new DevinModelExecutor({ promptTimeoutMs: 1000, cwd: "/tmp" });
    const types: string[] = [];
    for await (const event of executor.streamText(request("hola"))) {
      types.push(`${event.type}${"id" in event ? `:${event.id}` : ""}`);
    }
    // text(A1) → thought(T1) → text(marker+A2)：三个块依次开闭，不共用一个 id。
    const blockEvents = types.filter((t) => !t.startsWith("start") && !t.startsWith("finish"));
    const textIds = blockEvents
      .filter((t) => t.startsWith("text"))
      .map((t) => t.split(":")[1]);
    const reasoningIds = blockEvents
      .filter((t) => t.startsWith("reasoning"))
      .map((t) => t.split(":")[1]);
    expect(new Set(textIds).size).toBe(2); // A1 块 + 标记/A2 块
    expect(new Set(reasoningIds).size).toBe(1);
    // 事件顺序：text_start → delta(A1) → text_end → reasoning_* → text_start → deltas → text_end
    const seq = types.map((t) => t.split(":")[0]);
    const i1 = seq.indexOf("reasoning_start");
    const i2 = seq.lastIndexOf("text_start");
    expect(i2).toBeGreaterThan(seq.indexOf("reasoning_end"));
    expect(i1).toBeGreaterThan(seq.indexOf("text_delta"));
  });

  it("sidecar（compact）调用走独立 session 且发送完整输入", async () => {
    const ensure = vi
      .spyOn(DevinAcpBridge.prototype, "ensureSession")
      .mockResolvedValue({ acpSessionId: "s-side", isNew: true });
    let sentParts: { type: string; text?: string }[] = [];
    vi.spyOn(DevinAcpBridge.prototype, "runPrompt").mockImplementation(
      async (input: { parts: { type: string; text?: string }[] }) => {
        sentParts = input.parts;
        return { stopReason: "end_turn" };
      },
    );
    const executor = new DevinModelExecutor({ promptTimeoutMs: 1000, cwd: "/tmp" });
    const compactMessages = [
      user("做 A 任务"),
      assistant("已完成一半"),
      user("请总结以上对话"),
    ];
    await runWithModelInvocationContext(
      {
        modelCall: { operation: "context_compaction" },
        traceContext: { sessionId: "s-main" } as never,
      },
      async () => {
        for await (const _ of executor.streamText({
          messages: compactMessages,
          options: {},
        } as never)) {
          void _;
        }
      },
    );
    // sidecar session key 与主 session 分离且每次调用唯一（含随机后缀）。
    // spyOn 复用已有 mock，calls 含前面测试的调用——要在全部调用里找匹配。
    const keys = ensure.mock.calls.map((call) => call[0] as string);
    expect(
      keys.some((key) => /^s-main#context_compaction#.+/.test(key)),
    ).toBe(true);
    // 完整输入全部发送：转录 + 摘要指令都在（不是只发最后一条）。
    const sentText = sentParts.map((p) => p.text ?? "").join("\n");
    expect(sentText).toContain("做 A 任务");
    expect(sentText).toContain("请总结以上对话");
  });

  it("sin usage_update finish.usage queda vacío (meter oculto, nada fabricado)", async () => {
    vi.spyOn(DevinAcpBridge.prototype, "ensureSession").mockResolvedValue({
      acpSessionId: "s1",
      isNew: false,
    });
    vi.spyOn(DevinAcpBridge.prototype, "runPrompt").mockImplementation(
      async (input: { onUpdate: (u: unknown) => void }) => {
        input.onUpdate({ kind: "text", text: "ok" });
        return { stopReason: "end_turn" };
      },
    );
    const executor = new DevinModelExecutor({ promptTimeoutMs: 1000, cwd: "/tmp" });
    const events = [];
    for await (const event of executor.streamText(request("hola"))) {
      events.push(event);
    }
    const finish = events.find((e) => e.type === "finish");
    expect(finish?.usage).toEqual({});
  });
});
