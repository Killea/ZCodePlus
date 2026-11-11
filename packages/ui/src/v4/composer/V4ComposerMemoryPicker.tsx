// Composer "全局记忆"多选下拉。
// 契约见 docs/global-memory-multi.md：
// - 勾选集是 ConversationComposer 组件态（逐条 opt-in，发送成功复位），本组件只渲染与勾选。
// - 数据由宿主注入（picker 不订阅 store/hook）：菜单打开时宿主 listGlobalMemories()
//   拉取最新清单；提交与 picker 读同一份快照，否则勾选条目可能在发送时被误判失效。
// - 单轮上限 GLOBAL_MEMORY_SELECTION_LIMIT：达到上限后未勾选行禁选（与 tools picker
//   的 pluginLimitReached 同款交互）。
// - 勾选的记忆在发送前被另一窗口/CLI 删除属正常路径：照常发送，CLI 静默跳过。
import { memo, useCallback, useState } from "react";
import { BrainIcon } from "lucide-react";
import {
  GLOBAL_MEMORY_DEFAULT_ID,
  GLOBAL_MEMORY_SELECTION_LIMIT,
  type GlobalMemoryEntryMeta,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_MEMORY_PICKER } from "@zcode/shared/test-ids";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";

export interface V4ComposerMemoryPickerProps {
  /** 当前权威源下的全局记忆清单（宿主在菜单打开时拉取）。 */
  memories: readonly GlobalMemoryEntryMeta[];
  loading: boolean;
  error: string | null;
  selectedIds: ReadonlySet<string>;
  onToggle: (memoryId: string) => void;
  /** 菜单开合上报：宿主据此拉取/刷新记忆清单。 */
  onMenuOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

function V4ComposerMemoryPickerImpl({
  memories,
  loading,
  error,
  selectedIds,
  onToggle,
  onMenuOpenChange,
  disabled,
}: V4ComposerMemoryPickerProps) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const handleMenuOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onMenuOpenChange?.(nextOpen);
    },
    [onMenuOpenChange],
  );

  const displayName = useCallback(
    // 与设置页列表同口径：default 有自定义 name 时显示自定义名，
    // 本地化"默认"只作未命名（name 回退为 id）时的回退。
    (entry: GlobalMemoryEntryMeta): string =>
      entry.id === GLOBAL_MEMORY_DEFAULT_ID && entry.name === entry.id
        ? intl.formatMessage({ id: "chat.toolbar.memory.defaultName" })
        : entry.name,
    [intl],
  );

  const triggerLabel =
    selectedIds.size > 0
      ? intl.formatMessage(
          { id: "chat.toolbar.memory.labelSelected" },
          { count: String(selectedIds.size) },
        )
      : intl.formatMessage({ id: "chat.toolbar.memory.label" });

  const limitReason = intl.formatMessage(
    { id: "chat.toolbar.memory.limitReached" },
    { max: String(GLOBAL_MEMORY_SELECTION_LIMIT) },
  );

  return (
    <DropdownMenu open={open} onOpenChange={handleMenuOpenChange}>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "chat.toolbar.memory.label" })}
        description={intl.formatMessage({ id: "chat.toolbar.memory.tooltip" })}
        open={open ? false : undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={intl.formatMessage({ id: "chat.toolbar.memory.label" })}
            data-testid={TID_V4_COMPOSER_MEMORY_PICKER}
            data-composer-collapse-priority="3"
            className={cn(
              "group/memory h-7 w-auto gap-1 whitespace-nowrap rounded-lg px-2",
              selectedIds.size > 0
                ? "bg-accent text-primary hover:bg-accent hover:text-primary"
                : "text-foreground-subtle hover:text-foreground-subtle",
            )}
          >
            <BrainIcon className="size-4" />
            <span className="hidden @xl/composer:inline group-data-[composer-compact=true]/memory:hidden">
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
            {intl.formatMessage({ id: "chat.toolbar.memory.section" })}
          </DropdownMenuLabel>
          {loading ? (
            <div className="px-2 py-1.5 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          ) : error ? (
            <div className="px-2 py-1.5 text-ui-sm text-destructive">
              {intl.formatMessage({ id: "chat.toolbar.memory.error" })}
            </div>
          ) : memories.length === 0 ? (
            <div className="px-2 py-1.5 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "chat.toolbar.memory.empty" })}
            </div>
          ) : (
            memories.map((entry) => {
              const checked = selectedIds.has(entry.id);
              const limitReached = !checked && selectedIds.size >= GLOBAL_MEMORY_SELECTION_LIMIT;
              return (
                <DropdownMenuCheckboxItem
                  key={entry.id}
                  checked={checked}
                  disabled={limitReached}
                  // 保持菜单开启以支持连续多选；勾选语义走 onCheckedChange。
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => onToggle(entry.id)}
                  data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-item-${entry.id}`}
                  className="min-h-10 items-center gap-2 py-1.5"
                >
                  <BrainIcon className="size-4 shrink-0 text-foreground-subtle" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
                        {displayName(entry)}
                      </span>
                      <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                        {limitReached ? limitReason : entry.description}
                      </span>
                    </span>
                  </span>
                </DropdownMenuCheckboxItem>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const V4ComposerMemoryPicker = memo(V4ComposerMemoryPickerImpl);
