import type { ZCodeDefaultSessionMode } from "@zcode/shared";
import type { ComposerInitialConfig } from "@/store/zcodeSessionStoreTypes.js";
import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
  type ComposerScope,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  defaultSessionMode?: ZCodeDefaultSessionMode,
  scope?: ComposerScope,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity, undefined, scope);
  // 种子优先级（docs/composer-default-mode.md）：Recent（本 workspace 最近一次显式提交）
  // > 缺省模式设置（fork 缺省 yolo）> build。Recent 不得被设置覆盖。
  return {
    ...draft,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? defaultSessionMode ?? "build"),
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
  };
}

/** 首次导入由导航动作显式传参；复用历史或已有文字草稿不覆盖。 */
export function resolveImportedComposerConfig(
  result: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    reused: boolean;
  },
  clientNamespace = "desktop",
): ComposerInitialConfig | undefined {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return undefined;
  const scope =
    readComposerWorkspaceScope(workspacePath, workspaceIdentity, clientNamespace) ??
    resolveComposerScope(null, workspaceIdentity, clientNamespace);
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  return root?.mode
    ? {
        mode: root.mode,
        planEnabled: root.planEnabled ?? false,
        modelSelection: root.modelSelection,
      }
    : {};
}
