// Composer 记忆 picker 的增删改/复制弹层（docs/global-memory-multi.md「picker 内快速增删改/复制」）。
// - 数据与写路径由宿主注入（onSave/onConfirm 返回是否成功），本文件不接触 IMemoryService，
//   与 V4ComposerMemoryPicker 的宿主注入契约一致。
// - 新建/编辑/复制共用 V4ComposerMemoryEditDialog（复制 = 预填的新建）；删除走确认框。
// - 弹层由 picker 条件挂载（key 驱动会话重置）；打开前 picker 已关闭菜单——菜单 z-[60]
//   高于 Dialog 的 z-50，叠层时菜单会盖住弹层。
// - 校验与设置页 GlobalMemoryEditor 同口径：name ≤80、description ≤200、content ≤20480；
//   新建/复制 name 必填，编辑 name 留空回退显示名。
// - 宿主未提供对应回调时 picker 不渲染对应入口（降级场景）。
import { useState, type MouseEvent } from "react";
import { SaveIcon } from "lucide-react";
import {
  GLOBAL_MEMORY_CHARACTER_LIMIT,
  GLOBAL_MEMORY_DESCRIPTION_CHARACTER_LIMIT,
  GLOBAL_MEMORY_NAME_CHARACTER_LIMIT,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
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
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TID_V4_COMPOSER_MEMORY_PICKER } from "@zcode/shared/test-ids";

/** 弹层草稿：name/description 落 frontmatter，content 为正文。 */
export interface V4ComposerMemoryDraftInput {
  name: string;
  description: string;
  content: string;
}

function FieldCounter({ count, limit }: { count: number; limit: number }) {
  const { intl } = useZCodeIntl();
  const over = count > limit;
  return (
    <span className={cn("text-ui-xs", over ? "text-destructive" : "text-foreground-subtlest")}>
      {intl.formatMessage({ id: "settings.memory.global.charCount" }, { count, limit })}
    </span>
  );
}

/**
 * 新建/编辑/复制共用的记忆编辑框。
 * 宿主 onSave 返回 true 时调用方关闭（picker 关弹层并失效缓存）；返回 false 保持打开并显示错误。
 */
export function V4ComposerMemoryEditDialog({
  title,
  initial,
  requireName,
  onSave,
  onClose,
}: {
  title: string;
  /** 打开时的预填值（复制 = 源条目正文 + 名称后缀；编辑 = 当前条目）。 */
  initial: V4ComposerMemoryDraftInput;
  /** 新建/复制：name 必填；编辑：可留空回退显示名。 */
  requireName: boolean;
  onSave: (input: V4ComposerMemoryDraftInput) => Promise<boolean>;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [content, setContent] = useState(initial.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameEmpty = requireName && name.trim().length === 0;
  const overLimit =
    name.length > GLOBAL_MEMORY_NAME_CHARACTER_LIMIT ||
    description.length > GLOBAL_MEMORY_DESCRIPTION_CHARACTER_LIMIT ||
    content.length > GLOBAL_MEMORY_CHARACTER_LIMIT;
  const canSave = !saving && !nameEmpty && !overLimit;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const ok = await onSave({
      name: name.trim(),
      description: description.trim(),
      content,
    });
    if (ok) {
      onClose();
    } else {
      setSaving(false);
      setError(intl.formatMessage({ id: "settings.memory.global.saveFailed" }));
    }
  };

  const fieldClassName =
    "rounded-lg border border-input-border bg-input px-2 py-1.5 text-ui-base shadow-none placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0";

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-dialog-title`}>
            {title}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "chat.toolbar.memory.dialogDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <div className="grid gap-1">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
              placeholder={intl.formatMessage({
                id: "settings.memory.global.createNamePlaceholder",
              })}
              aria-label={intl.formatMessage({ id: "settings.memory.global.nameLabel" })}
              data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-dialog-name`}
              className={fieldClassName}
            />
            <div className="flex items-center justify-between">
              <span
                className={cn("text-ui-xs", nameEmpty ? "text-destructive" : "text-transparent")}
              >
                {intl.formatMessage({ id: "chat.toolbar.memory.dialogNameRequired" })}
              </span>
              <FieldCounter count={name.length} limit={GLOBAL_MEMORY_NAME_CHARACTER_LIMIT} />
            </div>
          </div>
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={saving}
            placeholder={intl.formatMessage({
              id: "settings.memory.global.descriptionPlaceholder",
            })}
            aria-label={intl.formatMessage({ id: "settings.memory.global.descriptionLabel" })}
            data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-dialog-description`}
            className={fieldClassName}
          />
          <div className="grid gap-1">
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              disabled={saving}
              spellCheck={false}
              placeholder={intl.formatMessage({ id: "settings.memory.global.empty" })}
              aria-label={intl.formatMessage({ id: "settings.memory.global.editorLabel" })}
              data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-dialog-content`}
              className={cn(fieldClassName, "min-h-40 resize-y text-ui-base/relaxed")}
            />
            <div className="flex items-center justify-between">
              <FieldCounter
                count={description.length}
                limit={GLOBAL_MEMORY_DESCRIPTION_CHARACTER_LIMIT}
              />
              <FieldCounter count={content.length} limit={GLOBAL_MEMORY_CHARACTER_LIMIT} />
            </div>
          </div>
        </div>
        <DialogFooter>
          {error ? (
            <span
              role="alert"
              className="text-ui-sm text-destructive"
              data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-dialog-error`}
            >
              {error}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={onClose}
            data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-dialog-cancel`}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={() => void handleSave()}
            data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-dialog-save`}
          >
            <SaveIcon className="size-4" />
            {intl.formatMessage({ id: "common.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 删除确认框：onConfirm 返回 false 时保持打开并提示失败（不静默丢失用户意图）。 */
export function V4ComposerMemoryDeleteDialog({
  name,
  onConfirm,
  onClose,
}: {
  /** 条目显示名（default 未命名时为本地化「默认」）。 */
  name: string;
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleConfirm = async (event: MouseEvent<HTMLButtonElement>) => {
    // Radix AlertDialogAction 默认点击即关闭弹层；preventDefault 让失败时保持打开。
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await onConfirm();
    if (ok) {
      onClose();
    } else {
      setBusy(false);
      setFailed(true);
    }
  };

  return (
    <AlertDialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
    >
      <AlertDialogContent data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-delete-confirm`}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "settings.memory.global.deleteConfirmTitle" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage(
              { id: "settings.memory.global.deleteConfirmDescription" },
              { name },
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? (
          <span
            role="alert"
            className="text-ui-sm text-destructive"
            data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-delete-error`}
          >
            {intl.formatMessage({ id: "chat.toolbar.memory.deleteFailed" })}
          </span>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={busy}
            size="sm"
            data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-delete-cancel`}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => void handleConfirm(event)}
            size="sm"
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            data-testid={`${TID_V4_COMPOSER_MEMORY_PICKER}-delete-confirm-action`}
          >
            {intl.formatMessage({ id: "common.delete" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
