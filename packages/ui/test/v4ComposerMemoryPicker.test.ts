// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_V4_COMPOSER_MEMORY_PICKER } from "@zcode/shared/test-ids";
import type { GlobalMemoryEntryMeta } from "@zcode/services";

vi.mock("@/i18n/IntlProvider.js", () => {
  const intl = {
    formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
      values
        ? `${id}:${Object.entries(values)
            .map(([key, value]) => `${key}=${value}`)
            .join(",")}`
        : id,
  };
  return {
    useZCodeIntl: () => ({ locale: "zh-CN", intl }),
  };
});

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

import { V4ComposerMemoryPicker } from "@/v4/composer/V4ComposerMemoryPicker.js";

const entries: GlobalMemoryEntryMeta[] = [
  { id: "default", name: "default", chars: 10, updatedAt: 1 },
  { id: "code-style", name: "Code Style", chars: 20, updatedAt: 2 },
  { id: "deploy", name: "Deploy", description: "部署备忘", chars: 30, updatedAt: 3 },
  { id: "api", name: "API", chars: 40, updatedAt: 4 },
  { id: "db", name: "DB", chars: 50, updatedAt: 5 },
];

function renderPicker(props?: {
  memories?: readonly GlobalMemoryEntryMeta[];
  loading?: boolean;
  error?: string | null;
  selectedIds?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const onToggle = props?.onToggle ?? vi.fn();
  render(
    createElement(V4ComposerMemoryPicker, {
      memories: props?.memories ?? entries,
      loading: props?.loading ?? false,
      error: props?.error ?? null,
      selectedIds: props?.selectedIds ?? new Set<string>(),
      onToggle,
      onMenuOpenChange: props?.onMenuOpenChange,
    }),
  );
  return { onToggle };
}

async function openMenu() {
  fireEvent.pointerDown(screen.getByTestId(TID_V4_COMPOSER_MEMORY_PICKER), {
    button: 0,
    ctrlKey: false,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("V4ComposerMemoryPicker", () => {
  it("菜单打开拉取清单并渲染条目；勾选回调携带 id", async () => {
    const onMenuOpenChange = vi.fn();
    const { onToggle } = renderPicker({ onMenuOpenChange });
    await openMenu();

    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
    const item = await screen.findByTestId(`${TID_V4_COMPOSER_MEMORY_PICKER}-item-code-style`);
    fireEvent.click(item);
    expect(onToggle).toHaveBeenCalledWith("code-style");
  });

  it("default 条目显示本地化名称而非 slug", async () => {
    renderPicker();
    await openMenu();

    const item = await screen.findByTestId(`${TID_V4_COMPOSER_MEMORY_PICKER}-item-default`);
    expect(item.textContent).toContain("chat.toolbar.memory.defaultName");
  });

  it("default 条目有自定义 name 时显示自定义名", async () => {
    renderPicker({
      memories: [{ id: "default", name: "开发机器", chars: 10, updatedAt: 1 }, ...entries.slice(1)],
    });
    await openMenu();

    const item = await screen.findByTestId(`${TID_V4_COMPOSER_MEMORY_PICKER}-item-default`);
    expect(item.textContent).toContain("开发机器");
    expect(item.textContent).not.toContain("chat.toolbar.memory.defaultName");
  });

  it("已选 4 条时未勾选项禁用且显示上限提示", async () => {
    renderPicker({
      selectedIds: new Set(["default", "code-style", "deploy", "api"]),
    });
    await openMenu();

    const fifth = await screen.findByTestId(`${TID_V4_COMPOSER_MEMORY_PICKER}-item-db`);
    expect(fifth.getAttribute("aria-disabled")).toBe("true");
    expect(fifth.textContent).toContain("chat.toolbar.memory.limitReached:max=4");
    // 已勾选项仍可取消。
    const checked = screen.getByTestId(`${TID_V4_COMPOSER_MEMORY_PICKER}-item-api`);
    expect(checked.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("loading / error / empty 三态", async () => {
    const { unmount } = render(
      createElement(V4ComposerMemoryPicker, {
        memories: [],
        loading: true,
        error: null,
        selectedIds: new Set<string>(),
        onToggle: vi.fn(),
      }),
    );
    await openMenu();
    expect(screen.getByText("common.loading")).toBeTruthy();
    unmount();

    render(
      createElement(V4ComposerMemoryPicker, {
        memories: [],
        loading: false,
        error: "boom",
        selectedIds: new Set<string>(),
        onToggle: vi.fn(),
      }),
    );
    await openMenu();
    expect(screen.getByText("chat.toolbar.memory.error")).toBeTruthy();
    cleanup();

    render(
      createElement(V4ComposerMemoryPicker, {
        memories: [],
        loading: false,
        error: null,
        selectedIds: new Set<string>(),
        onToggle: vi.fn(),
      }),
    );
    await openMenu();
    expect(screen.getByText("chat.toolbar.memory.empty")).toBeTruthy();
  });

  it("trigger 标签反映已选数量", () => {
    renderPicker({ selectedIds: new Set(["a", "b"]) });
    expect(screen.getByTestId(TID_V4_COMPOSER_MEMORY_PICKER).textContent).toBe(
      "chat.toolbar.memory.labelSelected:count=2",
    );
  });
});
