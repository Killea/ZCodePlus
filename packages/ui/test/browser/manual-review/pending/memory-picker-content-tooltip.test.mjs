// 浏览器验收：V4ComposerMemoryPicker 条目 hover 内容浮层
// （docs/global-memory-multi.md「条目 hover 内容 tooltip」）。
// 覆盖：完整正文展示（不截断）、侧放不叠菜单、纵向滚动、空内容占位、
// 指针离开宽限期关闭、菜单关闭立即关闭、快速增删改/复制（新建/编辑/复制/
// 删除/空名拦截）。运行：node --test memory-picker-content-tooltip.test.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/memory-picker-content-tooltip.fixture.tsx";
const LAST_LINE = "第 40 行内容";
let server;
let browser;
let origin;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "memory-picker-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openMenu(page) {
  await page.getByRole("button", { name: "Memories", exact: true }).click();
  await page
    .locator('[data-testid="v4-composer-memory-picker-item-long"]')
    .waitFor({ state: "visible" });
}

// 重新打开菜单（弹层关闭后菜单处于关闭态）。
async function reopenMenu(page) {
  await page.getByRole("button", { name: "Memories", exact: true }).click();
  await page
    .locator('[data-testid="v4-composer-memory-picker-content"]')
    .waitFor({ state: "visible" });
}

test("hover 展示完整正文（含末行，不截断）且面板定位在视口内", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    const item = page.locator('[data-testid="v4-composer-memory-picker-item-long"]');
    await item.hover();
    const detail = page.locator('[data-testid="v4-composer-memory-picker-detail"]');
    await detail.waitFor({ state: "visible" });
    // fixture 懒加载延迟 80ms：末行出现 = loading 结束且全文渲染（未截断）。
    await detail.getByText(LAST_LINE, { exact: false }).waitFor({ state: "visible" });
    const box = await detail.boundingBox();
    assert.ok(box, "浮层应有几何盒");
    assert.ok(box.x >= 0 && box.y >= 0, "浮层不超出视口左上");
    assert.ok(box.width + box.x <= 1200 && box.height + box.y <= 800, "浮层不超出视口边界");
    // 侧放核心验收：浮层与菜单本体不得重叠（初版「贴条目下方」会盖住列表其余条目）。
    const menuBox = await page
      .locator('[data-testid="v4-composer-memory-picker-content"]')
      .boundingBox();
    assert.ok(menuBox, "菜单本体应有几何盒");
    const intersects =
      box.x < menuBox.x + menuBox.width &&
      box.x + box.width > menuBox.x &&
      box.y < menuBox.y + menuBox.height &&
      box.y + box.height > menuBox.y;
    assert.ok(
      !intersects,
      `浮层与菜单本体重叠：panel ${JSON.stringify(box)} vs menu ${JSON.stringify(menuBox)}`,
    );
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});

test("长正文面板可纵向滚动（滚轮改变 scrollTop）", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    const item = page.locator('[data-testid="v4-composer-memory-picker-item-long"]');
    await item.hover();
    const detail = page.locator('[data-testid="v4-composer-memory-picker-detail"]');
    await detail.getByText(LAST_LINE, { exact: false }).waitFor({ state: "visible" });
    const scrollState = await detail
      .locator(".overflow-y-auto")
      .first()
      .evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    assert.ok(
      scrollState.scrollHeight > scrollState.clientHeight,
      `内容应超出一屏（scrollHeight ${scrollState.scrollHeight} vs clientHeight ${scrollState.clientHeight}）`,
    );
    const detailBox = await detail.boundingBox();
    const centerX = detailBox.x + detailBox.width / 2;
    const centerY = detailBox.y + detailBox.height / 2;
    await page.mouse.move(centerX, centerY);
    await page.mouse.wheel(0, 240);
    const after = await detail
      .locator(".overflow-y-auto")
      .first()
      .evaluate((el) => el.scrollTop);
    assert.ok(after > 0, `滚轮后 scrollTop 应 > 0，实际 ${after}`);
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});

