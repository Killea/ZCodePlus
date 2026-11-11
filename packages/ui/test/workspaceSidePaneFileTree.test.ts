import { describe, expect, it } from "vitest";
import {
  closeSidePaneTab,
  getActiveSidePaneTab,
  navigateFileManagerSidePane,
  openFileManagerSidePane,
  restoreSidePaneTab,
  stampSidePaneTabsOwnership,
  toggleFileManagerSidePane,
  type FileManagerTarget,
  type WorkspaceSidePaneState,
} from "../src/lib/workspaceSidePane.js";

const TARGET: FileManagerTarget = { workspacePath: "/repo/ws-1" };

// App 层 commitOpenedSidePaneState 在写入时统一冻结归属；测试里同样显式打标，
// 保持与生产路径一致（workspaceKey 缺失的 tab 会被视为跨 workspace 可见）。
function createTerminalState(): WorkspaceSidePaneState {
  return stampSidePaneTabsOwnership(
    {
      tabs: [
        {
          id: "terminal:1",
          type: "terminal",
          title: "Terminal 1",
        },
      ],
      activeTabId: "terminal:1",
    },
    { ownerTaskId: "task-a", workspaceKey: "ws-1" },
  )!;
}

describe("workspaceSidePane file-manager", () => {
  it("openFileManagerSidePane 从空状态创建 file-manager tab 并激活", () => {
    const next = openFileManagerSidePane(null, TARGET)!;
    expect(next.tabs.length).toBe(1);
    expect(next.tabs.map((tab) => tab.type)).toEqual(["file-manager"]);
    expect(next.activeTabId).toBe(next.tabs[0]!.id);
    const tab = next.tabs[0]!;
    if (tab.type !== "file-manager") throw new Error("expected file-manager tab");
    expect(tab.target.workspacePath).toBe("/repo/ws-1");
  });

  it("openFileManagerSidePane 保留既有 tab 并把 file-manager 激活", () => {
    const next = openFileManagerSidePane(createTerminalState(), TARGET)!;
    expect(next.tabs.length).toBe(2);
    expect(next.tabs.some((tab) => tab.id === "terminal:1")).toBeTruthy();
    expect(getActiveSidePaneTab(next)?.type).toBe("file-manager");
  });

  it("toggleFileManagerSidePane：file-manager 激活时关闭它；否则激活", () => {
    const opened = toggleFileManagerSidePane(createTerminalState(), TARGET);
    expect(opened).toBeTruthy();
    expect(getActiveSidePaneTab(opened)?.type).toBe("file-manager");

    const closed = toggleFileManagerSidePane(opened, TARGET);
    // file-manager 是唯一被关闭的 tab，剩余 terminal tab 继续存活。
    expect(closed).toBeTruthy();
    expect(closed!.tabs.map((tab) => tab.id)).toEqual(["terminal:1"]);

    const onlyFileManager = openFileManagerSidePane(null, TARGET);
    // 关掉最后一个 tab 时整个面板状态归 null（收起）。
    expect(toggleFileManagerSidePane(onlyFileManager, TARGET)).toBe(null);
  });

  it("navigateFileManagerSidePane 只更新目标 tab 的 source，不激活其他 tab", () => {
    const opened = openFileManagerSidePane(createTerminalState(), TARGET)!;
    const fileManagerTab = opened.tabs.find((tab) => tab.type === "file-manager")!;
    const source = { type: "file", title: "a.xlsx", path: "/repo/ws-1/a.xlsx" } as never;
    const navigated = navigateFileManagerSidePane(opened, fileManagerTab.id, source)!;
    const updated = navigated.tabs.find((tab) => tab.id === fileManagerTab.id)!;
    if (updated.type !== "file-manager") throw new Error("expected file-manager tab");
    expect(updated.source).toEqual(source);
    // 导航不改变实例 id 和 activeTabId。
    expect(navigated.activeTabId).toBe(opened.activeTabId);
    expect(updated.id).toBe(fileManagerTab.id);
  });

  it("closeSidePaneTab / restoreSidePaneTab 对 file-manager 走通用路径", () => {
    const opened = openFileManagerSidePane(null, TARGET)!;
    const fileManagerTab = opened.tabs[0]!;
    const closed = closeSidePaneTab(opened, fileManagerTab.id);
    expect(closed).toBe(null);

    const restored = restoreSidePaneTab(closed, fileManagerTab)!;
    expect(restored.activeTabId).toBe(fileManagerTab.id);
    expect(getActiveSidePaneTab(restored)?.type).toBe("file-manager");
  });
});
