import { beforeEach, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
  buildTaskWorkspaceKey,
} from "../src/lib/taskQueryCache.js";
import {
  applyTaskQueryCacheMutation,
  useTaskQueryCacheStore,
} from "../src/store/taskQueryCacheStore.js";

const WS_A = "/ws/project-a";

function makeTask(taskId: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  const { workspacePath, ...rest } = overrides;
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: `Task ${taskId}`,
    workspacePath: workspacePath ?? WS_A,
    createdAt: 1000,
    updatedAt: 1000,
    mode: "build",
    ...rest,
  };
}

function workspaceDescriptor(visibleLimit: number | null = null) {
  return buildTaskListCacheDescriptor({
    kind: "workspace",
    workspaceScopes: [{ workspacePath: WS_A }],
    sortBy: "created",
    expanded: visibleLimit === null,
    visibleLimit,
  });
}

function seedWorkspaceQuery(
  items: ZCodeTaskMeta[],
  options: { visibleLimit?: number; pinnedTaskKeys?: string[]; total?: number } = {},
) {
  const descriptor = workspaceDescriptor(options.visibleLimit ?? null);
  const queryKey = buildTaskListCacheKeyFromDescriptor(descriptor);
  useTaskQueryCacheStore.getState().setQueryResult({
    queryKey,
    descriptor,
    items,
    total: options.total ?? items.length,
    hasMore: false,
    ...(options.pinnedTaskKeys ? { pinnedTaskKeys: options.pinnedTaskKeys } : {}),
  });
  return { descriptor, queryKey };
}

function cachedResult(queryKey: string) {
  const result = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];
  expect(result).toBeTruthy(`cached result missing for ${queryKey}`);
  return result;
}

beforeEach(() => {
  useTaskQueryCacheStore.getState().clearAll();
});

it("workspace 查询内 pin：行留在项目缓存、落到最前、pinnedTaskKeys 同步", () => {
  const t1 = makeTask("t-1", { createdAt: 100 });
  const t2 = makeTask("t-2", { createdAt: 200 });
  const t3 = makeTask("t-3", { createdAt: 300 });
  const { queryKey } = seedWorkspaceQuery([t1, t2, t3], { pinnedTaskKeys: [] });

  applyTaskQueryCacheMutation({
    previousTask: t3,
    nextTask: t3,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: true, archived: false },
  });

  const result = cachedResult(queryKey);
  const t3Key = buildTaskEntityKey(t3);
  expect(result.taskKeys[0]).toBe(t3Key, "置顶任务应排在项目列表最前");
  expect(result.taskKeys.length).toBe(3, "置顶后行仍留在项目查询内");
  expect(result.pinnedTaskKeys).toEqual([t3Key]);
  expect(result.total).toBe(3);
});

it("workspace 查询内 unpin：行留在项目缓存、回到常规排序位置", () => {
  const t1 = makeTask("t-1", { createdAt: 200 });
  const t2 = makeTask("t-2", { createdAt: 300 });
  // 被置顶的任务 createdAt 最老，unpin 后按 created 降序落回列表末尾。
  const tPinned = makeTask("t-pinned", { createdAt: 100 });
  const pinnedKey = buildTaskEntityKey(tPinned);
  const { queryKey } = seedWorkspaceQuery([tPinned, t1, t2], {
    pinnedTaskKeys: [pinnedKey],
  });

  applyTaskQueryCacheMutation({
    previousTask: tPinned,
    nextTask: tPinned,
    previousState: { pinned: true, archived: false },
    nextState: { pinned: false, archived: false },
  });

  const result = cachedResult(queryKey);
  expect(result.taskKeys.length).toBe(3);
  expect(result.pinnedTaskKeys).toEqual([]);
  // created 降序：t-2, t-1, t-pinned。
  expect(result.taskKeys.map((key) => key.split("::")[1])).toEqual(["t-2", "t-1", "t-pinned"]);
});

it("低于可见窗口的任务被置顶时：被提升到 taskKeys 顶部并挤出末位", () => {
  // visibleLimit=2：缓存只留两个可见 key，第三个任务在窗口外但归属仍命中 workspace。
  const t1 = makeTask("t-1", { createdAt: 100 });
  const t2 = makeTask("t-2", { createdAt: 200 });
  const tHidden = makeTask("t-hidden", { createdAt: 300 });
  const { queryKey } = seedWorkspaceQuery([t1, t2], {
    visibleLimit: 2,
    pinnedTaskKeys: [],
    total: 3,
  });
  // t-hidden 的 meta 需要先在实体缓存里，mutation 才能排序。
  useTaskQueryCacheStore.getState().upsertTaskMeta(tHidden);

  applyTaskQueryCacheMutation({
    previousTask: tHidden,
    nextTask: tHidden,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: true, archived: false },
  });

  const result = cachedResult(queryKey);
  const hiddenKey = buildTaskEntityKey(tHidden);
  expect(result.taskKeys[0]).toBe(hiddenKey, "置顶任务应被提升到窗口首位");
  expect(result.taskKeys.length).toBe(2, "窗口上限不变，末位常规任务被挤出");
  expect(result.pinnedTaskKeys).toEqual([hiddenKey]);
});

it("pin 同时把任务纳入 pinned-kind 查询缓存，两个列表各自归属正确", () => {
  const t1 = makeTask("t-1");
  const { queryKey: workspaceKey } = seedWorkspaceQuery([t1], { pinnedTaskKeys: [] });
  const pinnedDescriptor = buildTaskListCacheDescriptor({
    kind: "pinned",
    workspaceScopes: [{ workspacePath: WS_A }],
    sortBy: "created",
    expanded: true,
  });
  const pinnedQueryKey = buildTaskListCacheKeyFromDescriptor(pinnedDescriptor);
  useTaskQueryCacheStore.getState().setQueryResult({
    queryKey: pinnedQueryKey,
    descriptor: pinnedDescriptor,
    items: [],
    total: 0,
    hasMore: false,
  });

  applyTaskQueryCacheMutation({
    previousTask: t1,
    nextTask: t1,
    previousState: { pinned: false, archived: false },
    nextState: { pinned: true, archived: false },
  });

  expect(cachedResult(workspaceKey).taskKeys.includes(buildTaskEntityKey(t1))).toBeTruthy(
    "workspace 查询保留该任务（项目内置顶）",
  );
  expect(cachedResult(pinnedQueryKey).taskKeys.includes(buildTaskEntityKey(t1))).toBeTruthy(
    "pinned-kind 查询（timeline/grouped 视图的全局区）同样收录该任务",
  );
});

it("removeTask 同步清理 pinnedTaskKeys", () => {
  const tPinned = makeTask("t-pinned");
  const pinnedKey = buildTaskEntityKey(tPinned);
  const { queryKey } = seedWorkspaceQuery([tPinned], { pinnedTaskKeys: [pinnedKey] });

  const removed = useTaskQueryCacheStore.getState().removeTask(tPinned);
  expect(removed).toBe(true);
  const result = cachedResult(queryKey);
  expect(result.taskKeys).toEqual([]);
  expect(result.pinnedTaskKeys).toEqual([]);
});
