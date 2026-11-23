import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MessageWithParts,
  SessionEntryInfo,
  SessionInfo,
  TodoItem,
} from "@zcode/contracts";
import type { SessionSharingSessionSummary } from "@zcode/shared";
import type { RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";

interface SessionShareBundle {
  schemaVersion: 1;
  exportedAt: number;
  source: {
    deviceId: string;
    deviceName: string;
    appVersion: string;
    exportedAt: number;
    workspacePath: string;
    gitHead: string | null;
    gitDirty: boolean | null;
    platform: string;
  };
  snapshot: {
    session: SessionInfo;
    messages: MessageWithParts[];
    entries: SessionEntryInfo[];
    todos: TodoItem[];
    artifactUris: string[];
    droppedEntryCount: number;
  };
  artifacts: Array<{
    artifactId: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    file: string;
  }>;
}

export async function runSessionShareCommand(
  ctx: RunContext,
  argv: string[],
  version: string,
  workingDirectory: string,
): Promise<number> {
  try {
    const bootstrap = await loadBootstrapModule();
    const stores = await bootstrap.openSessionTransferStores({
      env: process.env,
      workingDirectory,
    });
    try {
      const mode = argv[0];
      if (mode === "list") {
        const limit = readNumberFlag(argv, "limit") ?? 50;
        const sessions = await stores.sessionStore.listSessions({ limit });
        const summaries: SessionSharingSessionSummary[] = [];
        for (const session of sessions) {
          if (!bootstrap.isTaskListSessionType(session.taskType)) continue;
          if (session.workspaceID?.startsWith("remote:")) continue;
          const messages = await stores.sessionStore.messages({ sessionID: session.id });
          const running = messages.some(
            (message) =>
              (message.info.role === "assistant" &&
                message.info.time.completed === undefined) ||
              message.parts.some(
                (part) =>
                  part.type === "tool" &&
                  (part.state.status === "pending" || part.state.status === "running"),
              ),
          );
          summaries.push({
            id: session.id,
            title: session.title,
            workspacePath: session.path ?? session.directory,
            createdAt: session.time.created,
            updatedAt: session.time.updated,
            messageCount: messages.length,
            partCount: messages.reduce((count, message) => count + message.parts.length, 0),
            status: running ? "running" : "idle",
            sizeBytes: 0,
            artifactCount: bootstrap.collectSessionTransferArtifactUris(messages).length,
            taskType: session.taskType,
            parentID: session.parentID ?? null,
          });
        }
        writeJson(ctx, { schemaVersion: 1, sessions: summaries, nextCursor: null });
        return 0;
      }

      if (mode === "export") {
        const sessionId = argv[1];
        const outDir = readFlag(argv, "out");
        if (!sessionId || !outDir) {
          throw new Error("__session-share export requires <sessionId> --out <dir>");
        }
        const snapshot = await bootstrap.readSessionTransferSnapshot({
          sessionID: sessionId as SessionInfo["id"],
          sessionStore: stores.sessionStore,
        });
        await mkdir(join(outDir, "artifacts"), { recursive: true });
        const artifacts: SessionShareBundle["artifacts"] = [];
        let artifactBytes = 0;
        for (const uri of snapshot.artifactUris) {
          const artifact = await bootstrap.readSessionTransferArtifact(
            uri,
            stores.artifactStore,
          );
          const fileName = `${artifact.artifactId}.bin`;
          await writeFile(join(outDir, "artifacts", fileName), artifact.bytes);
          artifactBytes += artifact.bytes.byteLength;
          artifacts.push({
            artifactId: artifact.artifactId,
            mime: artifact.mime,
            sizeBytes: artifact.bytes.byteLength,
            sha256: artifact.sha256,
            file: `artifacts/${fileName}`,
          });
        }
        const exportedAt = Date.now();
        const bundle: SessionShareBundle = {
          schemaVersion: 1,
          exportedAt,
          source: {
            deviceId: readFlag(argv, "source-device-id") ?? "unknown-device",
            deviceName: readFlag(argv, "source-device-name") ?? "ZCode",
            appVersion: readFlag(argv, "source-app-version") ?? version,
            exportedAt,
            workspacePath: readFlag(argv, "source-workspace-path") ?? snapshot.session.directory,
            gitHead: readFlag(argv, "source-git-head") ?? null,
            gitDirty: readBooleanFlag(argv, "source-git-dirty"),
            platform: readFlag(argv, "source-platform") ?? process.platform,
          },
          snapshot: {
            session: snapshot.session,
            messages: snapshot.messages,
            entries: snapshot.entries,
            todos: snapshot.todos,
            artifactUris: snapshot.artifactUris,
            droppedEntryCount: snapshot.droppedEntryCount,
          },
          artifacts,
        };
        const bundlePath = join(outDir, "bundle.json");
        const serialized = JSON.stringify(bundle, null, 2);
        await writeFile(bundlePath, serialized, "utf8");
        writeJson(ctx, {
          ok: true,
          bundlePath,
          sessionId: snapshot.session.id,
          title: snapshot.session.title,
          messageCount: snapshot.messages.length,
          partCount: snapshot.messages.reduce((count, message) => count + message.parts.length, 0),
          artifactCount: artifacts.length,
          sizeBytes: Buffer.byteLength(serialized, "utf8") + artifactBytes,
        });
        return 0;
      }

      if (mode === "import") {
        const bundleDir = argv[1];
        const workspacePath = readFlag(argv, "workspace");
        if (!bundleDir || !workspacePath) {
          throw new Error("__session-share import requires <bundleDir> --workspace <path>");
        }
        const bundle = JSON.parse(
          await readFile(join(bundleDir, "bundle.json"), "utf8"),
        ) as SessionShareBundle;
        if (bundle.schemaVersion !== 1) {
          throw new Error(`Unsupported session share bundle version: ${bundle.schemaVersion}`);
        }
        const artifacts = [];
        for (const descriptor of bundle.artifacts) {
          const bytes = new Uint8Array(await readFile(join(bundleDir, descriptor.file)));
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          if (descriptor.sha256 !== sha256) {
            throw new Error(`Session share artifact checksum mismatch: ${descriptor.artifactId}`);
          }
          artifacts.push({
            sourceUri: `zcode-artifact://${bundle.snapshot.session.id}/${descriptor.artifactId}`,
            artifactId: descriptor.artifactId,
            mime: descriptor.mime,
            sha256,
            bytes,
          });
        }
        const result = await bootstrap.importSessionTransferSnapshot({
          snapshot: bundle.snapshot,
          artifacts,
          source: bundle.source,
          target: {
            workspacePath,
            ...(readFlag(argv, "identity")
              ? { workspaceIdentity: readFlag(argv, "identity") }
              : {}),
          },
          sessionStore: stores.sessionStore,
          artifactStore: stores.artifactStore,
        });
        writeJson(ctx, { ok: true, ...result });
        return 0;
      }

      throw new Error(`Unknown __session-share mode: ${mode ?? "<none>"}`);
    } finally {
      stores.close();
    }
  } catch (error) {
    writeJson(ctx, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, true);
    return 1;
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readNumberFlag(argv: string[], name: string): number | undefined {
  const value = readFlag(argv, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function readBooleanFlag(argv: string[], name: string): boolean | null {
  const value = readFlag(argv, name);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function writeJson(ctx: RunContext, value: unknown, stderr = false): void {
  const stream = stderr ? ctx.stderr : ctx.stdout;
  stream.write(`${JSON.stringify(value)}\n`);
}
