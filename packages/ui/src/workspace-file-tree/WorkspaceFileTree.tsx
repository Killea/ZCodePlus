import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
/* eslint-disable max-lines -- WorkspaceFileTree 需要集中编排数据、虚拟列表、吸顶和入口操作状态。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  ArrowLeft,
  Copy,
  Ellipsis,
  FilePlus,
  FolderOpen,
  FolderPlus,
  GitCommitVertical,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/components/lib/utils.js";
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
import { Input } from "@/components/ui/input.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
} from "@zcode/shared/test-ids";
import {
  areWorkspaceFilePathsEqual,
  createCodeViewerSourceForWorkspaceFile,
  getWorkspaceFileGitStatus,
  getWorkspaceFileAncestorDirectories,
  getWorkspaceFileDirectoryChildDepth,
  filterWorkspaceFileTreeRows,
  isWorkspaceFileTreeDeletedFile,
  isWorkspaceFilePathInside,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";
import { getContainingDirectoryPath, getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/workspace-file-tree/constants.js";
import { getFileManagerLabel } from "@/workspace-file-tree/helpers.js";
import { useInstalledFileTreeEditors } from "@/workspace-file-tree/useInstalledFileTreeEditors.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import {
  resolveWorkspaceEditorSelection,
  resolveWorkspaceFileManagerEditor,
} from "@/lib/workspaceEditorSelection.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceFileTreeData } from "@/workspace-file-tree/useWorkspaceFileTreeData.js";
import { useWorkspaceFileTreeStickyFolders } from "@/workspace-file-tree/useWorkspaceFileTreeStickyFolders.js";
import {
  useWorkspaceFileSearchIndex,
  useWorkspaceFileSearchResults,
} from "@/workspace-file-tree/useWorkspaceFileSearchIndex.js";
import {
  WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
  WorkspaceFileTreeList,
} from "@/workspace-file-tree/WorkspaceFileTreeList.js";
import { WorkspaceFileTreeStickyFolders } from "@/workspace-file-tree/WorkspaceFileTreeStickyFolders.js";
import {
  createWorkspaceFileTreeRowsFromSearchEntries,
  getWorkspaceFileSearchDirectoryRevealPaths,
} from "@/workspace-file-tree/searchRows.js";
import type {
  WorkspaceFileTreeEditingSession,
  WorkspaceFileTreeFileOps,
  WorkspaceFileTreeProps,
  WorkspaceFileTreeStickyFolderItem,
} from "@/workspace-file-tree/types.js";
import {
  createWorkspaceFileTreeEditingSession,
  createWorkspaceFileTreeRenameSession,
  injectWorkspaceFileTreeDraftRow,
} from "@/workspace-file-tree/workspaceFileEdit.js";

export function getWorkspaceFileTreeDirectoryLoadDepth(
  workspacePath: string,
  directoryPath: string,
): number {
  return getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath);
}

export function WorkspaceFileTree({
  workspacePath,
  workspaceName,
  workspaceIdentity,
  workspaceRemoteSessionId,
  revealPath,
  temporaryExternalDirectory = false,
  canOpenLocalFileManager = false,
  activePreviewPath,
  onClose,
  onOpenBrowserUrl,
  onOpenPreview,
}: WorkspaceFileTreeProps) {
  const { intl } = useZCodeIntl();
  // HTML 单击打开方式是本机界面偏好；远端 workspace 下也读本机设置。
  const { settings: localSettings } = useSettings({ services: useBaseWorkspaceServices() });
  const platform = usePlatform();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingActivePreviewRevealPathRef = useRef<string | null>(null);
  const pendingSearchDirectoryRevealPathRef = useRef<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [showScrollBottomMask, setShowScrollBottomMask] = useState(false);
  const [hasScrollableFileTree, setHasScrollableFileTree] = useState(false);
  const handleListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node) {
      node.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollRef.current?.scrollTop ?? 0}px`,
      );
    }
  }, []);
  const treeData = useWorkspaceFileTreeData({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    enableWorkspaceFeatures: !temporaryExternalDirectory,
  });
  // 文件写操作与树数据走同一个 workspace 路由（本地/远程由 remoteSessionId 决定）。
  const { fileService } = useWorkspaceServices(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const [editingSession, setEditingSession] = useState<WorkspaceFileTreeEditingSession | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    name: string;
    kind: "file" | "directory";
  } | null>(null);
  const { installedEditors } = useInstalledFileTreeEditors();
  const isRemoteWorkspaceFileTree = Boolean(workspaceRemoteSessionId || workspaceIdentity);
  const { remoteTarget } = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const availableEditors = useMemo(
    () =>
      isRemoteWorkspaceFileTree && !remoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors,
            selectedEditorId: null,
            remoteTarget,
          }).availableEditors,
    [installedEditors, isRemoteWorkspaceFileTree, remoteTarget],
  );
  const wslFileManagerEditor = resolveWorkspaceFileManagerEditor(availableEditors, remoteTarget);
  const canOpenInFileManager =
    Boolean(wslFileManagerEditor) || (canOpenLocalFileManager && !isRemoteWorkspaceFileTree);
  const hasFileSearchQuery = fileSearchQuery.trim().length > 0;
  const searchIndex = useWorkspaceFileSearchIndex({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    enabled: hasFileSearchQuery,
  });
  const {
    entries: searchIndexEntries,
    error: searchIndexError,
    loaded: searchIndexLoaded,
    loading: searchIndexLoading,
    refresh: refreshSearchIndex,
  } = searchIndex;
  const searchEntries = useWorkspaceFileSearchResults({
    entries: searchIndexEntries,
    query: fileSearchQuery,
    workspacePath,
  });
  const searchRows = useMemo(
    () => createWorkspaceFileTreeRowsFromSearchEntries(searchEntries),
    [searchEntries],
  );
  const visibleRows = useMemo(() => {
    const baseRows = hasFileSearchQuery
      ? showChangedOnly
        ? searchRows.filter((row) => getWorkspaceFileGitStatus(treeData.gitStatusByPath, row.path))
        : searchRows
      : filterWorkspaceFileTreeRows({
          rows: treeData.rows,
          searchQuery: fileSearchQuery,
          changedOnly: showChangedOnly,
          statusByPath: treeData.gitStatusByPath,
        });
    // 搜索/过滤态下不注入草稿行：编辑入口此时已禁用，会话不会存活到过滤态。
    if (!editingSession || hasFileSearchQuery) {
      return baseRows;
    }
    return injectWorkspaceFileTreeDraftRow({
      rows: baseRows,
      session: editingSession,
      workspacePath,
    });
  }, [
    editingSession,
    fileSearchQuery,
    hasFileSearchQuery,
    searchRows,
    showChangedOnly,
    treeData.gitStatusByPath,
    treeData.rows,
    workspacePath,
  ]);
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
    overscan: 12,
  });

  useEffect(() => {
    setSelectedPath(null);
    setFileSearchQuery("");
    setShowChangedOnly(false);
    // 行内编辑与删除确认绑定具体路径，workspace 切换后必须一并作废。
    setEditingSession(null);
    setPendingDelete(null);
  }, [workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!treeData.gitStatusAvailable) {
      setShowChangedOnly(false);
    }
  }, [treeData.gitStatusAvailable]);

  const rootLoading = treeData.loadingDirectoryPaths.has(workspacePath);
  const rootLoaded = treeData.loadedDirectoryPaths.has(workspacePath);
  const rootError = treeData.errorByDirectory.get(workspacePath) ?? null;
  const blockingRootError = getWorkspaceFileTreeBlockingRootError({
    rootLoaded,
    rootError,
  });
  const showInitialLoading = !rootLoaded && !blockingRootError;
  const lastNonBlockingRootErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!rootLoaded || !rootError) {
      lastNonBlockingRootErrorRef.current = null;
      return;
    }
    const errorMessage = rootError.message;
    if (lastNonBlockingRootErrorRef.current === errorMessage) {
      return;
    }
    lastNonBlockingRootErrorRef.current = errorMessage;
    // Bugfix: 根目录已有缓存时，刷新失败只能作为非阻塞提示；阻塞错误页会把保留的旧文件树隐藏掉。
    toast(`${intl.formatMessage({ id: "workspaceFileTree.readFailed" })}: ${errorMessage}`);
  }, [intl, rootError, rootLoaded]);
  const gitStatusLabelByStatus = useMemo<Record<WorkspaceFileGitStatus, string>>(
    () => ({
      added: intl.formatMessage({ id: "git.kind.added" }),
      deleted: intl.formatMessage({ id: "git.kind.deleted" }),
      ignored: intl.formatMessage({
        id: "workspaceFileTree.gitStatus.ignored",
      }),
      modified: intl.formatMessage({ id: "git.kind.modified" }),
      renamed: intl.formatMessage({ id: "git.kind.renamed" }),
      untracked: intl.formatMessage({ id: "git.section.untracked" }),
    }),
    [intl],
  );
  const fileManagerLabel = getFileManagerLabel(intl);
  const fileContextMenuLabels = useMemo(
    () => ({
      addToChat: intl.formatMessage({ id: "workspaceFileTree.addToChat" }),
      copyAbsolutePath: intl.formatMessage({
        id: "fileActions.copyAbsolutePath",
      }),
      copyRelativePath: intl.formatMessage({
        id: "fileActions.copyRelativePath",
      }),
      delete: intl.formatMessage({ id: "workspaceFileTree.delete" }),
      newFile: intl.formatMessage({ id: "workspaceFileTree.newFile" }),
      newFolder: intl.formatMessage({ id: "workspaceFileTree.newFolder" }),
      open: intl.formatMessage({ id: "common.open" }),
      openInBrowser: intl.formatMessage({
        id: "workspaceFileTree.openInBrowser",
      }),
      openFailed: intl.formatMessage({ id: "workspaceFileTree.openFailed" }),
      openWith: intl.formatMessage({ id: "workspaceFileTree.openWith" }),
      rename: intl.formatMessage({ id: "workspaceFileTree.rename" }),
      reveal: fileManagerLabel,
    }),
    [fileManagerLabel, intl],
  );

  const scrollMaskStyle = useMemo<CSSProperties | undefined>(() => {
    if (!showScrollBottomMask) {
      return undefined;
    }
    return {
      WebkitMaskImage:
        "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      maskImage: "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
      WebkitMaskSize: "100% 100%",
      maskSize: "100% 100%",
    };
  }, [showScrollBottomMask]);
  const scrollContainerStyle = useMemo<CSSProperties>(
    () => ({ ...scrollMaskStyle, overflowAnchor: "none" }),
    [scrollMaskStyle],
  );

  useEffect(() => {
    const previewPath = revealPath?.trim() || activePreviewPath?.trim();
    if (!previewPath || !isWorkspaceFilePathInside(workspacePath, previewPath)) {
      return;
    }
    let disposed = false;
    const ancestorDirectories = getWorkspaceFileAncestorDirectories(workspacePath, previewPath);
    const directoryPathsToExpand = revealPath?.trim()
      ? [...ancestorDirectories, previewPath]
      : ancestorDirectories;
    pendingActivePreviewRevealPathRef.current = previewPath;
    setSelectedPath(previewPath);
    treeData.setExpandedPaths((current) => {
      const next = new Set(current);
      for (const directoryPath of directoryPathsToExpand) {
        next.add(directoryPath);
      }
      return next;
    });
    void (async () => {
      for (const [index, directoryPath] of directoryPathsToExpand.entries()) {
        if (disposed) {
          return;
        }
        await treeData.loadDirectory(directoryPath, index + 1);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    activePreviewPath,
    revealPath,
    treeData.loadDirectory,
    treeData.setExpandedPaths,
    workspacePath,
  ]);

  useEffect(() => {
    const previewPath = revealPath?.trim() || activePreviewPath?.trim();
    if (!previewPath || visibleRows.length === 0) {
      return;
    }
    if (
      !isWorkspaceFilePathInside(workspacePath, previewPath) ||
      !pendingActivePreviewRevealPathRef.current ||
      !areWorkspaceFilePathsEqual(pendingActivePreviewRevealPathRef.current, previewPath)
    ) {
      return;
    }
    const activeRowIndex = visibleRows.findIndex((row) =>
      areWorkspaceFilePathsEqual(row.path, previewPath),
    );
    if (activeRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(activeRowIndex, { align: "auto" });
      pendingActivePreviewRevealPathRef.current = null;
    }
  }, [activePreviewPath, revealPath, rowVirtualizer, visibleRows, workspacePath]);

  useEffect(() => {
    const revealDirectoryPath = pendingSearchDirectoryRevealPathRef.current;
    if (!revealDirectoryPath || visibleRows.length === 0 || hasFileSearchQuery) {
      return;
    }
    const revealRowIndex = visibleRows.findIndex((row) =>
      areWorkspaceFilePathsEqual(row.path, revealDirectoryPath),
    );
    if (revealRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(revealRowIndex, { align: "center" });
      pendingSearchDirectoryRevealPathRef.current = null;
    }
  }, [hasFileSearchQuery, rowVirtualizer, visibleRows]);

  useEffect(() => {
    const scrollNode = scrollRef.current;
    if (!scrollNode) {
      return;
    }
    const contentNode = scrollNode.firstElementChild;
    const updateScrollMask = () => {
      // virtualizer 的 scrollOffset 需要经过 React 重渲染，拖拽滚动条时
      // mask 会落后一帧。原生 scroll 回调直接更新 CSS 变量，与浏览器滚动同步绘制。
      listRef.current?.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollNode.scrollTop}px`,
      );
      const hasOverflow = scrollNode.scrollHeight > scrollNode.clientHeight + 1;
      const isAtBottom =
        scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 1;
      setHasScrollableFileTree(hasOverflow);
      setShowScrollBottomMask(hasOverflow && !isAtBottom);
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateScrollMask;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateScrollMask();
    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateScrollMask;
      debouncedUpdate();
    });
    resizeObserver.observe(scrollNode);
    if (contentNode instanceof HTMLElement) {
      resizeObserver.observe(contentNode);
    }
    scrollNode.addEventListener("scroll", updateScrollMask, { passive: true });
    window.addEventListener("resize", debouncedUpdate);
    return () => {
      resizeObserver.disconnect();
      scrollNode.removeEventListener("scroll", updateScrollMask);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [rootError, rootLoaded, rootLoading, visibleRows.length]);

  const handleRefresh = useCallback(() => {
    void treeData.refreshLoadedDirectories();
    if (hasFileSearchQuery) {
      refreshSearchIndex();
    }
  }, [hasFileSearchQuery, refreshSearchIndex, treeData]);
  const refreshInProgress =
    rootLoading || treeData.refreshingLoadedDirectories || searchIndexLoading;

  const handleOpenInFileManager = useCallback(async () => {
    if (!canOpenInFileManager) {
      return;
    }
    const result = wslFileManagerEditor
      ? await platform.openInEditor(wslFileManagerEditor.id, workspacePath, {
          pathKind: "directory",
          remoteTarget,
          workspaceIdentity,
        })
      : await platform.openInFileManager(workspacePath);
    if (!result.success) {
      logger.warn("[WorkspaceFileTree] 打开 workspace 路径失败", {
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [
    canOpenInFileManager,
    intl,
    platform,
    remoteTarget,
    workspaceIdentity,
    workspacePath,
    wslFileManagerEditor,
  ]);

  const handleCopyPath = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      logger.warn("[WorkspaceFileTree] 复制 workspace 路径失败", {
        path: workspacePath,
        error: "clipboard-unavailable",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(workspacePath);
      logger.info("[WorkspaceFileTree] workspace 路径已复制", {
        path: workspacePath,
      });
    } catch (error) {
      logger.warn("[WorkspaceFileTree] 复制 workspace 路径失败", {
        path: workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [workspacePath]);

  const handleToggleDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory") {
        return;
      }
      const representedPaths = row.compactedPaths ?? [row.path];
      treeData.setExpandedPaths((current) => {
        const next = new Set(current);
        // 懒加载合并后可能只有前段路径已展开；只查末段会让首次折叠变成补加展开标记。
        // 与行展示使用相同的组成路径，并在更新函数内读取最新集合，避免旧渲染状态干扰切换。
        if (representedPaths.some((path) => current.has(path))) {
          for (const path of representedPaths) {
            next.delete(path);
          }
          return next;
        }
        next.add(row.path);
        return next;
      });
      if (!row.expanded) {
        // compact folders 的 row.depth 是压缩后的视觉深度，不能用于写入新加载节点。
        // 使用物理路径深度后，flatten 阶段再扣除 compact offset，子内容才不会与父目录同级。
        void treeData.loadDirectory(
          row.path,
          getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, row.path),
        );
      }
    },
    [treeData, workspacePath],
  );
  const handleRevealSearchDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory") {
        return;
      }
      const directoryPathsToExpand = getWorkspaceFileSearchDirectoryRevealPaths({
        workspacePath,
        directoryPath: row.path,
      });
      if (directoryPathsToExpand.length === 0) {
        return;
      }
      pendingSearchDirectoryRevealPathRef.current = row.path;
      setSelectedPath(row.path);
      treeData.setExpandedPaths((current) => {
        const next = new Set(current);
        for (const directoryPath of directoryPathsToExpand) {
          next.add(directoryPath);
        }
        return next;
      });
      // 搜索结果是 listWorkspaceFiles 的平铺索引，不受 expandedPaths 驱动。
      // 目录点击必须先回到树态，再逐级加载祖先目录，目标目录才会在懒加载树中可见并保持展开。
      setFileSearchQuery("");
      void (async () => {
        for (const directoryPath of directoryPathsToExpand) {
          await treeData.loadDirectory(
            directoryPath,
            getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, directoryPath),
          );
        }
      })();
    },
    [treeData, workspacePath],
  );
  const handleDirectoryAction = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (hasFileSearchQuery) {
        handleRevealSearchDirectory(row);
        return;
      }
      handleToggleDirectory(row);
    },
    [handleRevealSearchDirectory, handleToggleDirectory, hasFileSearchQuery],
  );
  const handleOpenPreview = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type === "directory") {
        handleDirectoryAction(row);
        return;
      }
      if (
        isWorkspaceFileTreeDeletedFile(
          row,
          getWorkspaceFileGitStatus(treeData.gitStatusByPath, row.path),
        )
      ) {
        // 修复：deleted 文件行来自 Git 状态补全，不对应现存文件。
        // 即使未来有其它入口直接调用预览，也要在父级兜底阻止打开。
        return;
      }
      onOpenPreview?.(createCodeViewerSourceForWorkspaceFile(row.path));
    },
    [handleDirectoryAction, onOpenPreview, treeData.gitStatusByPath],
  );
  const editingDisabled = hasFileSearchQuery;
  const editingInvalidMessage = intl.formatMessage({
    id: "workspaceFileTree.editingInvalidName",
  });
  const handleStartEditing = useCallback(
    (session: WorkspaceFileTreeEditingSession) => {
      // create 落在折叠目录上时先展开父目录，草稿行才能注入到正确的可见位置。
      if (
        session.mode !== "rename" &&
        session.parentPath &&
        !areWorkspaceFilePathsEqual(session.parentPath, workspacePath)
      ) {
        const parentPath = session.parentPath;
        treeData.setExpandedPaths((current) => {
          const next = new Set(current);
          next.add(parentPath);
          return next;
        });
        void treeData.loadDirectory(
          parentPath,
          getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, parentPath),
        );
      }
      setEditingSession(session);
    },
    [treeData, workspacePath],
  );
  const handleCancelEditing = useCallback((session: WorkspaceFileTreeEditingSession) => {
    // 会话可能已被新的编辑动作替换；只清理仍属于该输入框的会话。
    setEditingSession((current) => (current === session ? null : current));
  }, []);
  const handleEditingInvalid = useCallback((message: string) => {
    toast(message);
  }, []);
  const handleCommitEditing = useCallback(
    async (session: WorkspaceFileTreeEditingSession, name: string) => {
      // commit 以输入框持有的 session 为准：编辑期间会话可能已被替换，
      // 从 state 读取会把旧输入的值提交到新会话上。
      const parentPath =
        session.mode === "rename"
          ? getContainingDirectoryPath(session.targetPath ?? "")
          : session.parentPath;
      try {
        const result =
          session.mode === "rename"
            ? await fileService.renameWorkspaceEntry({
                rootPath: workspacePath,
                path: session.targetPath ?? "",
                newName: name,
              })
            : await fileService.createWorkspaceEntry({
                rootPath: workspacePath,
                parentPath: session.parentPath ?? workspacePath,
                name,
                kind: session.kind,
              });
        setEditingSession((current) => (current === session ? null : current));
        setSelectedPath(result.path);
        if (parentPath) {
          // 主动重载父目录，不依赖 watcher 时序；watcher 通知作为兜底。
          void treeData.loadDirectory(
            parentPath,
            getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, parentPath),
            { force: true },
          );
        }
      } catch (error) {
        logger.warn("[WorkspaceFileTree] 文件写操作失败", {
          mode: session.mode,
          parentPath,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [fileService, treeData, workspacePath],
  );
  const handleRequestDelete = useCallback((row: WorkspaceFileTreeRow) => {
    setPendingDelete({
      path: row.path,
      name: row.name,
      kind: row.type === "directory" ? "directory" : "file",
    });
  }, []);
  const handleConfirmDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target) {
      return;
    }
    try {
      await fileService.deleteWorkspaceEntry({ rootPath: workspacePath, path: target.path });
      // 被删条目是选中项或其祖先目录时，同步清掉失效的选中态。
      setSelectedPath((current) =>
        current &&
        (areWorkspaceFilePathsEqual(current, target.path) ||
          isWorkspaceFilePathInside(target.path, current))
          ? null
          : current,
      );
      const parentPath = getContainingDirectoryPath(target.path);
      if (parentPath) {
        void treeData.loadDirectory(
          parentPath,
          getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, parentPath),
          { force: true },
        );
      }
    } catch (error) {
      logger.warn("[WorkspaceFileTree] 删除文件失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingDelete(null);
    }
  }, [fileService, pendingDelete, treeData, workspacePath]);
  const fileOps = useMemo<WorkspaceFileTreeFileOps>(
    () => ({
      editingSession,
      editingDisabled,
      editingInvalidMessage,
      onStartEditing: handleStartEditing,
      onRequestDelete: handleRequestDelete,
      onCommitEditing: handleCommitEditing,
      onCancelEditing: handleCancelEditing,
      onEditingInvalid: handleEditingInvalid,
    }),
    [
      editingSession,
      editingDisabled,
      editingInvalidMessage,
      handleStartEditing,
      handleRequestDelete,
      handleCommitEditing,
      handleCancelEditing,
      handleEditingInvalid,
    ],
  );

  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => {
      // deleted 虚拟行不对应磁盘真实条目，不能参与重命名/删除。
      const isDeletedRow = isWorkspaceFileTreeDeletedFile(
        row,
        getWorkspaceFileGitStatus(treeData.gitStatusByPath, row.path),
      );
      if (event.key === "F2" && !editingDisabled && !isDeletedRow) {
        event.preventDefault();
        handleStartEditing(createWorkspaceFileTreeRenameSession(row));
        return;
      }
      if (event.key === "Delete" && !editingDisabled && !isDeletedRow) {
        event.preventDefault();
        handleRequestDelete(row);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        handleOpenPreview(row);
        return;
      }
      if (event.key === "ArrowRight" && row.type === "directory") {
        event.preventDefault();
        if (!row.expanded || hasFileSearchQuery) {
          handleDirectoryAction(row);
        }
        return;
      }
      if (event.key === "ArrowLeft" && row.type === "directory" && row.expanded) {
        event.preventDefault();
        handleToggleDirectory(row);
      }
    },
    [
      editingDisabled,
      handleDirectoryAction,
      handleOpenPreview,
      handleRequestDelete,
      handleStartEditing,
      handleToggleDirectory,
      hasFileSearchQuery,
      treeData.gitStatusByPath,
    ],
  );

  const hasActiveFileTreeFilter = fileSearchQuery.trim().length > 0 || showChangedOnly;
  const virtualItems = rowVirtualizer.getVirtualItems();
  const scrollOffset = rowVirtualizer.scrollOffset ?? 0;
  const stickyFolderItems = useWorkspaceFileTreeStickyFolders({
    rows: visibleRows,
    virtualItems,
    scrollDirection: rowVirtualizer.scrollDirection,
    scrollOffset,
    enabled: hasScrollableFileTree && !hasFileSearchQuery,
  });
  const handleRevealStickyFolderRow = useCallback(
    (item: WorkspaceFileTreeStickyFolderItem) =>
      rowVirtualizer.scrollToIndex(item.index, { align: "start" }),
    [rowVirtualizer],
  );
  const workspaceTitle =
    workspaceName?.trim() ||
    getPathLeaf(workspacePath) ||
    intl.formatMessage({ id: "workspaceFileTree.title" });
  const editorState = {
    workspaceRemoteSessionId,
    canOpenLocalFileManager,
    installedEditors: availableEditors,
    isRemoteWorkspaceFileTree,
    remoteTarget,
    htmlClickOpensBrowser: localSettings?.fileTreeHtmlClickOpensBrowser === true,
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col text-foreground"
      data-testid={TID_WORKSPACE_FILE_TREE_PANEL}
    >
      {onClose ? (
        <div className="px-2 pb-3 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="w-full justify-start gap-2 rounded-xl px-2.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={onClose}
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="min-w-0 truncate">
              {intl.formatMessage({ id: "workspaceFileTree.backToTasks" })}
            </span>
          </Button>
        </div>
      ) : (
        <div className="h-2 shrink-0" />
      )}
      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
          <Input
            type="text"
            size="default"
            value={fileSearchQuery}
            className="h-7 bg-transparent pl-7 pr-7 focus-visible:bg-input-focused"
            placeholder={intl.formatMessage({
              id: "workspaceFileTree.searchPlaceholder",
            })}
            aria-label={intl.formatMessage({
              id: "workspaceFileTree.searchLabel",
            })}
            onChange={(event) => setFileSearchQuery(event.currentTarget.value)}
          />
          {fileSearchQuery.length > 0 ? (
            <SidebarNativeTooltip>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
                aria-label={intl.formatMessage({
                  id: "workspaceFileTree.clearSearch",
                })}
                title={intl.formatMessage({
                  id: "workspaceFileTree.clearSearch",
                })}
                onClick={() => setFileSearchQuery("")}
              >
                <X className="size-3" />
              </Button>
            </SidebarNativeTooltip>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center px-2 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <h3 className="min-w-0 truncate py-1 pr-0.5 pl-2.5 text-ui-base font-medium text-foreground-subtlest">
            {workspaceTitle}
          </h3>
        </div>
        <ControlHintTooltip title={fileContextMenuLabels.newFile}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={fileContextMenuLabels.newFile}
            className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            disabled={editingDisabled}
            onClick={() =>
              handleStartEditing(
                createWorkspaceFileTreeEditingSession({
                  mode: "create-file",
                  parentPath: workspacePath,
                }),
              )
            }
          >
            <FilePlus className="size-3.5" />
          </Button>
        </ControlHintTooltip>
        <ControlHintTooltip title={fileContextMenuLabels.newFolder}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={fileContextMenuLabels.newFolder}
            className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            disabled={editingDisabled}
            onClick={() =>
              handleStartEditing(
                createWorkspaceFileTreeEditingSession({
                  mode: "create-directory",
                  parentPath: workspacePath,
                }),
              )
            }
          >
            <FolderPlus className="size-3.5" />
          </Button>
        </ControlHintTooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarNativeTooltip>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                aria-label={intl.formatMessage({ id: "common.more" })}
                title={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </SidebarNativeTooltip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              disabled={!canOpenInFileManager}
              onSelect={() => void handleOpenInFileManager()}
            >
              <FolderOpen className="size-4" />
              {fileManagerLabel}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleCopyPath()}>
              <Copy className="size-4" />
              {intl.formatMessage({ id: "appHeader.copyPath" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {treeData.gitStatusAvailable ? (
          <ControlHintTooltip
            title={intl.formatMessage({
              id: showChangedOnly
                ? "workspaceFileTree.showAllFiles"
                : "workspaceFileTree.showChangedFiles",
            })}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={showChangedOnly}
              aria-label={intl.formatMessage({
                id: showChangedOnly
                  ? "workspaceFileTree.showAllFiles"
                  : "workspaceFileTree.showChangedFiles",
              })}
              className={cn(
                "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                showChangedOnly && "bg-selected text-foreground",
              )}
              onClick={() => setShowChangedOnly((current) => !current)}
            >
              <GitCommitVertical className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        ) : null}
        <ControlHintTooltip title={intl.formatMessage({ id: "workspaceFileTree.refresh" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid={TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON}
            className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            aria-label={intl.formatMessage({ id: "workspaceFileTree.refresh" })}
            disabled={treeData.refreshingLoadedDirectories}
            onClick={handleRefresh}
          >
            <RefreshCw className={cn("size-3.5", refreshInProgress && "animate-spin")} />
          </Button>
        </ControlHintTooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="h-full min-h-0 overflow-auto px-1 px-2"
          style={scrollContainerStyle}
        >
          <WorkspaceFileTreeStickyFolders
            items={stickyFolderItems}
            selectedPath={selectedPath}
            gitStatusByPath={treeData.gitStatusByPath}
            ignoredPathSet={treeData.ignoredPathSet}
            gitStatusLabelByStatus={gitStatusLabelByStatus}
            contextMenuLabels={fileContextMenuLabels}
            editorState={editorState}
            fileOps={fileOps}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            onSelect={setSelectedPath}
            onToggleDirectory={handleToggleDirectory}
            onRevealRow={handleRevealStickyFolderRow}
            onOpenPreview={handleOpenPreview}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onKeyDown={handleRowKeyDown}
          />
          <WorkspaceFileTreeList
            rootError={hasFileSearchQuery ? searchIndexError : blockingRootError}
            showInitialLoading={
              showInitialLoading || (hasFileSearchQuery && searchIndexLoading && !searchIndexLoaded)
            }
            rows={visibleRows}
            virtualItems={virtualItems}
            listRef={handleListRef}
            stickyFolderCount={stickyFolderItems.length}
            totalSize={rowVirtualizer.getTotalSize()}
            emptyTitle={intl.formatMessage({
              id: hasActiveFileTreeFilter
                ? "workspaceFileTree.noResults"
                : "workspaceFileTree.empty",
            })}
            workspaceTitle={workspaceTitle}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            selectedPath={selectedPath}
            gitStatusByPath={treeData.gitStatusByPath}
            ignoredPathSet={treeData.ignoredPathSet}
            gitStatusLabelByStatus={gitStatusLabelByStatus}
            contextMenuLabels={fileContextMenuLabels}
            editorState={editorState}
            fileOps={fileOps}
            onSelect={setSelectedPath}
            onToggleDirectory={handleDirectoryAction}
            onOpenPreview={handleOpenPreview}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onKeyDown={handleRowKeyDown}
          />
        </div>
      </div>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "workspaceFileTree.deleteConfirmTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage(
                {
                  id:
                    pendingDelete?.kind === "directory"
                      ? "workspaceFileTree.deleteConfirmDirectory"
                      : "workspaceFileTree.deleteConfirmFile",
                },
                { name: pendingDelete?.name ?? "" },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleConfirmDelete()}
            >
              {fileContextMenuLabels.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export function getWorkspaceFileTreeBlockingRootError({
  rootLoaded,
  rootError,
}: {
  rootLoaded: boolean;
  rootError: Error | null;
}) {
  return rootLoaded ? null : rootError;
}
