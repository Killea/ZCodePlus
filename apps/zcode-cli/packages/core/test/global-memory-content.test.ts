import assert from "node:assert/strict";
import test from "node:test";
import type { FileSystemPort } from "@zcode/contracts";
import {
  GLOBAL_MEMORY_CHARACTER_LIMIT,
  GLOBAL_MEMORY_DEFAULT_ID,
  GLOBAL_MEMORY_SELECTION_LIMIT,
  formatGlobalMemoryContent,
  normalizeGlobalMemoryIds,
  readGlobalMemoryEntries,
  resolveGlobalMemoryDir,
  resolveGlobalMemoryEntryPath,
  resolveGlobalMemoryFile,
} from "../src/memory/global-content.js";
import { createGlobalMemoryCipher } from "../src/memory/global-memory-cipher.js";

// 全局（跨工作区）记忆单文件的格式化/路径契约：
// 空内容 → 空串；未超限 → trim 原样；恰好 20480 → 不截断；超限 → 按行尾裁剪并附提示。
// 这些是"注入侧 20480 上限"的第一道防线，任何回归都会让主 agent 读到超长上下文。

test("空内容 / 纯空白返回空字符串", () => {
  assert.equal(formatGlobalMemoryContent(""), "");
  assert.equal(formatGlobalMemoryContent("   \n\t  \n "), "");
});

test("未超限时返回 trim 后的原文", () => {
  const content = "记住：用户偏好中文回复。";
  assert.equal(formatGlobalMemoryContent(`  ${content}\n\n`), content);
});

test("恰好 20480 字符不截断", () => {
  const content = "字".repeat(GLOBAL_MEMORY_CHARACTER_LIMIT);
  assert.equal(formatGlobalMemoryContent(content), content);
});

test("超过 20480 时截断并附说明，正文不超限", () => {
  const content = "字".repeat(GLOBAL_MEMORY_CHARACTER_LIMIT + 952); // 21432 字符，无换行
  const out = formatGlobalMemoryContent(content);
  assert.notEqual(out, content);
  assert.match(out, /truncated/);
  assert.ok(out.includes(String(GLOBAL_MEMORY_CHARACTER_LIMIT)));

  const noteIndex = out.indexOf("> [Global memory truncated");
  assert.ok(noteIndex > 0, "应包含截断说明行");
  const body = out.slice(0, noteIndex).trimEnd();
  assert.ok(body.length <= GLOBAL_MEMORY_CHARACTER_LIMIT, "正文部分不得超过上限");
});

test("截断优先保留完整行（不在行中间半切）", () => {
  // 20480 上限下必须构造超限内容：25×1000 + 24 换行 = 25024。
  // 截断后应保留 20 整行（20×1000 + 19 换行 = 20019 ≤ 20480，第 21 行被裁掉）。
  const line = "汉".repeat(1000);
  const content = Array.from({ length: 25 }, () => line).join("\n");
  const out = formatGlobalMemoryContent(content);
  const noteIndex = out.indexOf("> [Global memory truncated");
  assert.ok(noteIndex > 0);
  const body = out.slice(0, noteIndex).replace(/\n+$/u, "");
  const lines = body.split("\n");
  assert.ok(lines.length > 0);
  // 保留的应是若干整行，每行长度都是 1000 的整数倍（没有被半切的行）。
  for (const l of lines) {
    assert.equal(l.length % 1000, 0, `保留行长度应为 1000 的整数倍，实际 ${l.length}`);
  }
});

test("resolveGlobalMemoryDir / resolveGlobalMemoryFile 落在 global/MEMORY.md", () => {
  const root = "/home/u/.zcode/cli";
  assert.equal(resolveGlobalMemoryDir(root), "/home/u/.zcode/cli/memories/global");
  assert.equal(resolveGlobalMemoryFile(root), "/home/u/.zcode/cli/memories/global/MEMORY.md");
});

