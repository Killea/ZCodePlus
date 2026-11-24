import { useCallback, useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import {
  GLOBAL_MEMORY_CHARACTER_LIMIT,
  GLOBAL_MEMORY_DEFAULT_ID,
  GLOBAL_MEMORY_DESCRIPTION_CHARACTER_LIMIT,
  GLOBAL_MEMORY_NAME_CHARACTER_LIMIT,
  type IMemoryService,
} from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_GLOBAL_EDITOR,
  TID_SETTINGS_MEMORY_GLOBAL_SAVE,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Progress } from "@/components/ui/progress.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";

type GlobalMemoryEditorService = Pick<IMemoryService, "readGlobalMemory" | "writeGlobalMemory">;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CharCounter({
  count,
  limit,
  className,
}: {
  count: number;
  limit: number;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const overLimit = count > limit;
  return (
    <span
      className={cn(
        "text-ui-xs",
        overLimit ? "text-destructive" : "text-foreground-subtle",
        className,
      )}
    >
      {intl.formatMessage({ id: "settings.memory.global.charCount" }, { count, limit })}
    </span>
  );
}

/**
 * 全局记忆条目编辑器：按 memoryId 加载/编辑/保存
 * `~/.zcode/cli/memories/global/` 下的单条 Markdown 记忆。
 * 分字段编辑：name / description 落入 frontmatter，content 为正文（≤20480）。
 * name 留空表示回退显示名（default → 本地化"默认"，其余 → id）。
 * 2026-10-26 起总开关移除（全局记忆默认常开、不可关闭），不再有 disabled 门控。
 */
export function GlobalMemoryEditor({
  memoryService,
  memoryId,
  onSaved,
}: {
  memoryService: GlobalMemoryEditorService;
  memoryId: string;
  /** 保存成功后回调：宿主据此刻刷新列表（name/chars 可能已变化）。 */
  onSaved?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [loaded, setLoaded] = useState<{
    name: string;
    description: string;
    content: string;
  } | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadVersionRef = useRef(0);

  const load = useCallback(async () => {
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setLoading(true);
    try {
      const result = await memoryService.readGlobalMemory({ id: memoryId });
      if (loadVersionRef.current !== version) {
        return;
      }
      const entry = {
        // 服务层无自定义 name 时把 name 回退为 id。这里归一化为空串，让输入框走
        // placeholder 回退显示名（default → 本地化"默认"，其余 → id），避免把
        // "default"/slug 当作可编辑文本预填、并随保存写回 frontmatter。
        name: result.name === memoryId ? "" : result.name,
        description: result.description ?? "",
        content: result.content,
      };
      setLoaded(entry);
      setNameDraft(entry.name);
      setDescriptionDraft(entry.description);
      setContentDraft(entry.content);
    } catch (error) {
      if (loadVersionRef.current !== version) {
        return;
      }
      logger.warn("[GlobalMemoryEditor] 读取全局记忆失败", {
        error: getErrorMessage(error),
      });
      toast(intl.formatMessage({ id: "settings.memory.global.loadFailed" }));
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [intl, memoryId, memoryService]);

  useEffect(() => {
    setLoading(true);
    setLoaded(null);
    setNameDraft("");
    setDescriptionDraft("");
    setContentDraft("");
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
    if (
      contentDraft.length > GLOBAL_MEMORY_CHARACTER_LIMIT ||
      nameDraft.length > GLOBAL_MEMORY_NAME_CHARACTER_LIMIT ||
      descriptionDraft.length > GLOBAL_MEMORY_DESCRIPTION_CHARACTER_LIMIT
    ) {
      return;
    }
    setSaving(true);
    try {
      await runUserActionAsync({
        input: {
          featureId: "settings.memory",
          action: "save_global_memory",
          trigger: "button",
        },
        operation: async () => {
          await memoryService.writeGlobalMemory({
            id: memoryId,
            name: nameDraft,
            description: descriptionDraft,
            content: contentDraft,
          });
        },
        completed: { resultSource: "platform_result" },
        failureStage: "global_memory_save",
      });
      setLoaded({
        name: nameDraft,
        description: descriptionDraft,
        content: contentDraft,
      });
      toast(intl.formatMessage({ id: "settings.memory.global.saved" }));
      onSaved?.();
    } catch (error) {
      logger.warn("[GlobalMemoryEditor] 保存全局记忆失败", {
        error: getErrorMessage(error),
      });
      toast(intl.formatMessage({ id: "settings.memory.global.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [nameDraft, descriptionDraft, contentDraft, intl, memoryId, memoryService, onSaved]);

  const charCount = contentDraft.length;
  const overLimit =
    charCount > GLOBAL_MEMORY_CHARACTER_LIMIT ||
    nameDraft.length > GLOBAL_MEMORY_NAME_CHARACTER_LIMIT ||
    descriptionDraft.length > GLOBAL_MEMORY_DESCRIPTION_CHARACTER_LIMIT;
  const percent = Math.min(100, Math.round((charCount / GLOBAL_MEMORY_CHARACTER_LIMIT) * 100));
  const dirty =
    loaded !== null &&
    (nameDraft !== loaded.name ||
      descriptionDraft !== loaded.description ||
      contentDraft !== loaded.content);
  const canSave = !loading && !saving && !overLimit && dirty;

  const namePlaceholder =
    memoryId === GLOBAL_MEMORY_DEFAULT_ID
      ? intl.formatMessage({ id: "settings.memory.global.defaultName" })
      : memoryId;

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="grid gap-2">
        <Input
          value={nameDraft}
          onChange={(event) => setNameDraft(event.target.value)}
          disabled={loading || saving}
          placeholder={namePlaceholder}
          aria-label={intl.formatMessage({ id: "settings.memory.global.nameLabel" })}
          data-testid={`${TID_SETTINGS_MEMORY_GLOBAL_EDITOR}-name`}
          className="text-ui-base"
        />
        <Input
          value={descriptionDraft}
          onChange={(event) => setDescriptionDraft(event.target.value)}
          disabled={loading || saving}
          placeholder={intl.formatMessage({ id: "settings.memory.global.descriptionPlaceholder" })}
          aria-label={intl.formatMessage({ id: "settings.memory.global.descriptionLabel" })}
          data-testid={`${TID_SETTINGS_MEMORY_GLOBAL_EDITOR}-description`}
          className="text-ui-base"
        />
      </div>
      <SettingsFormTextarea
        value={contentDraft}
        onChange={(event) => setContentDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            if (canSave) {
              void handleSave();
            }
          }
        }}
        spellCheck={false}
        disabled={loading || saving}
        placeholder={intl.formatMessage({ id: "settings.memory.global.empty" })}
        className="min-h-48 w-full text-ui-base"
        aria-label={intl.formatMessage({ id: "settings.memory.global.editorLabel" })}
        data-testid={TID_SETTINGS_MEMORY_GLOBAL_EDITOR}
      />
      <div className="flex items-center gap-2">
        <Progress
          value={percent}
          className="h-1.5 w-24"
          indicatorClassName={
            charCount > GLOBAL_MEMORY_CHARACTER_LIMIT ? "bg-destructive" : undefined
          }
        />
        <CharCounter
          count={charCount}
          limit={GLOBAL_MEMORY_CHARACTER_LIMIT}
          className="text-ui-base"
        />
        <CharCounter count={nameDraft.length} limit={GLOBAL_MEMORY_NAME_CHARACTER_LIMIT} />
        <CharCounter
          count={descriptionDraft.length}
          limit={GLOBAL_MEMORY_DESCRIPTION_CHARACTER_LIMIT}
        />
        <Button
          variant="default"
          size="sm"
          disabled={!canSave}
          onClick={() => void handleSave()}
          data-testid={TID_SETTINGS_MEMORY_GLOBAL_SAVE}
        >
          <Save className="size-4" />
          {intl.formatMessage({ id: "settings.memory.global.save" })}
        </Button>
        {dirty && !overLimit ? (
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.memory.global.unsaved" })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
