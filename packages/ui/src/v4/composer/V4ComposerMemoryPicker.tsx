// Composer "全局记忆"多选下拉。
// 契约见 docs/global-memory-multi.md：
// - 勾选集是 ConversationComposer 组件态（逐条 opt-in，发送成功复位），本组件只渲染与勾选。
// - 数据由宿主注入（picker 不订阅 store/hook）：菜单打开时宿主 listGlobalMemories()
//   拉取最新清单；提交与 picker 读同一份快照，否则勾选条目可能在发送时被误判失效。
// - 单轮上限 GLOBAL_MEMORY_SELECTION_LIMIT：达到上限后未勾选行禁选（与 tools picker
//   的 pluginLimitReached 同款交互）。
// - 勾选的记忆在发送前被另一窗口/CLI 删除属正常路径：照常发送，CLI 静默跳过。
// - 条目 hover 内容浮层：meta 列表不含 content，首次 hover 才经宿主
//   onReadMemoryContent(id) 懒加载（picker 生命周期内按 id 缓存）。浮层是
//   position:fixed 的自定义面板（pointer-events:auto 支持滚轮滚动）——不用
//   Radix Tooltip，modal DropdownMenu 会拦截其 hover 链路。
import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useRef, useState } from "react";
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
  /**
   * hover 内容懒加载：返回该记忆 body 明文；条目缺失/失败返回 null（UI 显示
   * 空内容占位，不报错）。不传时浮层恒显示空占位（fixture/降级场景）。
   */
  onReadMemoryContent?: (memoryId: string) => Promise<string | null>;
  disabled?: boolean;
}

/** 浮层几何约束：宽 ≤384px、高 ≤320px（内容区 280 可滚），定位估算用同一上限。 */
const DETAIL_MAX_WIDTH = 384;
const DETAIL_EST_HEIGHT = 320;
const DETAIL_VIEWPORT_PADDING = 8;
/** 浮层与菜单本体之间的间距（侧放，避免盖住菜单列表）。 */
const DETAIL_GAP = 8;
/** 指针移出条目与浮层后的关闭宽限期：覆盖两者之间的间隙移动。 */
const DETAIL_CLOSE_GRACE_MS = 150;

