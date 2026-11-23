import { createHash } from "node:crypto";
import type {
  FilePart,
  MessagePart,
  MessageWithParts,
  SessionEntryInfo,
  SessionId,
  SessionInfo,
  SessionStorePort,
  TodoItem,
  ToolArtifactStorePort,
} from "@zcode/contracts";
import {
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  SESSION_ENTRY_MODEL_SELECTION,
  createSessionId,
} from "@zcode/contracts";
import { isTaskListSessionType } from "../zcode-protocol-v4/task-list-session-membership.js";

export const SESSION_TRANSFER_ARTIFACT_URI_PREFIX = "zcode-artifact://";

/** v1 只迁移不依赖机器本地运行态、且模型恢复需要的 entry。 */
export const SESSION_TRANSFER_PORTABLE_ENTRY_TYPES: ReadonlySet<string> = new Set([
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
]);

export interface SessionTransferSnapshot {
  session: SessionInfo;
  messages: MessageWithParts[];
  entries: SessionEntryInfo[];
  todos: TodoItem[];
  /** 消息/part 中出现的 zcode-artifact URI，去重后按首次出现顺序排列。 */
  artifactUris: string[];
  droppedEntryCount: number;
}

export interface SessionTransferArtifact {
  sourceUri: string;
  artifactId: string;
  mime: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface SessionTransferSource {
  deviceId: string;
  deviceName: string;
  appVersion: string;
  exportedAt: number;
  workspacePath: string;
  gitHead: string | null;
  gitDirty: boolean | null;
  platform: string;
}

export interface SessionTransferTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ImportSessionTransferInput {
  snapshot: SessionTransferSnapshot;
  artifacts: SessionTransferArtifact[];
  source: SessionTransferSource;
  target: SessionTransferTarget;
  sessionStore: SessionStorePort;
  artifactStore?: ToolArtifactStorePort;
  now?: number;
}

export interface ImportSessionTransferResult {
  sessionId: SessionId;
  reused: boolean;
  importedMessages: number;
  importedParts: number;
  importedArtifacts: number;
  skippedAttachments: number;
  warnings: string[];
}

export async function readSessionTransferSnapshot(params: {
  sessionID: SessionId;
  sessionStore: Pick<SessionStorePort, "getSession" | "messages" | "readTodos" | "sessionEntries">;
}): Promise<SessionTransferSnapshot> {
  const session = await params.sessionStore.getSession(params.sessionID);
  if (!session) {
    throw new Error(`Session not found: ${params.sessionID}`);
  }
  if (session.workspaceID?.startsWith("remote:")) {
    throw new Error("Remote workspace sessions cannot be shared");
  }
  // 上游移除 time.archived（归档归 Host 组织态，CLI 无归档列）；改为拒绝软删除会话。
  if (session.time.deleted !== undefined) {
    throw new Error("Deleted session cannot be shared");
  }
  if (session.revert) {
    throw new Error("Session with active revert cannot be shared");
  }
  if (session.time.compacting !== undefined) {
    throw new Error("Compacting session cannot be shared");
  }
  if (!isTaskListSessionType(session.taskType)) {
    throw new Error("Only task-list sessions can be shared");
  }

  const messages = await params.sessionStore.messages({ sessionID: params.sessionID });
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === "tool" &&
        (part.state.status === "pending" || part.state.status === "running")
      ) {
        throw new Error("Session with a running tool call cannot be shared");
      }
    }
  }

  const entries = params.sessionStore.sessionEntries
    ? await params.sessionStore.sessionEntries({ sessionID: params.sessionID })
    : [];
  const portableEntries = entries.filter((entry) =>
    SESSION_TRANSFER_PORTABLE_ENTRY_TYPES.has(entry.type),
  );
  const todos = await params.sessionStore.readTodos({ sessionID: params.sessionID });

  return {
    session,
    messages,
    entries: portableEntries,
    todos,
    artifactUris: collectSessionTransferArtifactUris(messages),
    droppedEntryCount: entries.length - portableEntries.length,
  };
}

export async function readSessionTransferArtifact(
  uri: string,
  artifactStore: ToolArtifactStorePort,
): Promise<SessionTransferArtifact> {
  const parsed = parseSessionTransferArtifactUri(uri);
  if (!parsed) {
    throw new Error(`Invalid session transfer artifact URI: ${uri}`);
  }
  if (!artifactStore.readToolResultBinaryArtifact) {
    throw new Error("Artifact store does not support binary reads");
  }
  const result = await artifactStore.readToolResultBinaryArtifact({ uri });
  return {
    sourceUri: uri,
    artifactId: parsed.artifactId,
    mime: result.contentType,
    sha256: createHash("sha256").update(result.bytes).digest("hex"),
    bytes: result.bytes,
  };
}

