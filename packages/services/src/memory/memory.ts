import type { Memory, MemoryConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";

/** 全局（跨工作区）记忆单文件的字符上限（按 UTF-16 code unit，中文每字计 1）。 */
export const GLOBAL_MEMORY_CHARACTER_LIMIT = 20480;
export const GLOBAL_MEMORY_CHARACTER_LIMIT_EXCEEDED_ERROR_CODE =
  "GLOBAL_MEMORY_CHARACTER_LIMIT_EXCEEDED";

/** 单轮最多注入的全局记忆条数（Composer picker 勾选上限）。 */
export const GLOBAL_MEMORY_SELECTION_LIMIT = 4;
/** 存量 MEMORY.md 的永久映射 id；保留字，不可创建。 */
export const GLOBAL_MEMORY_DEFAULT_ID = "default";
/** 记忆 id/slug：小写字母数字连字符，1–40 字符，首字符非连字符。 */
export const GLOBAL_MEMORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** frontmatter name 字段上限（单行）。 */
export const GLOBAL_MEMORY_NAME_CHARACTER_LIMIT = 80;
/** frontmatter description 字段上限（单行）。 */
export const GLOBAL_MEMORY_DESCRIPTION_CHARACTER_LIMIT = 200;

export const GLOBAL_MEMORY_ID_INVALID_ERROR_CODE = "GLOBAL_MEMORY_ID_INVALID";
export const GLOBAL_MEMORY_NOT_FOUND_ERROR_CODE = "GLOBAL_MEMORY_NOT_FOUND";
export const GLOBAL_MEMORY_NAME_INVALID_ERROR_CODE = "GLOBAL_MEMORY_NAME_INVALID";

/** 全局记忆列表条目（不含正文）。 */
export interface GlobalMemoryEntryMeta {
  /** "default"（映射 MEMORY.md）或 slug；对应文件名 `<id>.md`。 */
  id: string;
  /** frontmatter.name 或回退 id；default 的本地化显示名由 UI 提供。 */
  name: string;
  description?: string;
  /** body 字符数（frontmatter 不计入）。 */
  chars: number;
  updatedAt: number | null;
}

/** 全局记忆完整条目：content 为 frontmatter 之后的 body。 */
export interface GlobalMemoryEntry extends GlobalMemoryEntryMeta {
  content: string;
}

export interface ProjectMemoryFileSummary {
  name: string;
  /** 已由 MemoryService 校验并限制在本地 Project Memory 根目录内的实际路径。 */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
}

export interface IMemoryService {
  /**
   * 加载指定 agent 的 memory 文件
   * @param workspacePath workspace 路径
   * @param agentId agent ID (如 'claude', 'gemini' 等)
   */
  loadMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<{ memory: Memory | null }>;

  /**
   * 保存 memory 配置
   */
  saveMemory(params: {
    workspacePath: string;
    agentId: string;
    config: MemoryConfig;
  }): Promise<void>;

  /**
   * 清除 memory 内容
   */
  clearMemory(params: { workspacePath: string; agentId: string }): Promise<void>;

  /**
   * 获取用户级 memory 目录路径，并确保目录存在
   */
  getUserMemoryDirectory(): Promise<{ path: string }>;

  /** 列出当前本地 profile 中可查看的 Project Memory。 */
  listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]>;

  /** 原样读取一个 Project Memory Markdown 文件。 */
  readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }>;

  /** 读取全局（跨工作区）记忆单文件；文件不存在时返回 exists:false 与空内容。落盘为 enc:v1 密文，接口仍返回明文。 */
  readGlobalMemoryFile(): Promise<{ content: string; updatedAt: number | null; exists: boolean }>;

  /** 写入全局（跨工作区）记忆单文件（仅 MEMORY.md）；超过字符上限时抛错。内容整体加密落盘。 */
  writeGlobalMemoryFile(params: { content: string }): Promise<{ updatedAt: number }>;

  /** 列出全部全局记忆：default 固定首位，其余按 name localeCompare + id 兜底；目录缺失返回 []。 */
  listGlobalMemories(): Promise<GlobalMemoryEntryMeta[]>;

  /** 读取单条记忆；id 非法抛 GLOBAL_MEMORY_ID_INVALID；文件缺失返回 exists:false。 */
  readGlobalMemory(params: { id: string }): Promise<GlobalMemoryEntry & { exists: boolean }>;

  /**
   * 写回单条记忆。name/description 均缺省时按原始文件全文写（兼容
   * writeGlobalMemoryFile 语义）；提供任一字段时重组 canonical frontmatter，
   * 未识别的 frontmatter 键随写回规范化丢弃。
   */
  writeGlobalMemory(params: {
    id: string;
    content: string;
    name?: string;
    description?: string;
  }): Promise<{ updatedAt: number }>;

  /** 新建记忆：slug 由 name 派生，冲突自动追加 -2/-3…；无总条数上限。 */
  createGlobalMemory(params: {
    name: string;
    description?: string;
    content?: string;
  }): Promise<{ id: string }>;

  /** 删除记忆（default = 删除 MEMORY.md）；文件不存在抛 GLOBAL_MEMORY_NOT_FOUND。 */
  deleteGlobalMemory(params: { id: string }): Promise<void>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
