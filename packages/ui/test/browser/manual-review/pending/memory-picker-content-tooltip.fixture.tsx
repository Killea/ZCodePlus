// 验收 fixture：V4ComposerMemoryPicker 条目 hover 内容浮层
// （docs/global-memory-multi.md「条目 hover 内容 tooltip」）。
// 场景：长正文（验证完整展示 + 纵向滚动）、空正文（占位）、懒加载竞态。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { V4ComposerMemoryPicker } from "@/v4/composer/V4ComposerMemoryPicker.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import "@/styles.css";

// 40 行 × ~100 字符 ≈ 4000 字符：远超 280px 内容区可显示行数，用于滚动断言。
const LONG_LINES = Array.from({ length: 40 }, (_, i) => `第 ${String(i + 1).padStart(2, "0")} 行内容——用户偏好用 TypeScript 严格模式，提交前必须跑 typecheck。`);
const LONG_CONTENT = LONG_LINES.join("\n");
const SHORT_CONTENT = "短记忆：回复要简洁。\n第二行。";

const CONTENTS: Record<string, string> = {
  long: LONG_CONTENT,
  short: SHORT_CONTENT,
  "empty-memory": "",
};

function Fixture() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const handleToggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // 模拟宿主 readGlobalMemory：短延迟让 loading 态可被观测；unknown id 返回 null。
  const handleReadMemoryContent = useCallback(
    (id: string) =>
      new Promise<string | null>((resolve) => {
        window.setTimeout(() => resolve(CONTENTS[id] ?? null), 80);
      }),
    [],
  );
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      {/* 生产树由更高层的 TooltipProvider 覆盖 ControlHintTooltip；fixture 等价补上。 */}
      <TooltipProvider>
        <div className="min-h-screen bg-background p-8">
        <V4ComposerMemoryPicker
          memories={[
            {
              id: "long",
              name: "Long memory",
              description: "very long body",
              chars: LONG_CONTENT.length,
              updatedAt: 1,
            },
            {
              id: "short",
              name: "Short memory",
              description: "short body",
              chars: SHORT_CONTENT.length,
              updatedAt: 2,
            },
            {
              id: "empty-memory",
              name: "Empty memory",
              description: "no body",
              chars: 0,
              updatedAt: 3,
            },
          ]}
          loading={false}
          error={null}
          selectedIds={selected}
          onToggle={handleToggle}
          onReadMemoryContent={handleReadMemoryContent}
          disabled={false}
        />
        </div>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