export function parseSessionTransferArtifactUri(
  uri: string,
): { sessionId: string; artifactId: string } | null {
  if (!uri.startsWith(SESSION_TRANSFER_ARTIFACT_URI_PREFIX)) return null;
  const rest = uri.slice(SESSION_TRANSFER_ARTIFACT_URI_PREFIX.length);
  const separator = rest.indexOf("/");
  if (separator <= 0 || separator === rest.length - 1) return null;
  try {
    return {
      sessionId: decodeURIComponent(rest.slice(0, separator)),
      artifactId: decodeURIComponent(rest.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

export function collectSessionTransferArtifactUris(messages: MessageWithParts[]): string[] {
  const uris = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file") {
        const uri = filePartArtifactUri(part);
        if (uri) uris.add(uri);
      }
      if (part.type === "tool" && part.state.status === "completed") {
        for (const attachment of part.state.attachments ?? []) {
          const uri = filePartArtifactUri(attachment);
          if (uri) uris.add(uri);
        }
      }
    }
  }
  return [...uris];
}

export function countLocalReferenceFileParts(messages: MessageWithParts[]): number {
  let count = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file" && part.metadata?.storageKind === "local_ref") {
        count += 1;
      }
    }
  }
  return count;
}

export function buildImportedSessionId(
  sourceDeviceId: string,
  sourceSessionId: string,
): { sessionId: SessionId; seed: string } {
  const seed = createHash("sha256")
    .update(`${sourceDeviceId}\u0000${sourceSessionId}`)
    .digest("hex")
    .slice(0, 24);
  return { sessionId: createSessionId(`import_${seed}`), seed };
}

export function retargetSessionTransferMessage(params: {
  message: MessageWithParts;
  sessionID: SessionId;
  workspacePath: string;
  artifactUris: ReadonlyMap<string, string>;
}): MessageWithParts {
  const message = structuredClone(params.message);
  message.info.sessionID = params.sessionID;
  if (message.info.role === "assistant") {
    message.info.path = { cwd: params.workspacePath, root: params.workspacePath };
  } else {
    // 旧机器的 platform/shell/git 快照必须丢弃，让目标端首次 resume 重新探测。
    message.info.contextSnapshot = undefined;
  }
  if (message.info.anchor?.goalBoundary) {
    delete message.info.anchor.goalBoundary;
  }
  message.parts = message.parts.map((part) =>
    retargetSessionTransferPart(part, params.sessionID, params.artifactUris),
  );
  return message;
}

function retargetSessionTransferPart(
  part: MessagePart,
  sessionID: SessionId,
  artifactUris: ReadonlyMap<string, string>,
): MessagePart {
  if (part.type === "file") {
    return retargetFilePart(part, sessionID, artifactUris);
  }
  if (part.type === "tool") {
    if (part.state.status !== "completed") {
      return { ...part, sessionID };
    }
    const attachments = part.state.attachments?.map((attachment) =>
      retargetFilePart(attachment, sessionID, artifactUris),
    );
    return {
      ...part,
      sessionID,
      state: {
        ...part.state,
        ...(attachments ? { attachments } : {}),
      },
    };
  }
  return { ...part, sessionID };
}

function retargetFilePart(
  part: FilePart,
  sessionID: SessionId,
  artifactUris: ReadonlyMap<string, string>,
): FilePart {
  const metadata = part.metadata
    ? {
        ...part.metadata,
        ...(part.metadata.artifactUri
          ? {
              artifactUri: rewriteArtifactUri(
                part.metadata.artifactUri,
                artifactUris,
                "artifactUri",
              ),
            }
          : {}),
        ...(part.metadata.originalUrl
          ? {
              originalUrl: rewriteArtifactUri(
                part.metadata.originalUrl,
                artifactUris,
                "originalUrl",
              ),
            }
          : {}),
      }
    : undefined;
  return {
    ...part,
    sessionID,
    url: rewriteArtifactUri(part.url, artifactUris, "url") ?? part.url,
    ...(metadata ? { metadata } : {}),
  };
}

function rewriteArtifactUri(
  uri: string | undefined,
  artifactUris: ReadonlyMap<string, string>,
  field: string,
): string | undefined {
  if (!uri?.startsWith(SESSION_TRANSFER_ARTIFACT_URI_PREFIX)) return uri;
  const rewritten = artifactUris.get(uri);
  if (!rewritten) {
    throw new Error(`Session transfer ${field} references a missing artifact: ${uri}`);
  }
  return rewritten;
}

function filePartArtifactUri(part: FilePart): string | undefined {
  for (const candidate of [part.metadata?.artifactUri, part.url, part.metadata?.originalUrl]) {
    if (candidate?.startsWith(SESSION_TRANSFER_ARTIFACT_URI_PREFIX)) return candidate;
  }
  return undefined;
}
