// Composer "MCP & 插件" 多选下拉（Tools Picker）。
// 契约见 docs/composer-tools-picker.md：
// - 勾选集是 ConversationComposer 组件态（逐条 opt-in，发送成功复位），本组件只渲染与勾选。
// - 数据由宿主注入（picker 不订阅 store/hook）：插件目录 = usePluginReferenceCatalog
//   结果（authority 与懒加载由宿主裁决）；MCP 行 = 宿主按 workspace 守卫过滤后的
//   selectPickableMcpServers 结果。提交 resolve 与 picker 必须读同一份数据，
//   否则勾选条目可能在发送时被误判失效。
// - 选中后由提交序列化层把勾选写成 prompt 尾块：插件 → plugin:// 链接（触发既有
//   runtime 能力 reminder），独立 MCP → 文本引导行；均为"推荐不强制"语义。
import { memo, useCallback, useMemo, useState } from "react";
import { PuzzleIcon, ServerIcon } from "lucide-react";
import {
  resolveLocalizedText,
  resolvePluginDisplayName,
  type ZCodeMcpServer,
  type ZCodeMcpServerStatusSnapshot,
  type ZCodePluginReferenceCatalogEntry,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { PluginIcon } from "@/components/PluginIcon.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getServerPriority } from "@/store/mcpStoreHelpers.js";
import {
  COMPOSER_MAX_PLUGIN_RECOMMENDATIONS,
  mcpToolSelectionId,
  pluginToolSelectionId,
  type ComposerToolPickerEntry,
} from "@/v4/composer/composerToolRecommendations.js";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";

export interface V4ComposerToolsPickerProps {
  /** 当前 authority 下的插件目录条目（宿主按 session/workspace authority 提供）。 */
  pluginEntries: readonly ZCodePluginReferenceCatalogEntry[];
  pluginsLoading: boolean;
  pluginsError: string | null;
  /** 宿主按 workspace 守卫过滤后的可选独立 MCP 列表（selectPickableMcpServers 结果）。 */
  mcpServers: readonly ZCodeMcpServer[];
  mcpStatusSnapshots: Readonly<Record<string, ZCodeMcpServerStatusSnapshot>>;
  selectedIds: ReadonlySet<string>;
  onToggle: (selectionId: string) => void;
  onClear: () => void;
  /** 菜单开合上报：宿主据此裁决插件目录懒加载（开或有勾选时启用查询）。 */
  onMenuOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

function mcpTransportLabel(server: ZCodeMcpServer): string {
  if (server.config.command) return "stdio";
  const type = server.config.type;
  if (type === "sse") return "sse";
  if (server.config.url || type) return "http";
  return "stdio";
}

/**
 * Picker 可见的独立 MCP 列表：与 getEnabledMcpServersForZCode 同规则的
 * enabled + 来源 + scope 过滤，按 name 去重（workspace > user 优先），稳定排序。
 * 宿主必须先应用 workspace 匹配守卫再传入结果。
 */
export function selectPickableMcpServers(
  servers: readonly ZCodeMcpServer[],
  enabledStates: Readonly<Record<string, boolean>>,
  currentProjectPath: string,
): ZCodeMcpServer[] {
  const byName = new Map<string, ZCodeMcpServer>();
  for (const server of servers) {
    const enabled = enabledStates[server.id] ?? server.enabled;
    if (!enabled) continue;
    if (server.source !== "zcodeagentmcp") continue;
    if (server.scope === "workspace" && server.projectPath !== currentProjectPath) continue;
    const existing = byName.get(server.name);
    if (!existing || getServerPriority(server) > getServerPriority(existing)) {
      byName.set(server.name, server);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function V4ComposerToolsPickerImpl({
  pluginEntries,
  pluginsLoading,
  pluginsError,
  mcpServers,
  mcpStatusSnapshots,
  selectedIds,
  onToggle,
  onClear,
  onMenuOpenChange,
  disabled,
}: V4ComposerToolsPickerProps) {
  const { intl, locale } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const handleMenuOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onMenuOpenChange?.(nextOpen);
    },
    [onMenuOpenChange],
  );

  const selectedPluginCount = useMemo(() => {
    let count = 0;
    for (const id of selectedIds) {
      if (id.startsWith("plugin:")) count += 1;
    }
    return count;
  }, [selectedIds]);

  const pluginRows = useMemo<ComposerToolPickerEntry[]>(() => {
    const conflictReason = intl.formatMessage({ id: "chat.mention.plugins.conflict" });
    const limitReason = intl.formatMessage(
      { id: "chat.toolbar.tools.pluginLimitReached" },
      { max: String(COMPOSER_MAX_PLUGIN_RECOMMENDATIONS) },
    );
    return pluginEntries
      .filter((entry) => entry.enabled)
      .map((entry) => {
        const selectionId = pluginToolSelectionId(entry.pluginId);
        const conflicted = entry.conflictingPluginIds.length > 0;
        const capabilitySummary = intl.formatMessage(
          { id: "chat.toolbar.tools.pluginCapabilities" },
          {
            skills: String(entry.skillQualifiedNames.length),
            mcpServers: String(entry.mcpServerNames.length),
            subagents: String(entry.subagentNames.length),
          },
        );
        const description = resolveLocalizedText(locale, entry.description, entry.descriptionI18n);
        const detailLines = [
          ...(description ? [description] : []),
          capabilitySummary,
          intl.formatMessage(
            { id: "chat.toolbar.tools.pluginSource" },
            { marketplace: entry.marketplace },
          ),
          ...(conflicted ? [conflictReason] : []),
        ];
        const limitReached =
          !selectedIds.has(selectionId) &&
          selectedPluginCount >= COMPOSER_MAX_PLUGIN_RECOMMENDATIONS;
        return {
          selectionId,
          kind: "plugin" as const,
          identity: entry.pluginId,
          label: resolvePluginDisplayName(
            {
              name: entry.name,
              listing: {
                displayName: entry.displayName,
                displayNameI18n: entry.displayNameI18n,
              },
            },
            locale,
          ),
          canonicalName: entry.name,
          ...(description ? { description } : {}),
          ...(entry.icon ? { icon: entry.icon } : {}),
          // 冲突禁选（V1 fail closed）；达到单轮插件上限后其余插件行禁选。
          disabled: conflicted || limitReached,
          ...(conflicted
            ? { disabledReason: conflictReason }
            : limitReached
              ? { disabledReason: limitReason }
              : {}),
          detailLines,
        };
      });
  }, [pluginEntries, intl, locale, selectedIds, selectedPluginCount]);

  const mcpRows = useMemo<ComposerToolPickerEntry[]>(() => {
    return mcpServers.map((server) => {
      const snapshot = mcpStatusSnapshots[server.name];
      const status = snapshot?.status ?? server.status ?? "unknown";
      const transport = mcpTransportLabel(server);
      const detailLines = [
        intl.formatMessage({ id: "chat.toolbar.tools.mcpTransport" }, { transport }),
        intl.formatMessage({
          id:
            server.scope === "workspace"
              ? "chat.toolbar.tools.mcpScope.workspace"
              : "chat.toolbar.tools.mcpScope.user",
        }),
        intl.formatMessage({ id: "chat.toolbar.tools.mcpStatus" }, { status }),
        ...(snapshot && snapshot.toolCount > 0
          ? [
              intl.formatMessage(
                { id: "chat.toolbar.tools.mcpToolCount" },
                { count: String(snapshot.toolCount) },
              ),
            ]
          : []),
        snapshot?.error ?? server.error ?? "",
      ].filter((line) => line.length > 0);
      return {
        selectionId: mcpToolSelectionId(server.id),
        kind: "mcp" as const,
        identity: server.id,
        label: server.name,
        canonicalName: server.name,
        description: transport,
        detailLines,
      };
    });
  }, [mcpServers, mcpStatusSnapshots, intl]);

  const handleToggle = useCallback(
    (selectionId: string) => {
      onToggle(selectionId);
    },
    [onToggle],
  );

  const triggerLabel =
    selectedIds.size > 0
      ? intl.formatMessage(
          { id: "chat.toolbar.tools.selected" },
          { count: String(selectedIds.size) },
        )
      : intl.formatMessage({ id: "chat.toolbar.tools.label" });

  const renderEntryRow = (entry: ComposerToolPickerEntry) => (
    <DropdownMenuCheckboxItem
      checked={selectedIds.has(entry.selectionId)}
      disabled={entry.disabled}
      // 保持菜单开启以支持连续多选；勾选语义走 onCheckedChange。
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={() => handleToggle(entry.selectionId)}
      data-testid={`v4-composer-tools-item-${entry.kind}-${entry.identity}`}
      className="min-h-10 items-center gap-2 py-1.5"
    >
      {entry.kind === "plugin" ? (
        <PluginIcon
          pluginId={entry.identity}
          src={entry.icon}
          className="size-5 shrink-0 rounded-md"
          iconClassName="size-3"
        />
      ) : (
        <ServerIcon className="size-4 shrink-0 text-foreground-subtle" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
            {entry.label}
          </span>
          <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
            {entry.disabled && entry.disabledReason ? entry.disabledReason : entry.description}
          </span>
        </span>
      </span>
    </DropdownMenuCheckboxItem>
  );

  const renderEntry = (entry: ComposerToolPickerEntry) => {
    const row = renderEntryRow(entry);
    if (entry.detailLines.length === 0) {
      return <div key={entry.selectionId}>{row}</div>;
    }
    return (
      <ControlHintTooltip
        key={entry.selectionId}
        title={entry.canonicalName}
        description={entry.detailLines.join("\n")}
        side="right"
        sideOffset={8}
      >
        {row}
      </ControlHintTooltip>
    );
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleMenuOpenChange}>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "chat.toolbar.tools.label" })}
        description={intl.formatMessage({ id: "chat.toolbar.tools.tooltip" })}
        open={open ? false : undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={intl.formatMessage({ id: "chat.toolbar.tools.label" })}
            data-testid="v4-composer-tools-trigger"
            data-composer-collapse-priority="3"
            className={cn(
              "group/tools h-7 w-auto gap-1 whitespace-nowrap rounded-lg px-2",
              selectedIds.size > 0
                ? "bg-accent text-primary hover:bg-accent hover:text-primary"
                : "text-foreground-subtle hover:text-foreground-subtle",
            )}
          >
            <PuzzleIcon className="size-4" />
            <span className="hidden @xl/composer:inline group-data-[composer-compact=true]/tools:hidden">
              {triggerLabel}
            </span>
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        sideOffset={4}
        className="w-72"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!isCoarseTouchDevice())
            document
              .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
              ?.focus();
        }}
      >
        <div className="max-h-[320px] overflow-y-auto">
          <DropdownMenuLabel className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.mention.plugins.title" })}
          </DropdownMenuLabel>
          {pluginsLoading ? (
            <div className="px-2 py-1.5 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          ) : pluginsError ? (
            <div className="px-2 py-1.5 text-ui-sm text-destructive">
              {intl.formatMessage({ id: "chat.toolbar.tools.error" })}
            </div>
          ) : pluginRows.length === 0 ? (
            <div className="px-2 py-1.5 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "chat.toolbar.tools.empty.plugins" })}
            </div>
          ) : (
            pluginRows.map(renderEntry)
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.toolbar.tools.section.mcpServers" })}
          </DropdownMenuLabel>
          {mcpRows.length === 0 ? (
            <div className="px-2 py-1.5 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "chat.toolbar.tools.empty.mcpServers" })}
            </div>
          ) : (
            mcpRows.map(renderEntry)
          )}
        </div>
        {selectedIds.size > 0 ? (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-ui-xs text-foreground-subtlest">
                {intl.formatMessage(
                  { id: "chat.toolbar.tools.selected" },
                  { count: String(selectedIds.size) },
                )}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="v4-composer-tools-clear"
                className="h-6 px-2 text-ui-xs text-foreground-subtle"
                onClick={(event) => {
                  event.preventDefault();
                  onClear();
                }}
              >
                {intl.formatMessage({ id: "chat.toolbar.tools.clear" })}
              </Button>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const V4ComposerToolsPicker = memo(V4ComposerToolsPickerImpl);
