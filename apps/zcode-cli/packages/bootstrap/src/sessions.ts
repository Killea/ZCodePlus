import { createConfig, resolvePath } from "@zcode/adapters/config";
import { createNodeToolArtifactStore, openStartupSqliteSessionStore } from "@zcode/adapters/storage";
import type { SessionInfo } from "@zcode/contracts";
import { join } from "node:path";
import type { ListZCodeSessionsOptions, ResolveLatestSessionOptions } from "./app/types.js";
import { getSessionDbPath, isClosableSessionStore } from "./app/session-store.js";

export interface SessionTransferStores {
  sessionStore: ReturnType<typeof openStartupSqliteSessionStore>;
  artifactStore: ReturnType<typeof createNodeToolArtifactStore>;
  close(): void;
}

/**
 * 内部 session 共享命令的存储入口：与普通 CLI 使用同一 session DB / artifact root，
 * 但只由 __session-share 命令进程持有，不进入 Desktop main 的常驻状态。
 */
export function openSessionTransferStores(options?: {
  env?: NodeJS.ProcessEnv;
  workingDirectory?: string;
}): SessionTransferStores {
  const configResult = createConfig({ env: options?.env });
  const sessionStore = openStartupSqliteSessionStore({
    dbPath: getSessionDbPath(configResult, options?.workingDirectory),
  });
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const artifactStore = createNodeToolArtifactStore({
    imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
    pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
    rootDir: join(storageRoot, "cli", "artifacts"),
    videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
  });
  return {
    sessionStore,
    artifactStore,
    close: () => {
      if (isClosableSessionStore(sessionStore)) sessionStore.close();
    },
  };
}

export async function resolveLatestSession(
  options: ResolveLatestSessionOptions,
): Promise<SessionInfo | null> {
  const ownsStore = options.sessionStore === undefined;
  let sessionStore = options.sessionStore;
  if (!sessionStore) {
    const configResult = createConfig({ env: options.env });
    sessionStore = await openStartupSqliteSessionStore({ dbPath: getSessionDbPath(configResult) });
  }

  try {
    const sessions = await sessionStore.listSessions({
      directory: options.directory,
      limit: 1,
      roots: true,
    });
    return sessions[0] ?? null;
  } finally {
    if (ownsStore && isClosableSessionStore(sessionStore)) {
      sessionStore.close();
    }
  }
}

export async function listZCodeSessions(
  options: ListZCodeSessionsOptions = {},
): Promise<SessionInfo[]> {
  const ownsStore = options.sessionStore === undefined;
  let sessionStore = options.sessionStore;
  if (!sessionStore) {
    const configResult = createConfig({ env: options.env });
    sessionStore = await openStartupSqliteSessionStore({ dbPath: getSessionDbPath(configResult) });
  }

  try {
    return await sessionStore.listSessions({
      directory: options.directory,
      limit: options.limit ?? 50,
      roots: true,
    });
  } finally {
    if (ownsStore && isClosableSessionStore(sessionStore)) {
      sessionStore.close();
    }
  }
}
