import { useMemo } from "react";
import { Cloud, LoaderIcon } from "lucide-react";
import type { WindowHostControllerTaskListItem } from "@zcode/services";
import {
  TID_HEADER_RUNNING_TASK,
  TID_HEADER_RUNNING_TASKS,
  TID_HEADER_RUNNING_TASKS_OVERFLOW,
  testId,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import {
  getTaskListAttention,
  getTaskListRowActivity,
  isTaskListRowRunning,
  type TaskListMetaWithActivity,
} from "@/v4/taskListRowActivity.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

/** Header 直接铺开的会话图标数上限；运行中会话超出上限的部分收进 +N 折叠菜单。 */
export const HEADER_RUNNING_TASKS_MAX_VISIBLE = 6;

type HeaderTaskItem = WindowHostControllerTaskListItem & Partial<TaskListMetaWithActivity>;

/**
 * Header 指示条的槽位分配：与侧栏转圈同一语义（sessions-index 实时 phase），
 * 离线远程 source 的冻结快照不计入——断连时 lastActivityAt 不再推进，转圈会误导。
 * 运行中会话优先占槽；槽位富余时按列表顺序（updatedAt 排序）用最近会话补齐，
 * 让指示条始终保持满槽，只有整个集合为空才隐藏。
 */
export function selectHeaderIndicatorTasks(
  items: readonly WindowHostControllerTaskListItem[],
  maxVisible: number,
): { visible: HeaderTaskItem[]; overflow: HeaderTaskItem[] } {
  const online = items.filter(
    (item): item is HeaderTaskItem => item.sourceAvailability === "online",
  );
  const running = online.filter(isTaskListRowRunning);
  const limit = Math.max(0, maxVisible);
  if (running.length >= limit) {
    return { visible: running.slice(0, limit), overflow: running.slice(limit) };
  }
  // Bugfix-context: 用户要求指示条常显——running 占不满时用最近会话补位，
  // 补齐项不参与 +N 折叠（完整列表在侧栏），因此 overflow 只来自运行中超额部分。
  const backfill = online
    .filter((item) => !isTaskListRowRunning(item))
    .slice(0, limit - running.length);
  return { visible: [...running, ...backfill], overflow: [] };
}

/** 会话等待权限/输入时 phase 仍是 running；用它切换 warning 色与 tooltip 等待标签。 */
export function isHeaderRunningTaskWaiting(item: HeaderTaskItem): boolean {
  return getTaskListAttention(item) !== null;
}

export function WorkspaceRunningTaskIndicators({
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  onSelectTask,
  useWindowsCaptionSpacing = false,
}: {
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId?: string | null;
  onSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
    remoteSessionId?: string,
  ) => void;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const tabs = useOptionalTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const runningTaskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 1,
  });
  const { visible, overflow } = useMemo(
    () => selectHeaderIndicatorTasks(runningTaskList.items, HEADER_RUNNING_TASKS_MAX_VISIBLE),
    [runningTaskList.items],
  );
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        workspaceTabs.map((tab) => [
          buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
          tab.label,
        ]),
      ),
    [workspaceTabs],
  );
  const activeWorkspaceKey = buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity);

  if (visible.length === 0) {
    return null;
  }

  const renderTooltipContent = (task: HeaderTaskItem) => {
    const taskTitle =
      task.title ||
      intl.formatMessage({
        id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
      });
    const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    const workspaceLabel =
      workspaceKey !== activeWorkspaceKey ? workspaceLabelByKey.get(workspaceKey) : undefined;
    const attention = getTaskListAttention(task);
    const attentionLabel = attention
      ? intl.formatMessage({
          id: attention.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
        })
      : null;
    return (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="min-w-0 break-words">{taskTitle}</span>
        {workspaceLabel ? (
          <span className="flex min-w-0 items-center gap-1 text-foreground-subtle">
            {task.workspaceIdentity?.trim() ? (
              <Cloud aria-hidden="true" className="size-3 shrink-0" />
            ) : null}
            <span className="min-w-0 truncate">{workspaceLabel}</span>
          </span>
        ) : null}
        {attentionLabel ? (
          <span className="text-warning">{attentionLabel}</span>
        ) : isTaskListRowRunning(task) ? (
          <span className="text-foreground-subtle">
            {intl.formatMessage({ id: "taskList.status.streaming" })}
          </span>
        ) : (
          <span className="text-foreground-subtlest">
            {formatTaskRelativeTime(task.updatedAt, intl)}
          </span>
        )}
      </span>
    );
  };

  const renderSpinner = (task: HeaderTaskItem, className?: string) => (
    <LoaderIcon
      aria-hidden="true"
      className={cn(
        className,
        "animate-spin",
        isHeaderRunningTaskWaiting(task) ? "text-warning" : "text-foreground-subtle",
      )}
    />
  );

  // 补齐槽位的非运行会话用静态状态点，与侧栏 deriveTaskLeadingIndicator 同一语义：
  // error 红点 / unread 蓝点 / 普通灰点；不旋转，避免被误当成还在执行。
  const renderStatusDot = (task: HeaderTaskItem, className?: string) => {
    const indicator = deriveTaskLeadingIndicator(task, getTaskListRowActivity(task));
    const dotClass =
      indicator === "error"
        ? "bg-destructive"
        : indicator === "unread"
          ? "bg-sky-500 dark:bg-sky-400"
          : "bg-foreground-subtlest";
    return (
      <span
        aria-hidden="true"
        className={cn("flex size-4 shrink-0 items-center justify-center", className)}
      >
        <span className={cn("size-2 rounded-full", dotClass)} />
      </span>
    );
  };

  return (
    <div
      data-testid={TID_HEADER_RUNNING_TASKS}
      className="flex shrink-0 items-center gap-0.5 [app-region:no-drag]"
    >
      {visible.map((task) => {
        const entityKey = buildTaskEntityKey(task);
        const isActive =
          buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) ===
            activeWorkspaceKey && task.taskId === activeTaskId;
        return (
          <ControlHintTooltip key={entityKey} side="bottom" title={renderTooltipContent(task)}>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              data-testid={testId(TID_HEADER_RUNNING_TASK, entityKey)}
              aria-label={task.title || intl.formatMessage({ id: "taskList.untitled" })}
              className={cn(
                "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
                useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
                isActive && "!bg-selected",
              )}
              onClick={() =>
                onSelectTask(
                  task.workspacePath,
                  task.taskId,
                  task.workspaceIdentity,
                  task.remoteSessionId,
                )
              }
            >
              {isTaskListRowRunning(task) ? renderSpinner(task, "size-4") : renderStatusDot(task)}
            </Button>
          </ControlHintTooltip>
        );
      })}
      {overflow.length > 0 ? (
        <DropdownMenu>
          <ControlHintTooltip
            side="bottom"
            title={intl.formatMessage(
              { id: "appHeader.moreRunningTasks" },
              { count: String(overflow.length) },
            )}
          >
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                data-testid={TID_HEADER_RUNNING_TASKS_OVERFLOW}
                aria-label={intl.formatMessage(
                  { id: "appHeader.moreRunningTasks" },
                  { count: String(overflow.length) },
                )}
                className={cn(
                  "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
                  useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
                )}
              >
                <span className="text-ui-xs font-medium">+{overflow.length}</span>
              </Button>
            </DropdownMenuTrigger>
          </ControlHintTooltip>
          <DropdownMenuContent align="end" className="w-64">
            {overflow.map((task) => {
              const entityKey = buildTaskEntityKey(task);
              const workspaceKey = buildTaskWorkspaceKey(
                task.workspacePath,
                task.workspaceIdentity,
              );
              const workspaceLabel =
                workspaceKey !== activeWorkspaceKey
                  ? workspaceLabelByKey.get(workspaceKey)
                  : undefined;
              return (
                <DropdownMenuItem
                  key={entityKey}
                  data-testid={testId(TID_HEADER_RUNNING_TASK, entityKey)}
                  onSelect={() =>
                    onSelectTask(
                      task.workspacePath,
                      task.taskId,
                      task.workspaceIdentity,
                      task.remoteSessionId,
                    )
                  }
                >
                  {renderSpinner(task, "size-3.5 shrink-0")}
                  <span className="min-w-0 flex-1 truncate">
                    {task.title || intl.formatMessage({ id: "taskList.untitled" })}
                  </span>
                  {workspaceLabel ? (
                    <span className="ml-auto flex min-w-0 max-w-24 shrink-0 items-center gap-1 truncate text-ui-xs text-foreground-subtle">
                      {task.workspaceIdentity?.trim() ? (
                        <Cloud aria-hidden="true" className="size-3 shrink-0" />
                      ) : null}
                      <span className="truncate">{workspaceLabel}</span>
                    </span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {/* 与右侧功能图标组之间留一条细分隔，提示这一排是会话指示而非面板开关。 */}
      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border/70" />
    </div>
  );
}