// ── 多条记忆：id → 路径映射 ──

const DIR = "/home/u/.zcode/cli/memories/global";

test("resolveGlobalMemoryEntryPath：default 永久映射 MEMORY.md", () => {
  assert.equal(
    resolveGlobalMemoryEntryPath(DIR, GLOBAL_MEMORY_DEFAULT_ID),
    `${DIR}/MEMORY.md`,
  );
});

test("resolveGlobalMemoryEntryPath：slug 映射 <slug>.md", () => {
  assert.equal(resolveGlobalMemoryEntryPath(DIR, "code-style"), `${DIR}/code-style.md`);
  assert.equal(resolveGlobalMemoryEntryPath(DIR, "a1-b2"), `${DIR}/a1-b2.md`);
});

test("resolveGlobalMemoryEntryPath：非法 id 返回 undefined（防目录穿越）", () => {
  for (const id of [
    "../etc/passwd",
    "..",
    "Foo",
    "UPPER",
    "a/b",
    "a b",
    "a..b",
    "-lead",
    "",
    "x".repeat(41),
    "default.md",
  ]) {
    assert.equal(resolveGlobalMemoryEntryPath(DIR, id), undefined, `id=${id}`);
  }
});

// ── normalizeGlobalMemoryIds ──

test("normalizeGlobalMemoryIds：undefined 透传（走 legacy bool 分支）", () => {
  assert.equal(normalizeGlobalMemoryIds(undefined), undefined);
});

test("normalizeGlobalMemoryIds：空数组 = 显式无注入", () => {
  assert.deepEqual(normalizeGlobalMemoryIds([]), []);
});

test("normalizeGlobalMemoryIds：去重保序 + 非法 id 静默丢弃", () => {
  assert.deepEqual(
    normalizeGlobalMemoryIds(["a", "b", "a", "../evil", "C", "default", "default"]),
    ["a", "b", "default"],
  );
});

test("normalizeGlobalMemoryIds：超过单轮上限截断", () => {
  const ids = Array.from({ length: GLOBAL_MEMORY_SELECTION_LIMIT + 3 }, (_, i) => `m${i}`);
  const out = normalizeGlobalMemoryIds(ids);
  assert.equal(out?.length, GLOBAL_MEMORY_SELECTION_LIMIT);
  assert.deepEqual(out, ids.slice(0, GLOBAL_MEMORY_SELECTION_LIMIT));
});

// ── readGlobalMemoryEntries ──

function stubFs(files: Record<string, string>) {
  return {
    writes: [] as Array<{ path: string; content: string }>,
    async readTextFile(request: { path: string }) {
      const content = files[request.path];
      if (content === undefined) throw new Error("ENOENT");
      return { content };
    },
    async writeTextFile(request: { path: string; content: string }) {
      this.writes.push({ path: request.path, content: request.content });
      files[request.path] = request.content;
      return { path: request.path, bytesWritten: request.content.length };
    },
  };
}

test("readGlobalMemoryEntries：按选择顺序返回并保留文件路径", async () => {
  const fs = stubFs({
    [`${DIR}/MEMORY.md`]: "默认内容",
    [`${DIR}/code-style.md`]: "风格内容",
  });
  // 桩只实现断言所需的最小面；运行时传入的是完整 FileSystemPort。
  const entries = await readGlobalMemoryEntries(
    DIR,
    ["code-style", "default"],
    fs as unknown as FileSystemPort,
  );
  assert.deepEqual(
    entries.map((e) => e.id),
    ["code-style", "default"],
  );
  assert.equal(entries[0].filePath, `${DIR}/code-style.md`);
  assert.equal(entries[0].content, "风格内容");
});

test("readGlobalMemoryEntries：缺失/非法 id 静默跳过", async () => {
  const fs = stubFs({ [`${DIR}/a.md`]: "A" });
  const entries = await readGlobalMemoryEntries(
    DIR,
    ["missing", "a", "../evil", "gone"],
    fs as unknown as FileSystemPort,
  );
  assert.deepEqual(
    entries.map((e) => e.id),
    ["a"],
  );
});

