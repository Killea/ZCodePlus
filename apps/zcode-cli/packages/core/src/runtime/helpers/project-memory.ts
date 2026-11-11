import type { AgentRuntimeConfig } from "../types.js";
import { resolveProjectMemoryRoot } from "../../memory/project-root.js";
import { resolveGlobalMemoryDir } from "../../memory/global-content.js";

export function resolveEnabledProjectMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false || !memory.cliStorageRoot) return undefined;
  if (!isMainMemoryTaskType(config.taskType)) return undefined;

  return resolveProjectMemoryRoot({
    cliStorageRoot: memory.cliStorageRoot,
    workspaceIdentity: memory.workspaceIdentity,
    // 受管 worktree 会话与源仓库共用项目记忆（docs/git/worktree.md §6.6.3）。
    workspacePath: config.projectDirectory ?? workspacePath,
  });
}

/** 全局（跨工作区）记忆目录；主 agent 写权限门禁用，仅在总开关开启且为主 agent 时返回。 */
export function resolveEnabledGlobalMemoryDir(config: AgentRuntimeConfig): string | undefined {
  const memory = config.memory;
  if (!memory?.globalEnabled || !memory.cliStorageRoot) return undefined;
  if (!isMainMemoryTaskType(config.taskType)) return undefined;
  return resolveGlobalMemoryDir(memory.cliStorageRoot);
}

export function isMainMemoryTaskType(taskType: AgentRuntimeConfig["taskType"]): boolean {
  return (
    taskType === undefined ||
    taskType === "interactive" ||
    taskType === "fork" ||
    taskType === "selection_side_chat" ||
    taskType === "workflow_parent"
  );
}
