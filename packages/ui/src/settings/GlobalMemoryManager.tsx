import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, InfoIcon, Plus, Trash2 } from "lucide-react";
import {
  GLOBAL_MEMORY_DEFAULT_ID,
  type GlobalMemoryEntryMeta,
  type IMemoryService,
} from "@zcode/services";
import {
  TID_SETTINGS_GLOBAL_MEMORY_CREATE,
  TID_SETTINGS_GLOBAL_MEMORY_DELETE,
  TID_SETTINGS_GLOBAL_MEMORY_LIST,
  TID_SETTINGS_GLOBAL_MEMORY_PROMPT_INFO,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { GlobalMemoryCreateForm } from "@/settings/GlobalMemoryCreateForm.js";
import { GlobalMemoryEditor } from "@/settings/GlobalMemoryEditor.js";

type GlobalMemoryManagerService = Pick<
  IMemoryService,
  | "listGlobalMemories"
  | "readGlobalMemory"
  | "writeGlobalMemory"
  | "createGlobalMemory"
  | "deleteGlobalMemory"
>;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUpdatedAt(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

/**
 * 全局记忆管理器：目录下多条 Markdown 记忆的列表/新建/删除/编辑承载。
 * 列表排序由服务层保证（default 固定首位）；选中行展开 GlobalMemoryEditor。
 * 2026-10-26 起总开关移除（全局记忆默认常开、不可关闭），不再有 disabled 门控。
 */
export function GlobalMemoryManager({
  memoryService,
}: {
  memoryService: GlobalMemoryManagerService;
}) {
  const { intl } = useZCodeIntl();
  const [entries, setEntries] = useState<readonly GlobalMemoryEntryMeta[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GlobalMemoryEntryMeta | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const listRequestRef = useRef(0);

  const displayName = useCallback(
    // 修复：服务层在无自定义 name 时把 name 回退为 id。default 允许改名（frontmatter
    // name 已持久化），本地化"默认"只应作未命名回退，不能覆盖已存的自定义名。
    (entry: GlobalMemoryEntryMeta): string =>
      entry.id === GLOBAL_MEMORY_DEFAULT_ID && entry.name === entry.id
        ? intl.formatMessage({ id: "settings.memory.global.defaultName" })
        : entry.name,
    [intl],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    setListLoading(true);
    try {
      const result = await memoryService.listGlobalMemories();
      if (listRequestRef.current !== requestId) return;
      setEntries(result);
      setSelectedId((current) =>
        current !== null && result.some((entry) => entry.id === current)
          ? current
          : (result[0]?.id ?? null),
      );
    } catch (error) {
      if (listRequestRef.current !== requestId) return;
      logger.warn("[GlobalMemoryManager] 读取全局记忆列表失败", {
        error: getErrorMessage(error),
      });
      toast(intl.formatMessage({ id: "settings.memory.global.loadFailed" }));
    } finally {
      if (listRequestRef.current === requestId) {
        setListLoading(false);
      }
    }
  }, [intl, memoryService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = useCallback(
    async (draft: { name: string; description: string; content: string }) => {
      if (creatingBusy) return;
      const name = draft.name.trim();
      if (!name) return;
      setCreatingBusy(true);
      try {
        const created = await runUserActionAsync({
          input: {
            featureId: "settings.memory",
            action: "create_global_memory",
            trigger: "button",
          },
          operation: async () => {
            return await memoryService.createGlobalMemory({
              name,
              ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
              ...(draft.content ? { content: draft.content } : {}),
            });
          },
          completed: { resultSource: "platform_result" },
          failureStage: "global_memory_create",
        });
        setCreating(false);
        await refresh();
        setSelectedId(created.id);
        toast(intl.formatMessage({ id: "settings.memory.global.created" }));
      } catch (error) {
        logger.warn("[GlobalMemoryManager] 创建全局记忆失败", {
          error: getErrorMessage(error),
        });
        toast(intl.formatMessage({ id: "settings.memory.global.createFailed" }));
      } finally {
        setCreatingBusy(false);
      }
    },
    [creatingBusy, intl, memoryService, refresh],
  );

  const handleDelete = useCallback(async () => {
    const target = deleteTarget;
    if (!target || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await runUserActionAsync({
        input: {
          featureId: "settings.memory",
          action: "delete_global_memory",
          trigger: "button",
        },
        operation: async () => {
          await memoryService.deleteGlobalMemory({ id: target.id });
        },
        completed: { resultSource: "platform_result" },
        failureStage: "global_memory_delete",
      });
      setDeleteTarget(null);
      await refresh();
      toast(intl.formatMessage({ id: "settings.memory.global.deleted" }));
    } catch (error) {
      logger.warn("[GlobalMemoryManager] 删除全局记忆失败", {
        error: getErrorMessage(error),
      });
      toast(intl.formatMessage({ id: "settings.memory.global.deleteFailed" }));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, deleteBusy, intl, memoryService, refresh]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );

  return (
    <div className="space-y-3 px-4 py-3" data-testid={TID_SETTINGS_GLOBAL_MEMORY_LIST}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage(
              { id: "settings.memory.global.count" },
              { count: String(entries.length) },
            )}
          </span>
          <ControlHintTooltip
            title={intl.formatMessage({ id: "settings.memory.global.promptInfo" })}
            side="bottom"
            align="start"
          >
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "settings.memory.global.promptInfoTitle" })}
              data-testid={TID_SETTINGS_GLOBAL_MEMORY_PROMPT_INFO}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground"
            >
              <InfoIcon className="size-3.5" aria-hidden="true" />
            </button>
          </ControlHintTooltip>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={creating}
          data-testid={TID_SETTINGS_GLOBAL_MEMORY_CREATE}
          onClick={() =>
            runUserAction({
              input: {
                featureId: "settings.memory",
                action: "open_global_memory_create",
                trigger: "button",
              },
              operation: () => setCreating(true),
              completed: { resultSource: "local_commit" },
              failureStage: "local_commit",
            })
          }
        >
          <Plus className="size-4" />
          {intl.formatMessage({ id: "settings.memory.global.create" })}
        </Button>
      </div>

      {listLoading ? (
        <div className="py-4 text-center text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "common.loading" })}
        </div>
      ) : entries.length === 0 ? (
        <div className="py-4 text-center text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.memory.global.listEmpty" })}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {entries.map((entry) => {
            // 新建时列表不保留选中态：此时编辑对象是新建表单，旧条目高亮会误导。
            const selected = !creating && entry.id === selectedId;
            const updatedAt = formatUpdatedAt(entry.updatedAt);
            return (
              <li key={entry.id}>
                <div
                  className={cn(
                    "flex items-center gap-2 px-3 py-2",
                    selected ? "bg-accent/60" : "hover:bg-accent/40",
                    "cursor-pointer",
                  )}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  data-testid={`${TID_SETTINGS_GLOBAL_MEMORY_LIST}-item-${entry.id}`}
                  onClick={() =>
                    runUserAction({
                      input: {
                        featureId: "settings.memory",
                        action: "select_global_memory",
                        trigger: "select",
                      },
                      operation: () => {
                        // 新建中点击条目视为放弃新建（草稿不保留），避免出现
                        // "表单打开但选中态被隐藏"的死点击。
                        setCreating(false);
                        setSelectedId(selected ? null : entry.id);
                      },
                      completed: { resultSource: "local_commit" },
                      failureStage: "local_commit",
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setCreating(false);
                      setSelectedId(selected ? null : entry.id);
                    }
                  }}
                >
                  <Brain className="size-4 shrink-0 text-foreground-subtle" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 truncate text-ui-base font-medium text-foreground">
                        {displayName(entry)}
                      </span>
                      {entry.description ? (
                        <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                          {entry.description}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-ui-xs text-foreground-subtlest">
                      {intl.formatMessage(
                        { id: "settings.memory.global.rowMeta" },
                        {
                          chars: String(entry.chars),
                          updatedAt: updatedAt ?? "-",
                        },
                      )}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={intl.formatMessage({ id: "settings.memory.global.delete" })}
                    data-testid={`${TID_SETTINGS_GLOBAL_MEMORY_DELETE}-${entry.id}`}
                    className="size-7 shrink-0 text-foreground-subtle hover:text-destructive"
                    onClick={(event) => {
                      event.stopPropagation();
                      runUserAction({
                        input: {
                          featureId: "settings.memory",
                          action: "open_global_memory_delete",
                          trigger: "button",
                        },
                        operation: () => setDeleteTarget(entry),
                        completed: { resultSource: "local_commit" },
                        failureStage: "local_commit",
                      });
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {creating ? (
        <GlobalMemoryCreateForm
          busy={creatingBusy}
          onSubmit={(draft) => void handleCreate(draft)}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      {selectedEntry && !creating ? (
        <GlobalMemoryEditor
          key={selectedEntry.id}
          memoryService={memoryService}
          memoryId={selectedEntry.id}
          onSaved={() => void refresh()}
        />
      ) : null}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.memory.global.deleteConfirmTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage(
                { id: "settings.memory.global.deleteConfirmDescription" },
                { name: deleteTarget ? displayName(deleteTarget) : "" },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteBusy}
              data-testid={`${TID_SETTINGS_GLOBAL_MEMORY_DELETE}-confirm`}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {intl.formatMessage({ id: "settings.memory.global.delete" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