test("readGlobalMemoryEntries：全部无效 → 空数组（不产生空注入）", async () => {
  const fs = stubFs({});
  assert.deepEqual(await readGlobalMemoryEntries(DIR, ["x", "y"], fs as unknown as FileSystemPort), []);
  assert.deepEqual(await readGlobalMemoryEntries(DIR, [], fs as unknown as FileSystemPort), []);
  assert.deepEqual(await readGlobalMemoryEntries(DIR, ["a"], undefined), []);
});

// ── 静态加密（enc:v1 AES-256-GCM）──

test("cipher：encrypt 产出 enc:v1 密文，decrypt 还原；无前缀输入原样返回", () => {
  const cipher = createGlobalMemoryCipher({ env: { ZCODE_CREDENTIAL_SECRET: "s" } });
  const encrypted = cipher.encrypt("secret body");
  assert.ok(encrypted.startsWith("enc:v1:"));
  assert.ok(!encrypted.includes("secret body"));
  assert.equal(cipher.decrypt(encrypted), "secret body");
  assert.equal(cipher.decrypt("plain text"), "plain text");
});

test("cipher：同密钥跨实例互解（desktop 写、CLI 读同一文件的前提）", () => {
  const writer = createGlobalMemoryCipher({ env: { ZCODE_CREDENTIAL_SECRET: "k" } });
  const reader = createGlobalMemoryCipher({ env: { ZCODE_CREDENTIAL_SECRET: "k" } });
  assert.equal(reader.decrypt(writer.encrypt("跨进程")), "跨进程");
  const wrongKey = createGlobalMemoryCipher({ env: { ZCODE_CREDENTIAL_SECRET: "other" } });
  assert.throws(() => wrongKey.decrypt(writer.encrypt("x")));
});

test("readGlobalMemoryEntries：密文文件解密后注入", async () => {
  const cipher = createGlobalMemoryCipher({ env: { ZCODE_CREDENTIAL_SECRET: "s" } });
  const fs = stubFs({
    [`${DIR}/MEMORY.md`]: cipher.encrypt("加密后的默认内容"),
  });
  const entries = await readGlobalMemoryEntries(
    DIR,
    ["default"],
    fs as unknown as FileSystemPort,
    cipher,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, "加密后的默认内容");
});

test("readGlobalMemoryEntries：明文文件注入后就地加密为 enc:v1", async () => {
  const cipher = createGlobalMemoryCipher({ env: { ZCODE_CREDENTIAL_SECRET: "s" } });
  const fs = stubFs({ [`${DIR}/note.md`]: "待加密的明文" });
  const entries = await readGlobalMemoryEntries(
    DIR,
    ["note"],
    fs as unknown as FileSystemPort,
    cipher,
  );
  assert.equal(entries[0].content, "待加密的明文");

  assert.equal(fs.writes.length, 1);
  const stored = fs.writes[0].content;
  assert.ok(stored.startsWith("enc:v1:"));
  assert.ok(!stored.includes("待加密的明文"));
  assert.equal(cipher.decrypt(stored), "待加密的明文");
});

test("readGlobalMemoryEntries：坏密文/密钥不匹配静默跳过，且不覆写原文件", async () => {
  const cipher = createGlobalMemoryCipher({ env: { ZCODE_CREDENTIAL_SECRET: "s" } });
  const fs = stubFs({ [`${DIR}/bad.md`]: "enc:v1:AAAA.BBBB.CCCC" });
  const entries = await readGlobalMemoryEntries(
    DIR,
    ["bad"],
    fs as unknown as FileSystemPort,
    cipher,
  );
  assert.deepEqual(entries, []);
  assert.equal(fs.writes.length, 0);
});
