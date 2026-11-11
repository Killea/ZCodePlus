import { TID_WORKSPACE_FILES_TOGGLE } from "@zcode/shared/test-ids";
import { FolderTreeIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";

export function WorkspaceFilesToggleButton({
  isFilesPaneOpen,
  onToggleFiles,
  useWindowsCaptionSpacing = false,
}: {
  isFilesPaneOpen: boolean;
  onToggleFiles: () => void;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const label = intl.formatMessage({ id: "files.toggle" });

  if (isOfficeMode) return null;

  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_WORKSPACE_FILES_TOGGLE}
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
          isFilesPaneOpen && "!bg-selected text-foreground",
        )}
        aria-label={label}
        onClick={() =>
          runUserAction({
            input: {
              featureId: "workbench.file",
              action: isFilesPaneOpen ? "close_tree" : "open_tree",
              trigger: "button",
            },
            operation: onToggleFiles,
            completed: { resultSource: "local_commit" },
            failureStage: "file_tree_toggle",
          })
        }
      >
        <FolderTreeIcon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
