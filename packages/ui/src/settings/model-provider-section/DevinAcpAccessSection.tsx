import { useState } from "react";
import type { ProviderConfigObject } from "@zcode/provider";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { ApiKeyInput } from "./ApiKeyInput.js";

type DevinAcpAccess = Extract<
  NonNullable<ProviderConfigObject["access"]>,
  { type: "devin-acp" }
>;

const DEVIN_MODES = ["accept-edits", "smart", "ask", "plan", "bypass"] as const;
// Radix Select.Item 禁止空字符串 value；用哨兵值表示"未设置=Devin 默认"。
const DEVIN_MODE_DEFAULT = "default";
const CONTEXT_FORWARD_POLICIES = ["memory-only", "all-dynamic", "none"] as const;
const DEFAULT_TIMEOUT_SECONDS = 7200;
const SECONDS_TO_MS = 1000;

/**
 * Devin（本地 ACP Agent）Provider 的访问配置区块。
 * 与 api-key 表单不同：这些字段全部可选，空值 = Devin 自身默认/自动探测。
 * 每个字段独立提交，保存走外层 provider draft 的同一 onSave 通道。
 */
export function DevinAcpAccessSection({
  access,
  onSaveAccess,
}: {
  access: DevinAcpAccess;
  onSaveAccess: (access: DevinAcpAccess) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  // 已知限制：本地 useState 初始化后不跟随外部 access 变化（如另一窗口/进程
  // 改了配置，本组件仍显示旧值）。低优先，待修。
  const [binaryPath, setBinaryPath] = useState(access.binaryPath ?? "");
  const [apiKey, setApiKey] = useState(access.apiKey ?? "");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    String(access.promptTimeoutMs ? access.promptTimeoutMs / SECONDS_TO_MS : DEFAULT_TIMEOUT_SECONDS),
  );

  const commit = (patch: Partial<DevinAcpAccess>) => {
    void onSaveAccess({ ...access, ...patch });
  };

  const commitTextField = (key: "binaryPath" | "apiKey", value: string) => {
    const trimmed = value.trim();
    commit({ [key]: trimmed || undefined });
  };

  const commitTimeout = () => {
    const seconds = Number(timeoutSeconds);
    commit({
      promptTimeoutMs:
        Number.isFinite(seconds) && seconds > 0
          ? Math.round(seconds * SECONDS_TO_MS)
          : undefined,
    });
  };

  return (
    <>
      <div>
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.devin.binaryPath" })}
        </label>
        <Input
          {...TECHNICAL_INPUT_ATTRIBUTES}
          type="text"
          size="lg"
          value={binaryPath}
          placeholder={intl.formatMessage({
            id: "settings.modelProvider.devin.binaryPathPlaceholder",
          })}
          onChange={(event) => setBinaryPath(event.target.value)}
          onBlur={() => commitTextField("binaryPath", binaryPath)}
        />
      </div>

      <div>
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.devin.apiKey" })}
        </label>
        <ApiKeyInput
          value={apiKey}
          visible={apiKeyVisible}
          onChange={setApiKey}
          onBlur={() => commitTextField("apiKey", apiKey)}
          onToggleVisibility={() => setApiKeyVisible((value) => !value)}
        />
      </div>

      <div>
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.devin.mode" })}
        </label>
        <Select
          value={access.mode ?? DEVIN_MODE_DEFAULT}
          onValueChange={(value) =>
            commit({
              mode:
                value === DEVIN_MODE_DEFAULT
                  ? undefined
                  : (value as (typeof DEVIN_MODES)[number]),
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value={DEVIN_MODE_DEFAULT}>
              {intl.formatMessage({ id: "settings.modelProvider.devin.modeDefault" })}
            </SelectItem>
            {DEVIN_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {mode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.devin.promptTimeout" })}
        </label>
        <Input
          {...TECHNICAL_INPUT_ATTRIBUTES}
          type="text"
          inputMode="numeric"
          size="lg"
          value={timeoutSeconds}
          onChange={(event) => setTimeoutSeconds(event.target.value)}
          onBlur={commitTimeout}
        />
      </div>

      <div>
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.devin.contextForward" })}
        </label>
        <Select
          value={access.contextForward ?? "memory-only"}
          onValueChange={(value) =>
            commit({
              contextForward: value as (typeof CONTEXT_FORWARD_POLICIES)[number],
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {CONTEXT_FORWARD_POLICIES.map((policy) => (
              <SelectItem key={policy} value={policy}>
                {intl.formatMessage({
                  id: `settings.modelProvider.devin.contextForward.${policy === "memory-only" ? "memoryOnly" : policy === "all-dynamic" ? "allDynamic" : "none"}`,
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-2">
        <label className="block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.devin.mcpPassthrough" })}
        </label>
        <Switch
          checked={access.mcpPassthrough !== false}
          onCheckedChange={(checked) => commit({ mcpPassthrough: checked })}
        />
      </div>
    </>
  );
}
