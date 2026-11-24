import { join } from "node:path";
import type { FileSystemPort } from "@zcode/contracts";
import {
  createGlobalMemoryCipher,
  isEncryptedMemoryFileText,
  type GlobalMemoryCipher,
} from "./global-memory-cipher.js";

/** 全局（跨工作区）记忆单文件的字符上限（按 UTF-16 code unit，中文每字计 1）。 */
export const GLOBAL_MEMORY_CHARACTER_LIMIT = 20480;

/** 全局记忆 id：保留给存量 MEMORY.md 的永久映射。 */
export const GLOBAL_MEMORY_DEFAULT_ID = "default";

/** 单轮最多注入的全局记忆条数。 */
export const GLOBAL_MEMORY_SELECTION_LIMIT = 4;

/**
 * 全局记忆 slug/id 校验：小写字母数字连字符，1–40 字符，首字符不允许连字符。
 * id 会参与文件路径拼接，wire/文件名侧入口必须先过此校验（防目录穿越）。
 */
export const GLOBAL_MEMORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const GLOBAL_MEMORY_FILE_NAME = "MEMORY.md";
const GLOBAL_MEMORY_DIRECTORY_NAME = "global";

/** 一条已解析、可注入的全局记忆。 */
export interface GlobalMemoryEntryInjection {
  id: string;
  filePath: string;
  /** 已经过 formatGlobalMemoryContent 截断/格式化；空 body 为 ""。 */
  content: string;
}

/** 全局（跨工作区）记忆目录：{cliStorageRoot}/memories/global */
export function resolveGlobalMemoryDir(cliStorageRoot: string): string {
  return join(cliStorageRoot, "memories", GLOBAL_MEMORY_DIRECTORY_NAME);
}

/** 全局（跨工作区）记忆单文件：{cliStorageRoot}/memories/global/MEMORY.md */
export function resolveGlobalMemoryFile(cliStorageRoot: string): string {
  return join(resolveGlobalMemoryDir(cliStorageRoot), GLOBAL_MEMORY_FILE_NAME);
}

/**
 * 记忆 id → 文件路径：`default` 永久映射 MEMORY.md，其余 slug 映射 `<slug>.md`。
 * 未通过 slug 校验的 id 返回 undefined——调用方据此静默跳过，绝不参与路径拼接。
 */
export function resolveGlobalMemoryEntryPath(
  dir: string,
  id: string,
): string | undefined {
  if (id === GLOBAL_MEMORY_DEFAULT_ID) return join(dir, GLOBAL_MEMORY_FILE_NAME);
  if (!GLOBAL_MEMORY_ID_PATTERN.test(id)) return undefined;
  return join(dir, `${id}.md`);
}

/**
 * 全局记忆内容格式化：trim 后按 20480 字符截断；超限在最后一个换行处裁剪并追加一行提示。
 * 空内容返回空串（调用方据此决定是否展示"empty"占位）。
 */
export function formatGlobalMemoryContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= GLOBAL_MEMORY_CHARACTER_LIMIT) return trimmed;

  const sliced = trimmed.slice(0, GLOBAL_MEMORY_CHARACTER_LIMIT);
  const lastNewline = sliced.lastIndexOf("\n");
  const cut = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
  return (
    `${cut}\n\n` +
    `> [Global memory truncated: ${trimmed.length} chars, limit ${GLOBAL_MEMORY_CHARACTER_LIMIT}. ` +
    `Trim it under Settings → Memory → Global.]`
  );
}

/**
 * 规范化记忆选择：去重保序 + slug 校验。wire 侧不可信，非法 id 一律静默丢弃。
 * 返回 undefined 表示未提供选择（由调用方走 includeGlobalMemory 兼容分支）；
 * 返回空数组表示显式空选择（本轮不注入）。
 */
export function normalizeGlobalMemoryIds(
  ids: readonly string[] | undefined,
): readonly string[] | undefined {
  if (ids === undefined) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    if (id !== GLOBAL_MEMORY_DEFAULT_ID && !GLOBAL_MEMORY_ID_PATTERN.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
    if (normalized.length >= GLOBAL_MEMORY_SELECTION_LIMIT) break;
  }
  return normalized;
}

/**
 * 按选择顺序逐条读取全局记忆；ENOENT/IO/解密失败静默跳过（与项目记忆 index 一致）。
 * 返回空数组表示本轮无可注入条目。
 * 文件静态加密（enc:v1 AES-256-GCM，见 global-memory-cipher.ts）：密文解密后注入；
 * 明文文件（存量/agent 直写）读到后 best-effort 就地加密，收敛目录为全密文。
 */
export async function readGlobalMemoryEntries(
  dir: string,
  ids: readonly string[],
  fileSystemPort: FileSystemPort | undefined,
  cipher?: GlobalMemoryCipher,
): Promise<GlobalMemoryEntryInjection[]> {
  if (!fileSystemPort || ids.length === 0) return [];
  const codec = cipher ?? createGlobalMemoryCipher();
  const entries: GlobalMemoryEntryInjection[] = [];
  for (const id of ids) {
    const filePath = resolveGlobalMemoryEntryPath(dir, id);
    if (!filePath) continue;
    try {
      const read = await fileSystemPort.readTextFile({ path: filePath });
      const plainText = codec.decrypt(read.content);
      entries.push({ id, filePath, content: formatGlobalMemoryContent(plainText) });
      if (!isEncryptedMemoryFileText(read.content)) {
        try {
          // 明文就地加密：roundtrip 验证密文可解再替换；写失败不阻断本轮注入。
          const cipherText = codec.encrypt(plainText);
          if (codec.decrypt(cipherText) === plainText) {
            await fileSystemPort.writeTextFile({ path: filePath, content: cipherText, atomic: true });
          }
        } catch {
          // 迁移失败保留明文文件，下轮再试；绝不因写盘失败吞掉已读出的注入内容。
        }
      }
    } catch {
      // 缺失/不可读/坏密文的记忆静默跳过：发送后被删、密钥不匹配都不应阻断 turn。
    }
  }
  return entries;
}
