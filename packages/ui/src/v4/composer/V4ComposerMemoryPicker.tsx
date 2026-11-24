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
// - 快速增删改/复制：顶部「新建记忆」行 + 条目 hover 操作条（编辑/复制/删除）。
//   写路径由宿主注入（onCreateMemory/onUpdateMemory/onDeleteMemory，成功返回
//   true）；打开弹层前先关菜单（菜单 z-[60] 高于 Dialog z-50，叠层会盖住弹层）；
//   编辑/删除成功后失效该 id 的正文缓存。
import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BrainIcon, CopyIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_MEMORY_PICKER } from "@zcode/shared/test-ids";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import {
  V4ComposerMemoryDeleteDialog,
  V4ComposerMemoryEditDialog,
  type V4ComposerMemoryDraftInput,
} from "@/v4/composer/V4ComposerMemoryDialogs.js";

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
  /** 新建全局记忆（宿主对接 createGlobalMemory）；成功返回 true，失败 false（弹层保持打开报错）。 */
  onCreateMemory?: (input: V4ComposerMemoryDraftInput) => Promise<boolean>;
  /** 写回单条记忆（宿主对接 writeGlobalMemory）；成功 true / 失败 false。 */
  onUpdateMemory?: (memoryId: string, input: V4ComposerMemoryDraftInput) => Promise<boolean>;
  /** 删除单条记忆（宿主对接 deleteGlobalMemory，并清理勾选集）；成功 true / 失败 false。 */
  onDeleteMemory?: (memoryId: string) => Promise<boolean>;
  disabled?: boolean;
}

