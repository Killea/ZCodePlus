// 对齐文件搜索型子 agent 的工具面。direct branch 会暴露 Glob/Grep；
// embedded search branch 则通过 Bash find/grep 接管搜索。注意：白名单刻意不含任何
// 文件写工具（Write/Edit/ApplyPatch），因此 Bash 是唯一的副作用入口。Explore 继承父会话的权限模式与
// Plan 状态，Bash 是否只读由 shell AST 判定（非只读命令按父会话模式询问或拒绝），prompt 也禁止修改。
export const EXPLORE_AGENT_ALLOWED_TOOLS = [
  "ToolSearch",
  "DeferredToolCall",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;

export type ExploreAgentAllowedTool = (typeof EXPLORE_AGENT_ALLOWED_TOOLS)[number];

export const EXPLORE_AGENT_EMBEDDED_SEARCH_ALLOWED_TOOLS = [
  "ToolSearch",
  "DeferredToolCall",
  "Bash",
  "Read",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;

const EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY = [
  "Glob",
  "Grep",
  "Read",
  "Bash",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const satisfies readonly ExploreAgentAllowedTool[];
const EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY_SET = new Set<ExploreAgentAllowedTool>(
  EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY,
);

export function buildExploreAllowedTools(
  options: {
    embeddedSearchEnabled?: boolean;
    /**
     * 调用方模型是否支持 provider-native WebSearch。`=== false` 时从两份清单中剔除
     * WebSearch：该工具本质是 provider-native web_search 的包装，只有 anthropic kind 能
     * 编码（见 adapters tool-transform），不支持时子代理也不能持有——allowlist 与
     * Agent 描述共用此开关，保证模型读到的工具名与实际可用集合一致。
     */
    nativeWebSearchSupported?: boolean;
  } = {},
): readonly ExploreAgentAllowedTool[] {
  const tools = options.embeddedSearchEnabled
    ? EXPLORE_AGENT_EMBEDDED_SEARCH_ALLOWED_TOOLS
    : EXPLORE_AGENT_ALLOWED_TOOLS;
  if (options.nativeWebSearchSupported === false) {
    return tools.filter((tool) => tool !== "WebSearch");
  }
  return tools;
}

export function formatExploreAllowedToolsForAgentDescription(
  options: {
    embeddedSearchEnabled?: boolean;
    /** 与 buildExploreAllowedTools 同一开关：不支持时描述中的工具清单同样去掉 WebSearch。 */
    nativeWebSearchSupported?: boolean;
  } = {},
): string {
  const allowedTools = buildExploreAllowedTools(options);
  const allowedToolSet = new Set(allowedTools);
  const prioritizedTools = EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY.filter((tool) =>
    allowedToolSet.has(tool),
  );
  const unprioritizedTools = allowedTools.filter(
    (tool) =>
      tool !== "ToolSearch" &&
      tool !== "DeferredToolCall" &&
      !EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY_SET.has(tool),
  );
  return [...prioritizedTools, ...unprioritizedTools].join(", ");
}
