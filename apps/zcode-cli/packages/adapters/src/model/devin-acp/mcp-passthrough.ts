import type { Logger, McpServerConfig } from "@zcode/contracts";

/**
 * ZCode mcp.servers 配置 → ACP session/new.mcpServers 的映射。
 * zcode_official 鉴权依赖宿主逐请求注入凭证，Devin 独立 spawn 后凭证不存在；
 * 这类 server 跳过并告警，避免静默把不可用的 server 传给 Devin。
 */
export function buildAcpMcpServers(
  servers: Readonly<Record<string, McpServerConfig>>,
  logger?: Logger,
): unknown[] {
  const mapped: unknown[] = [];
  for (const [name, config] of Object.entries(servers)) {
    if (config.enabled === false) continue;
    if (("auth" in config && config.auth) || ("official" in config && config.official)) {
      logger?.warn(`[devin-acp] skipping mcp server with host-managed auth: ${name}`);
      continue;
    }
    if (config.type === "stdio") {
      mapped.push({
        name,
        command: config.command,
        args: config.args ?? [],
        env: Object.entries(config.env ?? {}).map(([envName, value]) => ({
          name: envName,
          value,
        })),
      });
    } else {
      mapped.push({
        name,
        type: config.type,
        url: config.url,
        headers: Object.entries(config.headers ?? {}).map(([headerName, value]) => ({
          name: headerName,
          value,
        })),
      });
    }
  }
  return mapped;
}
