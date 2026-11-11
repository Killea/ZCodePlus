import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent } from "@/lib/composerRecent.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

type RecentLike = ReturnType<typeof readComposerRecent>;

// 节点环境无 window.localStorage，Recent 统一经注入的 mock 控制。
vi.mock("@/lib/composerRecent.js", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/composerRecent.js")>("@/lib/composerRecent.js");
  return {
    ...actual,
    readComposerRecent: vi.fn(),
  };
});

const view = {} as ModelSelectionView;
const baseDraft: V4ComposerDraft = { text: "", updatedAt: 0 };

function setRecent(recent: RecentLike): void {
  vi.mocked(readComposerRecent).mockReturnValue(recent);
}

describe("新任务草稿模式种子（docs/composer-default-mode.md）", () => {
  beforeEach(() => {
    setRecent(null);
  });

  it("无 Recent + 设置 yolo → 按设置起稿", () => {
    expect(initializeNewTaskDraft(baseDraft, "/repo", undefined, view, "yolo").mode).toBe("yolo");
  });

  it("无 Recent + 设置 build → 按设置起稿（尊重用户显式改回）", () => {
    expect(initializeNewTaskDraft(baseDraft, "/repo", undefined, view, "build").mode).toBe("build");
  });

  it("无 Recent + 未传设置 → 回落 build（防御性兜底）", () => {
    expect(initializeNewTaskDraft(baseDraft, "/repo", undefined, view).mode).toBe("build");
  });

  it("Recent 覆盖设置：最近一次显式提交优先", () => {
    setRecent({ mode: "build" });
    expect(initializeNewTaskDraft(baseDraft, "/repo", undefined, view, "yolo").mode).toBe("build");
  });

  it("Recent 覆盖设置（反向）", () => {
    setRecent({ mode: "yolo" });
    expect(initializeNewTaskDraft(baseDraft, "/repo", undefined, view, "build").mode).toBe("yolo");
  });

  it("Recent 为 plan → 归一 build，不继承勾选档", () => {
    setRecent({ mode: "plan" });
    expect(initializeNewTaskDraft(baseDraft, "/repo", undefined, view, "yolo").mode).toBe("build");
  });

  it("Recent 只带模型不带模式 → 按设置起稿", () => {
    setRecent({ modelSelection: { providerId: "p", modelId: "m" } });
    expect(initializeNewTaskDraft(baseDraft, "/repo", undefined, view, "guarded").mode).toBe(
      "guarded",
    );
  });

  it("历史 edit 值透传（隐藏候选不删除历史值）", () => {
    setRecent({ mode: "edit" });
    expect(initializeNewTaskDraft(baseDraft, "/repo", undefined, view, "yolo").mode).toBe("edit");
  });

  it("初始化同时清空 planEnabled 标记", () => {
    const result = initializeNewTaskDraft(
      { ...baseDraft, planEnabled: true },
      "/repo",
      undefined,
      view,
      "yolo",
    );
    expect(result.planEnabled).toBe(false);
  });
});
