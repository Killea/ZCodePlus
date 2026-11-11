import { useState } from "react";
import { TID_SETTINGS_GLOBAL_MEMORY_CREATE } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";

/**
 * 全局记忆新建表单：name 必填（服务层由它派生 slug），
 * description/content 可选；校验（条数/字符上限）在服务层收敛。
 */
export function GlobalMemoryCreateForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (draft: { name: string; description: string; content: string }) => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");

  const reset = () => {
    setName("");
    setDescription("");
    setContent("");
  };

  return (
    <div className="space-y-2 rounded-lg border border-border px-3 py-3">
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={busy}
        placeholder={intl.formatMessage({
          id: "settings.memory.global.createNamePlaceholder",
        })}
        aria-label={intl.formatMessage({ id: "settings.memory.global.nameLabel" })}
        data-testid={`${TID_SETTINGS_GLOBAL_MEMORY_CREATE}-name`}
        className="text-ui-base"
      />
      <Input
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        disabled={busy}
        placeholder={intl.formatMessage({
          id: "settings.memory.global.descriptionPlaceholder",
        })}
        aria-label={intl.formatMessage({
          id: "settings.memory.global.descriptionLabel",
        })}
        data-testid={`${TID_SETTINGS_GLOBAL_MEMORY_CREATE}-description`}
        className="text-ui-base"
      />
      <SettingsFormTextarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        disabled={busy}
        spellCheck={false}
        placeholder={intl.formatMessage({ id: "settings.memory.global.empty" })}
        aria-label={intl.formatMessage({ id: "settings.memory.global.editorLabel" })}
        data-testid={`${TID_SETTINGS_GLOBAL_MEMORY_CREATE}-content`}
        className="min-h-24 w-full text-ui-base"
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            reset();
            onCancel();
          }}
        >
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={busy || name.trim().length === 0}
          data-testid={`${TID_SETTINGS_GLOBAL_MEMORY_CREATE}-confirm`}
          onClick={() => onSubmit({ name, description, content })}
        >
          {intl.formatMessage({ id: "settings.memory.global.createConfirm" })}
        </Button>
      </div>
    </div>
  );
}
