// Model factory - creates model adapter with config

import {
  createModelRequestSecurityState,
  AiSdkModelAdapter,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "@zcode/adapters/model";
import type { Logger, McpServerConfig, ModelStatusSink } from "@zcode/contracts";

interface CreateModelAdapterBaseOptions {
  env?: EnvRecord;
  logger?: Logger;
  modelIoDir?: string;
  modelIoFullRetentionEnabled?: boolean;
  streamIdleTimeoutMs?: number;
  statusSink?: ModelStatusSink;
  /** devin-acp Provider 在 session/new 时读取的 MCP 透传配置源。 */
  listMcpServers?: () => Readonly<Record<string, McpServerConfig>>;
  /** devin-acp session 的 cwd：runtime 解析的 workspace 目录。 */
  workingDirectory?: string;
}

export type CreateModelAdapterOptions = CreateModelAdapterBaseOptions & {
  executionConfig: AiSdkModelExecutionConfig;
};

// 可复用资源由进程拥有，每个 execution 保留自己的请求状态。
const processRequestSecurityState = createModelRequestSecurityState();

export function createModelAdapter(options: CreateModelAdapterOptions): AiSdkModelAdapter {
  if (!options.executionConfig) {
    throw new Error("createModelAdapter requires executionConfig");
  }
  return new AiSdkModelAdapter({
    ...options.executionConfig,
    requestSecurityState: processRequestSecurityState,
    debugDir: options.modelIoDir,
    env: options.env,
    logger: options.logger,
    modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    statusSink: options.statusSink,
    ...(options.listMcpServers || options.workingDirectory
      ? {
          devinAcp: {
            ...(options.listMcpServers
              ? { listMcpServers: options.listMcpServers }
              : {}),
            ...(options.workingDirectory
              ? { workingDirectory: options.workingDirectory }
              : {}),
          },
        }
      : {}),
  });
}