/** 快速增删改弹层会话：编辑/删除携带目标 id；复制预填后走新建路径。 */
type MemoryDialogKind =
  | { kind: "create" }
  | { kind: "edit"; id: string }
  | { kind: "duplicate"; sourceId: string }
  | { kind: "delete"; id: string };

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
  onCreateMemory,
  onUpdateMemory,
  onDeleteMemory,
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
  // ── 快速增删改/复制弹层（V4ComposerMemoryDialogs）──
  // 弹层由条件挂载 + key（dialogSession）驱动会话重置；draft 在打开前一次性预填。
  const [memoryDialog, setMemoryDialog] = useState<MemoryDialogKind | null>(null);
  const [dialogDraft, setDialogDraft] = useState<V4ComposerMemoryDraftInput>({
    name: "",
    description: "",
    content: "",
  });
  const [dialogSession, setDialogSession] = useState(0);

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
          ? {
              left: menuRect.left,
              top: menuRect.top,
              right: menuRect.right,
              bottom: menuRect.bottom,
            }
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

  // ── 弹层状态机：打开前先关菜单（菜单 z-[60] 高于 Dialog z-50，叠层会盖住弹层）。
  const closeMenuForDialog = useCallback(
    (next: MemoryDialogKind) => {
      cancelDetailClose();
      setHover(null);
      setHoverContent(null);
      setHoverLoading(false);
      setDialogSession((session) => session + 1);
      setMemoryDialog(next);
      setOpen(false);
    },
    [cancelDetailClose],
  );

  const handleOpenCreate = useCallback(() => {
    setDialogDraft({ name: "", description: "", content: "" });
    closeMenuForDialog({ kind: "create" });
  }, [closeMenuForDialog]);

  /** 编辑/复制共用的预填流程：正文取缓存或懒读，名称按源条目规则派生。 */
  const openEditOrDuplicate = useCallback(
    async (sourceId: string, kind: "edit" | "duplicate") => {
      const entry = memories.find((m) => m.id === sourceId);
      if (!entry) return;
      const cached = contentCache.current.get(sourceId);
      const content =
        cached !== undefined
          ? cached
          : onReadMemoryContent
            ? ((await onReadMemoryContent(sourceId)) ?? "")
            : "";
      if (cached === undefined && onReadMemoryContent) {
        contentCache.current.set(sourceId, content);
      }
      const unnamed = entry.name === entry.id;
      // 复制：自定义名加「（副本）」后缀；未命名时非 default 用 id，default 留空让用户填写。
      const baseName = unnamed
        ? entry.id === GLOBAL_MEMORY_DEFAULT_ID
          ? ""
          : entry.id
        : entry.name;
      if (kind === "edit") {
        setDialogDraft({
          name: unnamed ? "" : entry.name,
          description: entry.description ?? "",
          content,
        });
        closeMenuForDialog({ kind: "edit", id: sourceId });
      } else {
        const suffix = intl.formatMessage({ id: "chat.toolbar.memory.duplicateSuffix" });
        setDialogDraft({
          name: baseName ? `${baseName}${suffix}` : "",
          description: entry.description ?? "",
          content,
        });
        closeMenuForDialog({ kind: "duplicate", sourceId });
      }
    },
    [memories, onReadMemoryContent, closeMenuForDialog, intl],
  );

  const handleOpenDelete = useCallback(
    (memoryId: string) => {
      closeMenuForDialog({ kind: "delete", id: memoryId });
    },
    [closeMenuForDialog],
  );

  const handleDialogSave = useCallback(
    async (input: V4ComposerMemoryDraftInput): Promise<boolean> => {
      const dialog = memoryDialog;
      if (!dialog || dialog.kind === "delete") return false;
      let ok = false;
      if (dialog.kind === "create" && onCreateMemory) {
        ok = await onCreateMemory(input);
      } else if (dialog.kind === "duplicate" && onCreateMemory) {
        ok = await onCreateMemory(input);
      } else if (dialog.kind === "edit" && onUpdateMemory) {
        ok = await onUpdateMemory(dialog.id, input);
      }
      // 编辑成功后失效正文缓存，避免 hover 预览显示旧正文。
      if (ok && dialog.kind === "edit") {
        contentCache.current.delete(dialog.id);
      }
      return ok;
    },
    [memoryDialog, onCreateMemory, onUpdateMemory],
  );

  const handleDeleteConfirm = useCallback(async (): Promise<boolean> => {
    const dialog = memoryDialog;
    if (!dialog || dialog.kind !== "delete" || !onDeleteMemory) return false;
    const ok = await onDeleteMemory(dialog.id);
    if (ok) {
      contentCache.current.delete(dialog.id);
    }
    return ok;
  }, [memoryDialog, onDeleteMemory]);

  const handleDialogClose = useCallback(() => {
    setMemoryDialog(null);
  }, []);

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
      const fitsLeft = hovered.menu.left - DETAIL_GAP - panelWidth >= DETAIL_VIEWPORT_PADDING;
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
          Math.min(hovered.menu.left, viewportWidth - DETAIL_VIEWPORT_PADDING - panelWidth),
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

  // 删除确认框的条目显示名；条目在打开确认框前被删（另一窗口/CLI）时回退 id。
  const deleteEntry =
    memoryDialog?.kind === "delete" ? memories.find((m) => m.id === memoryDialog.id) : undefined;

  return (
    <>
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
            {/* 快速新建：点选即开编辑框（onSelect 默认关菜单，与 closeMenuForDialog 幂等）。 */}
            {onCreateMemory ? (
              <DropdownMenuItem
                onSelect={handleOpenCreate}
                data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-new`}
                className="min-h-9 py-1.5"
              >
                <PlusIcon className="size-4 shrink-0 text-foreground-subtle" />
                {intl.formatMessage({ id: "chat.toolbar.memory.new" })}
              </DropdownMenuItem>
            ) : null}
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
                // 条目 hover 操作条：编辑/复制/删除。CheckboxItem 渲染为 <button>，
                // 嵌套 <button> 非法——用 role="button" span，stopPropagation 隔离
                // 勾选（onCheckedChange）与菜单关闭语义；仅鼠标可达（tabIndex -1）。
                const hasActions = Boolean(onUpdateMemory || onCreateMemory || onDeleteMemory);
                const renderAction = (
                  suffix: string,
                  icon: ReactNode,
                  label: string,
                  run: () => void,
                ) => (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={label}
                    data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-item-${entry.id}-action-${suffix}`}
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-subtle hover:bg-accent hover:text-foreground"
                    // Radix 菜单项用 pointerdown 跟踪、pointerup 激活（CheckboxItem
                    // 在 pointerup 上触发 onCheckedChange）——pointerdown/pointerup
                    // 都要拦断，否则图标点击会冒泡到条目造成误勾选。
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerUp={(event) => event.stopPropagation()}
                    onPointerCancel={(event) => event.stopPropagation()}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      run();
                    }}
                  >
                    {icon}
                  </span>
                );
                return (
                  <DropdownMenuCheckboxItem
                    key={entry.id}
                    checked={checked}
                    disabled={limitReached}
                    // 保持菜单开启以支持连续多选；勾选语义走 onCheckedChange。
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={() => onToggle(entry.id)}
                    data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-item-${entry.id}`}
                    className="group/memory-item min-h-10 items-center gap-2 py-1.5"
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
                    {hasActions ? (
                      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/memory-item:opacity-100">
                        {onUpdateMemory
                          ? renderAction(
                              "edit",
                              <PencilIcon className="size-3.5" />,
                              intl.formatMessage({ id: "chat.toolbar.memory.edit" }),
                              () => void openEditOrDuplicate(entry.id, "edit"),
                            )
                          : null}
                        {onCreateMemory
                          ? renderAction(
                              "duplicate",
                              <CopyIcon className="size-3.5" />,
                              intl.formatMessage({ id: "chat.toolbar.memory.duplicate" }),
                              () => void openEditOrDuplicate(entry.id, "duplicate"),
                            )
                          : null}
                        {onDeleteMemory
                          ? renderAction(
                              "delete",
                              <TrashIcon className="size-3.5" />,
                              intl.formatMessage({ id: "chat.toolbar.memory.delete" }),
                              () => handleOpenDelete(entry.id),
                            )
                          : null}
                      </span>
                    ) : null}
                  </DropdownMenuCheckboxItem>
                );
              })
            )}
          </div>
        </DropdownMenuContent>
        {hover ? renderDetailPanel(hover) : null}
      </DropdownMenu>
      {/* 快速增删改弹层：条件挂载（key 驱动会话重置），与菜单互斥（打开前菜单已关）。 */}
      {memoryDialog && memoryDialog.kind !== "delete" ? (
        <V4ComposerMemoryEditDialog
          key={`memory-dialog-${dialogSession}`}
          title={
            memoryDialog.kind === "edit"
              ? intl.formatMessage({ id: "chat.toolbar.memory.dialogTitleEdit" })
              : intl.formatMessage({ id: "chat.toolbar.memory.dialogTitleCreate" })
          }
          initial={dialogDraft}
          requireName={memoryDialog.kind !== "edit"}
          onSave={handleDialogSave}
          onClose={handleDialogClose}
        />
      ) : null}
      {memoryDialog?.kind === "delete" ? (
        <V4ComposerMemoryDeleteDialog
          key={`memory-dialog-${dialogSession}`}
          name={deleteEntry ? displayName(deleteEntry) : memoryDialog.id}
          onConfirm={handleDeleteConfirm}
          onClose={handleDialogClose}
        />
      ) : null}
    </>
  );
}

export const V4ComposerMemoryPicker = memo(V4ComposerMemoryPickerImpl);