function V4ComposerMemoryPickerImpl({
  memories,
  loading,
  error,
  selectedIds,
  onToggle,
  onMenuOpenChange,
  onReadMemoryContent,
  disabled,
}: V4ComposerMemoryPickerProps) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  // ── hover 内容浮层（完整正文预览）──
  // 条目 + 菜单本体矩形快照驱动 fixed 定位（侧放不叠菜单）；
  // content 按 id 缓存，拉取竞态用 hoverIdRef 兜底。
  const [hover, setHover] = useState<{
    id: string;
    item: { left: number; top: number; bottom: number };
    menu: { left: number; top: number; right: number; bottom: number } | null;
  } | null>(null);
  const [hoverContent, setHoverContent] = useState<string | null>(null);
  const [hoverLoading, setHoverLoading] = useState(false);
  const contentCache = useRef(new Map<string, string>());
  const hoverIdRef = useRef<string | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const detailPanelRef = useRef<HTMLDivElement | null>(null);

  const cancelDetailClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleDetailClose = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      hoverIdRef.current = null;
      setHover(null);
    }, DETAIL_CLOSE_GRACE_MS);
  }, []);

  // 组件卸载时回收未触发的宽限期定时器。
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  // 手动滚轮滚动：modal 弹层的 react-remove-scroll（背景滚动锁）会在 document
  // 层 preventDefault 全页 wheel——浮层不是它注册的 shard，默认滚动已被抑制，
  // 必须在面板上把 deltaY 手动落到 scrollTop，否则滚轮/触控板无法滚动正文。
  useEffect(() => {
    if (!hover) return;
    const panel = detailPanelRef.current;
    if (!panel) return;
    const handleWheel = (event: WheelEvent) => {
      const scroller = panel.querySelector<HTMLElement>("[data-memory-detail-scroller]");
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
      const factor =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 40
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientHeight
            : 1;
      scroller.scrollTop += event.deltaY * factor;
      event.preventDefault();
    };
    panel.addEventListener("wheel", handleWheel, { passive: false });
    return () => panel.removeEventListener("wheel", handleWheel);
  }, [hover]);

  const loadHoverContent = useCallback(
    (memoryId: string) => {
      hoverIdRef.current = memoryId;
      const cached = contentCache.current.get(memoryId);
      if (cached !== undefined) {
        setHoverContent(cached);
        setHoverLoading(false);
        return;
      }
      setHoverContent(null);
      setHoverLoading(true);
      if (!onReadMemoryContent) {
        // 宿主未提供数据源：按空内容占位，不悬挂 loading。
        setHoverContent("");
        setHoverLoading(false);
        return;
      }
      onReadMemoryContent(memoryId).then(
        (content) => {
          const value = content ?? "";
          contentCache.current.set(memoryId, value);
          if (hoverIdRef.current === memoryId) {
            setHoverContent(value);
            setHoverLoading(false);
          }
        },
        () => {
          // 拉取失败（条目已删除/服务异常）：缓存空占位，避免每次 hover 重复打失败请求。
          contentCache.current.set(memoryId, "");
          if (hoverIdRef.current === memoryId) {
            setHoverContent("");
            setHoverLoading(false);
          }
        },
      );
    },
    [onReadMemoryContent],
  );

  const handleItemMouseEnter = useCallback(
    (memoryId: string, target: HTMLElement) => {
      if (isCoarseTouchDevice()) return; // 触屏无 hover 语义，不出浮层。
      cancelDetailClose();
      const rect = target.getBoundingClientRect();
      // 菜单本体矩形：侧放定位的锚点。wrapper 不转发 ref，从条目向上 closest
      // 到本 picker 的 menu content（data-testid 精确限定，不受页面上其它下拉干扰）。
      const menuEl = target.closest<HTMLElement>(
        `[data-testid="${TID_V4_COMPOSER_MEMORY_PICKER}-content"]`,
      );
      const menuRect = menuEl?.getBoundingClientRect();
      setHover({
        id: memoryId,
        item: { left: rect.left, top: rect.top, bottom: rect.bottom },
        menu: menuRect
          ? { left: menuRect.left, top: menuRect.top, right: menuRect.right, bottom: menuRect.bottom }
          : null,
      });
      loadHoverContent(memoryId);
    },
    [cancelDetailClose, loadHoverContent],
  );

  const handleMenuOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        // 菜单关闭：浮层立即关闭（不等宽限期），loading 态复位；content 缓存保留给下一轮。
        if (closeTimerRef.current !== null) {
          window.clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
        hoverIdRef.current = null;
        setHover(null);
        setHoverContent(null);
        setHoverLoading(false);
      }
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

  // hover 内容浮层：fixed 定位 portal（pointer-events:auto 支持指针移入与滚轮
  // 滚动）。侧放不叠菜单（2026-11-24）：初版「贴条目下方」会盖住菜单列表其余
  // 条目，改为默认菜单本体右侧（顶边对齐 hover 条目、纵向 clamp），右侧放不下
  // 翻左侧，窄视口两侧都放不下时回退菜单上方。定位用固定估算高度
  // （DETAIL_EST_HEIGHT）——浮层内容区 max-h 280 + 标题/内边距 < 320，估算偏
  // 保守只会留少量空隙，不会出界。
  const renderDetailPanel = (hovered: {
    id: string;
    item: { left: number; top: number; bottom: number };
    menu: { left: number; top: number; right: number; bottom: number } | null;
  }) => {
    const entry = memories.find((m) => m.id === hovered.id);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelWidth = Math.min(DETAIL_MAX_WIDTH, viewportWidth - DETAIL_VIEWPORT_PADDING * 2);
    let left: number;
    let top: number;
    if (hovered.menu) {
      const fitsRight =
        hovered.menu.right + DETAIL_GAP + panelWidth <= viewportWidth - DETAIL_VIEWPORT_PADDING;
      const fitsLeft =
        hovered.menu.left - DETAIL_GAP - panelWidth >= DETAIL_VIEWPORT_PADDING;
      if (fitsRight || fitsLeft) {
        // 侧放：水平贴在菜单外侧，纵向顶边对齐 hover 条目（下方 clamp 收进视口）。
        left = fitsRight
          ? hovered.menu.right + DETAIL_GAP
          : hovered.menu.left - DETAIL_GAP - panelWidth;
        top = hovered.item.top;
      } else {
        // 窄视口两侧都放不下：回退到菜单上方，水平与菜单左对齐。
        left = Math.max(
          DETAIL_VIEWPORT_PADDING,
          Math.min(
            hovered.menu.left,
            viewportWidth - DETAIL_VIEWPORT_PADDING - panelWidth,
          ),
        );
        top = hovered.menu.top - DETAIL_GAP - DETAIL_EST_HEIGHT;
      }
    } else {
      // 菜单矩形取不到（异常路径）：回退旧的贴条目下方、近底翻上逻辑。
      left = Math.min(
        Math.max(DETAIL_VIEWPORT_PADDING, hovered.item.left),
        Math.max(DETAIL_VIEWPORT_PADDING, viewportWidth - DETAIL_VIEWPORT_PADDING - panelWidth),
      );
      top = hovered.item.bottom + DETAIL_GAP;
      if (top + DETAIL_EST_HEIGHT > viewportHeight - DETAIL_VIEWPORT_PADDING) {
        top = hovered.item.top - DETAIL_GAP - DETAIL_EST_HEIGHT;
      }
    }
    top = Math.max(
      DETAIL_VIEWPORT_PADDING,
      Math.min(top, viewportHeight - DETAIL_VIEWPORT_PADDING - DETAIL_EST_HEIGHT),
    );
    return createPortal(
      <div
        ref={detailPanelRef}
        role="tooltip"
        data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-detail`}
        className="pointer-events-auto fixed z-[70] rounded-lg border border-border bg-popover p-3 text-left shadow-md"
        style={{ left, top, width: panelWidth }}
        onMouseEnter={cancelDetailClose}
        onMouseLeave={scheduleDetailClose}
      >
        <div className="mb-1.5 text-ui-xs font-medium text-foreground-subtle">
          {entry ? displayName(entry) : hovered.id}
        </div>
        {hoverLoading || hoverContent === null ? (
          <div className="max-h-[280px] overflow-y-auto text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        ) : hoverContent === "" ? (
          <div className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.toolbar.memory.contentEmpty" })}
          </div>
        ) : (
          <div
            data-memory-detail-scroller
            className="max-h-[280px] overflow-y-auto whitespace-pre-wrap break-words text-ui-sm leading-relaxed text-foreground"
          >
            {hoverContent}
          </div>
        )}
      </div>,
      document.body,
    );
  };

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
        data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-content`}
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
                  onMouseEnter={(event) => handleItemMouseEnter(entry.id, event.currentTarget)}
                  onMouseLeave={scheduleDetailClose}
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
      {hover ? renderDetailPanel(hover) : null}
    </DropdownMenu>
  );
}

export const V4ComposerMemoryPicker = memo(V4ComposerMemoryPickerImpl);