test("空正文显示占位文案", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    const item = page.locator('[data-testid="v4-composer-memory-picker-item-empty-memory"]');
    await item.hover();
    const detail = page.locator('[data-testid="v4-composer-memory-picker-detail"]');
    await detail.waitFor({ state: "visible" });
    await detail.getByText("(no content)", { exact: true }).waitFor({ state: "visible" });
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});

test("指针移出后按宽限期关闭浮层（菜单本身保持打开）", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    const item = page.locator('[data-testid="v4-composer-memory-picker-item-short"]');
    await item.hover();
    const detail = page.locator('[data-testid="v4-composer-memory-picker-detail"]');
    await detail.getByText("短记忆", { exact: false }).waitFor({ state: "visible" });
    // 移到菜单与浮层之外的空白处：150ms 宽限期后浮层关闭。
    await page.mouse.move(1100, 700);
    await page.waitForTimeout(400);
    assert.equal(await detail.count(), 0, "浮层应已卸载");
    // 菜单本身不因浮层关闭而消失（未点击，Radix 不关闭）。
    assert.ok(
      await page.locator('[data-testid="v4-composer-memory-picker-item-short"]').isVisible(),
      "菜单应保持打开",
    );
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});

test("菜单关闭时浮层立即关闭", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    const item = page.locator('[data-testid="v4-composer-memory-picker-item-short"]');
    await item.hover();
    const detail = page.locator('[data-testid="v4-composer-memory-picker-detail"]');
    await detail.getByText("短记忆", { exact: false }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert.equal(await detail.count(), 0, "Esc 关闭菜单后浮层应立即卸载");
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});

// ── 快速增删改/复制（docs/global-memory-multi.md「picker 内快速增删改/复制」）──
// fixture 为有状态模拟宿主：create 派生 id new-N，update/delete 就地改列表。

test("快速新建：顶部「新建记忆」→ 保存后新条目入列", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    // 点「新建记忆」：菜单关闭、编辑框打开。
    await page.locator('[data-testid="v4-composer-memory-picker-new"]').click();
    const nameInput = page.locator('[data-testid="v4-composer-memory-picker-dialog-name"]');
    await nameInput.waitFor({ state: "visible" });
    await nameInput.fill("Fresh memory");
    await page
      .locator('[data-testid="v4-composer-memory-picker-dialog-content"]')
      .fill("fresh content line");
    await page.locator('[data-testid="v4-composer-memory-picker-dialog-save"]').click();
    await nameInput.waitFor({ state: "hidden" });
    // 重开菜单：新条目入列（fixture 派生 id new-1）。
    await reopenMenu(page);
    const newItem = page.locator('[data-testid="v4-composer-memory-picker-item-new-1"]');
    await newItem.waitFor({ state: "visible" });
    assert.ok(await newItem.getByText("Fresh memory").isVisible(), "新条目应显示对话框填写的名称");
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});

test("快速编辑：条目 hover 操作条 → 预填编辑框 → 保存后正文更新", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    const item = page.locator('[data-testid="v4-composer-memory-picker-item-short"]');
    await item.hover();
    const stateBefore = await item.getAttribute("data-state");
    await page.locator('[data-testid="v4-composer-memory-picker-item-short-action-edit"]').click();
    const nameInput = page.locator('[data-testid="v4-composer-memory-picker-dialog-name"]');
    await nameInput.waitFor({ state: "visible" });
    assert.equal(await nameInput.inputValue(), "Short memory", "编辑应预填条目名称");
    const contentInput = page.locator('[data-testid="v4-composer-memory-picker-dialog-content"]');
    assert.ok((await contentInput.inputValue()).includes("短记忆"), "编辑应预填正文");
    await contentInput.fill("更新后的内容");
    await page.locator('[data-testid="v4-composer-memory-picker-dialog-save"]').click();
    await nameInput.waitFor({ state: "hidden" });
    // 重开菜单：操作条点击不得误勾选；hover 预览应为新正文（编辑后缓存已失效）。
    await reopenMenu(page);
    const itemAfter = page.locator('[data-testid="v4-composer-memory-picker-item-short"]');
    await itemAfter.waitFor({ state: "visible" });
    assert.equal(
      await itemAfter.getAttribute("data-state"),
      stateBefore,
      "操作条点击不得误切换勾选",
    );
    await itemAfter.hover();
    const detail = page.locator('[data-testid="v4-composer-memory-picker-detail"]');
    await detail.getByText("更新后的内容", { exact: true }).waitFor({ state: "visible" });
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});

