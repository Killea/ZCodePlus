// 验收 fixture：V4ComposerMemoryPicker 条目 hover 内容浮层 + 快速增删改/复制
// （docs/global-memory-multi.md「条目 hover 内容 tooltip」「picker 内快速增删改/复制」）。
// 场景：长正文（完整展示 + 纵向滚动）、空正文（占位）、懒加载竞态、
// 有状态增删改（新建/编辑/复制/删除 + 空名拦截）。
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GlobalMemoryEntryMeta } from "@zcode/services";
import { V4ComposerMemoryPicker } from "@/v4/composer/V4ComposerMemoryPicker.js";
import type { V4ComposerMemoryDraftInput } from "@/v4/composer/V4ComposerMemoryDialogs.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import "@/styles.css";

// 40 行 × ~100 字符 ≈ 4000 字符：远超 280px 内容区可显示行数，用于滚动断言。
const LONG_LINES = Array.from(
  { length: 40 },
  (_, i) =>
    `第 ${String(i + 1).padStart(2, "0")} 行内容——用户偏好用 TypeScript 严格模式，提交前必须跑 typecheck。`,
);
const LONG_CONTENT = LONG_LINES.join("\n");
const SHORT_CONTENT = "短记忆：回复要简洁。\n第二行。";

type FixtureEntry = { id: string; name: string; description?: string; content: string };

const INITIAL_ENTRIES: FixtureEntry[] = [
  { id: "long", name: "Long memory", description: "very long body", content: LONG_CONTENT },
  { id: "short", name: "Short memory", description: "short body", content: SHORT_CONTENT },
  { id: "empty-memory", name: "Empty memory", description: "no body", content: "" },
];

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function Fixture() {
  const [entries, setEntries] = useState<FixtureEntry[]>(INITIAL_ENTRIES);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const slugRef = useRef(1);
  // 异步读/写回调需要看到最新清单：ref 镜像，避免闭包捕获旧 state。
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const handleToggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 模拟宿主 readGlobalMemory：短延迟让 loading 态可被观测；unknown id 返回 null。
  const handleReadMemoryContent = useCallback(async (id: string): Promise<string | null> => {
    await delay(80);
    return entriesRef.current.find((entry) => entry.id === id)?.content ?? null;
  }, []);

  const memories: readonly GlobalMemoryEntryMeta[] = entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    chars: entry.content.length,
    updatedAt: 1,
  }));

  // ── 模拟宿主 mutation 回调（createGlobalMemory / writeGlobalMemory / deleteGlobalMemory）──
  const handleCreate = async (input: V4ComposerMemoryDraftInput): Promise<boolean> => {
    await delay(40);
    const id = `new-${slugRef.current++}`;
    setEntries((prev) => [
      ...prev,
      {
        id,
        name: input.name,
        description: input.description || undefined,
        content: input.content,
      },
    ]);
    return true;
  };
  const handleUpdate = async (
    memoryId: string,
    input: V4ComposerMemoryDraftInput,
  ): Promise<boolean> => {
    await delay(40);
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === memoryId
          ? {
              ...entry,
              name: input.name || entry.id,
              description: input.description || undefined,
              content: input.content,
            }
          : entry,
      ),
    );
    return true;
  };
  const handleDelete = async (memoryId: string): Promise<boolean> => {
    await delay(40);
    setEntries((prev) => prev.filter((entry) => entry.id !== memoryId));
    return true;
  };

  return (
    <ZCodeIntlProvider initialLocale="en-US">
      {/* 生产树由更高层的 TooltipProvider 覆盖 ControlHintTooltip；fixture 等价补上。 */}
      <TooltipProvider>
        <div className="min-h-screen bg-background p-8">
          <V4ComposerMemoryPicker
            memories={memories}
            loading={false}
            error={null}
            selectedIds={selected}
            onToggle={handleToggle}
            onReadMemoryContent={handleReadMemoryContent}
            onCreateMemory={handleCreate}
            onUpdateMemory={handleUpdate}
            onDeleteMemory={handleDelete}
            disabled={false}
          />
        </div>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
