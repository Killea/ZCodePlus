import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "@zcode/contracts";

export interface AcpTransportOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
}

export interface AcpRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

type NotificationHandler = (method: string, params: unknown) => void;
type RequestHandler = (
  method: string,
  params: unknown,
) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const JSONRPC_VERSION = "2.0";
const METHOD_NOT_FOUND = -32601;
const PARSE_ERROR_LOG_LIMIT = 200;

/**
 * ACP 的 NDJSON/JSON-RPC stdio 传输层。
 * 单一职责：帧编解码、request/response 配对、notification/反向 request 分发。
 * 不感知任何 ACP 方法语义（initialize/session/prompt 在 bridge 层）。
 */
export class AcpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logger?: Logger;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private requestHandler?: RequestHandler;
  private readonly exitListeners = new Set<(code: number | null) => void>();
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private exitCode: number | null = null;
  private exitError?: Error;

  constructor(options: AcpTransportOptions) {
    this.logger = options.logger;
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      // Windows .cmd/.bat 需经 cmd.exe，shell:false 在新版 Node 直接 EINVAL。
      shell:
        process.platform === "win32" && /\.(cmd|bat)$/i.test(options.command),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // devin 关闭管道但进程未退出时，再写 stdin 会触发 stream 'error'(EPIPE)。
    // 没有监听器的 'error' 事件会让整个 agent 进程崩溃——吞掉并记 debug，
    // 真正的生命周期处理交给 exit/error 路径。
    this.child.stdin.on("error", (error: Error) => {
      this.logger?.debug?.(`[devin-acp stdin] ${error.message}`);
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      // Devin CLI 的 stderr 是诊断输出（含本地 DB migration 告警等），只进 debug。
      if (text) this.logger?.debug?.(`[devin-acp stderr] ${text}`);
    });
    this.child.on("error", (error) => this.onExit(null, error));
    this.child.on("exit", (code) => this.onExit(code));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isRunning(): boolean {
    return !this.closed && this.exitCode === null && !this.exitError;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onExitOnce(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  request<T>(method: string, params: unknown, options?: AcpRequestOptions): Promise<T> {
    if (!this.isRunning) {
      return Promise.reject(this.exitError ?? new Error("Devin ACP process is not running"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let signalCleanup: (() => void) | undefined;
      const finalize = () => {
        if (timer) clearTimeout(timer);
        signalCleanup?.();
        this.pending.delete(id);
      };
      const rejectOnce = (reason: unknown) => {
        finalize();
        reject(reason);
      };
      const pendingEntry: PendingRequest = {
        method,
        resolve: (value) => {
          finalize();
          resolve(value as T);
        },
        reject: rejectOnce,
      };
      this.pending.set(id, pendingEntry);
      if (options?.timeoutMs !== undefined) {
        timer = setTimeout(
          () => rejectOnce(new Error(`Devin ACP request timed out: ${method}`)),
          options.timeoutMs,
        );
      }
      if (options?.signal) {
        const onAbort = () =>
          rejectOnce(new Error(`Devin ACP request aborted: ${method}`));
        if (options.signal.aborted) return onAbort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        signalCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.write({ jsonrpc: JSONRPC_VERSION, id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.isRunning) return;
    this.write({ jsonrpc: JSONRPC_VERSION, method, params });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new Error("Devin ACP transport closed"));
    // 先 stdin.end + SIGTERM 给进程优雅退出机会，超时再 SIGKILL。
    this.child.stdin.end();
    try {
      this.child.kill("SIGTERM");
    } catch {
      // 已退出，忽略。
    }
    const exited = await new Promise<boolean>((resolve) => {
      if (this.exitCode !== null || this.exitError) return resolve(true);
      const timer = setTimeout(() => resolve(false), 2000);
      this.onExitOnce(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) this.child.kill("SIGKILL");
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (this.buffer.length > MAX_FRAME_BYTES) {
          this.logger?.error?.("[devin-acp] frame exceeds limit, killing process");
          this.child.kill("SIGKILL");
        }
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let message: {
      id?: number | string | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      this.logger?.warn?.(
        `[devin-acp] dropping malformed frame: ${line.slice(0, PARSE_ERROR_LOG_LIMIT)}`,
      );
      return;
    }
    if (message.method !== undefined) {
      if (message.id !== undefined && message.id !== null) {
        void this.respondToRequest(message.id, message.method, message.params);
      } else {
        for (const handler of this.notificationHandlers) {
          try {
            handler(message.method, message.params);
          } catch (error) {
            this.logger?.warn?.(`[devin-acp] notification handler failed: ${String(error)}`);
          }
        }
      }
      return;
    }
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const pendingEntry = this.pending.get(id);
    if (!pendingEntry) return;
    if (message.error) {
      pendingEntry.reject(
        new Error(`Devin ACP ${pendingEntry.method} failed (${message.error.code}): ${message.error.message}`),
      );
    } else {
      pendingEntry.resolve(message.result);
    }
  }

  private async respondToRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    let response: { result?: unknown; error?: { code: number; message: string } };
    try {
      response = this.requestHandler
        ? await this.requestHandler(method, params)
        : { error: { code: METHOD_NOT_FOUND, message: `method not supported: ${method}` } };
    } catch (error) {
      response = {
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      };
    }
    this.write({ jsonrpc: JSONRPC_VERSION, id, ...response });
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.logger?.warn?.(`[devin-acp] stdin write failed: ${String(error)}`);
    }
  }

  private onExit(code: number | null, error?: Error): void {
    if (this.exitCode !== null || this.exitError) return;
    this.exitCode = code;
    this.exitError = error;
    const reason =
      error ?? new Error(`Devin ACP process exited unexpectedly (code ${String(code)})`);
    this.failAllPending(reason);
    for (const listener of this.exitListeners) {
      try {
        listener(code);
      } catch {
        // 观察者异常不影响退出广播。
      }
    }
  }

  private failAllPending(reason: Error): void {
    for (const pendingEntry of this.pending.values()) pendingEntry.reject(reason);
  }
}