test("快速复制：预填源条目正文与「名称+后缀」→ 保存后列表新增一条", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    const item = page.locator('[data-testid="v4-composer-memory-picker-item-short"]');
    await item.hover();
    await page
      .locator('[data-testid="v4-composer-memory-picker-item-short-action-duplicate"]')
      .click();
    const nameInput = page.locator('[data-testid="v4-composer-memory-picker-dialog-name"]');
    await nameInput.waitFor({ state: "visible" });
    assert.equal(
      await nameInput.inputValue(),
      "Short memory (copy)",
      "复制应预填「名称+（副本）」后缀",
    );
    const contentInput = page.locator('[data-testid="v4-composer-memory-picker-dialog-content"]');
    assert.ok((await contentInput.inputValue()).includes("短记忆"), "复制应预填源条目正文");
    // 复制走新建路径：标题是「新建」。
    assert.ok(
      await page
        .locator('[data-testid="v4-composer-memory-picker-dialog-title"]')
        .getByText("New global memory")
        .isVisible(),
      "复制弹层标题应为新建",
    );
    await page.locator('[data-testid="v4-composer-memory-picker-dialog-save"]').click();
    await nameInput.waitFor({ state: "hidden" });
    await reopenMenu(page);
    await page
      .locator('[data-testid="v4-composer-memory-picker-item-new-1"]')
      .waitFor({ state: "visible" });
    assert.ok(
      await page.locator('[data-testid="v4-composer-memory-picker-item-short"]').isVisible(),
      "源条目应仍存在",
    );
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});

test("快速删除：确认框 → 条目移除、列表更新", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    const item = page.locator('[data-testid="v4-composer-memory-picker-item-short"]');
    await item.hover();
    await page
      .locator('[data-testid="v4-composer-memory-picker-item-short-action-delete"]')
      .click();
    const confirm = page.locator('[data-testid="v4-composer-memory-picker-delete-confirm"]');
    await confirm.waitFor({ state: "visible" });
    assert.ok(await confirm.getByText("Short memory").isVisible(), "确认框应显示条目名称");
    await page.locator('[data-testid="v4-composer-memory-picker-delete-confirm-action"]').click();
    await confirm.waitFor({ state: "hidden" });
    await reopenMenu(page);
    await page
      .locator('[data-testid="v4-composer-memory-picker-item-long"]')
      .waitFor({ state: "visible" });
    assert.equal(
      await page.locator('[data-testid="v4-composer-memory-picker-item-short"]').count(),
      0,
      "被删条目应不存在",
    );
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});

test("新建对话框：空名称拦截保存（保存禁用、对话框保持打开；填名后放行）", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}fixture?`);
    await openMenu(page);
    await page.locator('[data-testid="v4-composer-memory-picker-new"]').click();
    const nameInput = page.locator('[data-testid="v4-composer-memory-picker-dialog-name"]');
    await nameInput.waitFor({ state: "visible" });
    const saveButton = page.locator('[data-testid="v4-composer-memory-picker-dialog-save"]');
    assert.ok(await saveButton.isDisabled(), "空名称时保存应禁用");
    assert.ok(await nameInput.isVisible(), "空名称时对话框应保持打开");
    await nameInput.fill("Named memory");
    assert.ok(!(await saveButton.isDisabled()), "填写名称后保存应放行");
  } finally {
    assert.equal(errors.length, 0, `pageerror: ${errors.join(" | ")}`);
    await page.close();
  }
});
