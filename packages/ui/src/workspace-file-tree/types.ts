import type { EditorInfo, OpenInEditorRemoteTarget } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkspaceFileGitStatus, WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";

export interface WorkspaceFileTreeProps {
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
  canOpenLocalFileManager?: boolean;
  activePreviewPath?: string | null;
  /** 覆盖层场景（Sidebar slide-over）传入以渲染「返回任务」；Side Pane tab 场景省略。 */
  onClose?: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenPreview?: (source: CodeViewerSource) => void;
}

export interface WorkspaceFileTreeWatcherRegistration {
  id: string;
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export interface WorkspaceFileTreeStickyFolderItem {
  row: WorkspaceFileTreeRow;
  index: number;
}

export interface WorkspaceFileTreeContextMenuLabels {
  addToChat: string;
  copyAbsolutePath: string;
  copyRelativePath: string;
  delete: string;
  newFile: string;
  newFolder: string;
  open: string;
  openInBrowser: string;
  openFailed: string;
  openWith: string;
  rename: string;
  reveal: string;
}

/** 行内编辑会话：create 注入草稿行，rename 复用目标行；组件本地 state。 */
export interface WorkspaceFileTreeEditingSession {
  mode: "create-file" | "create-directory" | "rename";
  /** create：目标父目录绝对路径 */
  parentPath?: string;
  /** rename：被改名条目路径 */
  targetPath?: string;
  /** create：注入草稿行的占位 path */
  draftPath?: string;
  kind: "file" | "directory";
  /** rename 的初始值；create 为空串 */
  initialName: string;
}

/** 文件操作相关 props 打包，List/StickyFolders 一层透传给 RowView。 */
export interface WorkspaceFileTreeFileOps {
  editingSession: WorkspaceFileTreeEditingSession | null;
  /** 搜索/过滤态下新建与改名入口禁用，避免草稿行落在错误的可见集里。 */
  editingDisabled: boolean;
  editingInvalidMessage: string;
  onStartEditing: (session: WorkspaceFileTreeEditingSession) => void;
  onRequestDelete: (row: WorkspaceFileTreeRow) => void;
  /** commit/cancel 绑定输入框持有的 session 实例，防止会话被替换后旧输入误提交。 */
  onCommitEditing: (session: WorkspaceFileTreeEditingSession, name: string) => void;
  onCancelEditing: (session: WorkspaceFileTreeEditingSession) => void;
  onEditingInvalid: (message: string) => void;
}

export interface WorkspaceFileTreeEditorState {
  workspaceRemoteSessionId?: string;
  canOpenLocalFileManager: boolean;
  installedEditors: EditorInfo[];
  isRemoteWorkspaceFileTree: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
  /** 用户偏好：单击本地 .html 文件时进内置浏览器，而不是源码预览 */
  htmlClickOpensBrowser?: boolean;
}

export type WorkspaceFileGitStatusLabels = Record<WorkspaceFileGitStatus, string>;
