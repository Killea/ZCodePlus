---
title: 多条全局记忆（Multi Global Memory）— 协议、CLI、设置页与 Composer
description: 全局记忆从单文件 MEMORY.md 扩展为一个目录多条 Markdown 记忆，支持逐条选择注入。默认仅记录设计，不改动代码。
status: active
last_updated: 2026-11-24
---

# 多条全局记忆设计

> **作用域**：仅用户级（global），不涉及 workspace/project memory。

## 现状（单文件基线）

| 层 | 现状 |
| --- | --- |
| 存储 | `~/.zcode/cli/memories/global/MEMORY.md` 单文件，`GLOBAL_MEMORY_CHARACTER_LIMIT = 20480` |
| CLI 注入 | `buildGlobalMemorySection` 单 section；`turnGlobalMemoryIncluded` 逐轮 bool |
| Composer | `V4ComposerGlobalMemorySwitch` 单选开关 → `includeGlobalMemory` |
| 设置页 | `GlobalMemoryEditor` 单 textarea |
| 服务 | `IMemoryService.readGlobalMemoryFile / writeGlobalMemoryFile`（`MEMORY.md` 专用） |

## 产品规则

1. **存储模型**：目录 `~/.zcode/cli/memories/global/`，一条记忆一个 `.md` 文件。
2. **存量 `MEMORY.md` 永久映射 id `default`**——零迁移。`default` 是**保留 id**：服务层 `create` 拒绝该 id；扫描时忽略同目录 `default.md`（防止与 `MEMORY.md` 双映射同 id）。删除 `default` 即删除 `MEMORY.md`，允许。
3. **slug 校验**：`^[a-z0-9][a-z0-9-]{0,39}$`（小写字母数字连字符，1–40 字符）。服务层与 CLI 注入侧各自强制校验——id 来自 wire/文件名，未通过校验的一律不拼路径（防目录穿越）。
4. **文件结构 = frontmatter + body**：
   ```
   ---
   name: <显示名>
   description: <可选描述>
   ---

   <body>
   ```
   frontmatter 只认 `name`/`description` 两个键；文件首行必须是 `---` 才尝试解析，缺省回退文件名/`default` 的本地化显示名。服务是唯一写路径，`write` 重组 canonical frontmatter，未知 frontmatter 键随写回规范化丢弃。
5. **单文件 body ≤ 20480 字符**（含 `MEMORY.md` 既有语义，frontmatter 不计入；2026-11-24 自 2048 上调）；`name ≤ 80`、`description ≤ 200` 字符。
6. **静态加密**：`.md` 文件整体落盘为 `enc:v1:` 前缀的 AES-256-GCM 密文（复用 `credentialCipherProvider` 线格式：`<iv>.<authTag>.<cipherText>` base64url；密钥 = `sha256(ZCODE_CREDENTIAL_SECRET || zcode-credential-fallback:{platform}:{homedir}:{username})`，与 credentials.json 同一口径）。服务层与 CLI 注入侧各自实现同格式 codec，读时无 `enc:v1:` 前缀按明文透明兼容；**明文文件在任一读写入口触发就地迁移**——先内存 roundtrip 验证密文可解，再 atomic 替换原文。解密失败：list/注入静默跳过（warn），单条 read 抛解密错误。文件名保持明文 slug（仅泄漏条目存在性，不泄漏内容）；工作区 `memory/` 不在本范围。**安全边界**：密钥可由同用户进程按公开公式推导，防的是文件内容被其他工具/备份直接读走，不是防同用户定向攻击；后续可升级 OS 钥匙串托管密钥。
7. **上限**：记忆总条数不限——默认不注入任何全局记忆、用户逐条 opt-in 才发送，总量与 context 体积无关；仅保留单轮最多选 4 条注入。
7. **注入 = 每轮 opt-in，不落库**：勾选集合仅 Composer 组件态，发送成功复位；协议携带 `includedGlobalMemoryIds?: string[]`（保留 `includeGlobalMemory?: boolean` 兼容）。
8. **语义（ids 权威）**：
   - ids 非空 → 注入所选（按 ids 顺序）；
   - ids = `[]` → 显式不注入（即便 bool 为 true）；
   - ids 缺失 + `includeGlobalMemory: true` → `["default"]`（旧客户端兼容）；
   - ids 与 bool 均缺失 → 不注入。
9. **无效 id 静默跳过**：重复去重（保序）、已删除/非法 id 不报错、不阻断 turn；全部无效 → 不注入，不生成空段。
10. **全局记忆默认常开，不提供关闭开关**（2026-10-26 起）：`AppSettings.globalMemoryEnabled` 总开关整体移除——设置页开关、`AppSettings` 协议字段、`ZCodeSessionRuntimePreferencesResult.globalMemoryEnabled` 字段、host→CLI 运行时门控全部删除；desktop 链路 CLI `runtimeConfig.memory.globalEnabled` 恒为 `true`，CLI 总是读取记忆目录并可用。唯一用户控制点是 composer 逐条 opt-in（空选择 = 本轮不注入）。旧持久化 settings 中的 `globalMemoryEnabled` 键在解析边界被忽略（未知字段剥离）；旧 intent/row 的 `includeGlobalMemory` 布尔兼容分支保留不变。TUI/CLI 独立链路（本就没有此开关）行为不变。
11. **排序**：`default` 固定列表首位，其余按 `name` localeCompare + id 兜底——与 updatedAt 抖动解耦，列表确定。
12. **创建**：UI 只填 name（+可选 description/content）；slug 由服务从 name 规范化派生，冲突自动追加 `-2`/`-3`…直至唯一。
13. **空记忆**：body 为空的条目照常出现在列表与 picker；注入时按空块处理。

## Agent 端注入结构

单个 `# Global Memory` dynamic system section：

```
You have a global memory directory shared across ALL workspaces and conversations at `<dir>`.
Each memory is one Markdown file; the entries selected for this turn are shown below.

Rules:
- Only edit files under this directory when the user explicitly asks you to remember or save
  something globally. Do not modify them on your own initiative.
- Keep each file at or under 20480 characters (frontmatter excluded).
- To add a memory, create `<slug>.md` where slug is lowercase letters/digits/hyphens (1-40 chars).

Contents of <path/to/MEMORY.md> (global memory "<name>"):
<body>

Contents of <path/to/foo.md> (global memory "<name>"):
<body>
```

- 注入顺序 = ids 顺序。
- Agent 收到的是选中正文与目录规则，不收到未选中记忆的清单。

## 接口与数据结构

### CLI core

- `memory/global-content.ts`：
  - `GLOBAL_MEMORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/`
  - `GLOBAL_MEMORY_DEFAULT_ID = "default"`、`GLOBAL_MEMORY_SELECTION_LIMIT = 4`
  - `resolveGlobalMemoryEntryPath(dir, id)`：`default → <dir>/MEMORY.md`；`<slug> → <dir>/<slug>.md`；id 不通过 pattern → `undefined`
  - `readGlobalMemoryEntries(dir, ids, fileSystemPort)`：按序读取，ENOENT/IO 失败静默跳过，返回 `GlobalMemoryEntryInjection[] = { id, filePath, content(已 format) }`
  - `formatGlobalMemoryContent` 沿用（body 截断逻辑不变）
- `runtime/internal.ts` + `agent-runtime.ts`：
  - `globalMemoryDir?: string | null`（`undefined` = 未解析、`null` = 禁用或目录缺失、string = 可用）——替代 `globalMemoryFile`/`globalMemoryContent`
  - `turnSelectedGlobalMemoryIds: readonly string[]`——替代 `turnGlobalMemoryIncluded`；**在任何 await 之前同步冻结**（沿用既有规则）
  - `turnGlobalMemories: readonly GlobalMemoryEntryInjection[]`——context_initialization 阶段按 ids 经 `fileSystemPort.readTextFile` 加载
- `methods/turn.ts`：冻结顺序 `ids 非空 → ids`；`ids === []` → `[]`；缺 ids → `includeGlobalMemory === true ? ["default"] : []`。context_initialization 阶段 `turnSelectedGlobalMemoryIds.length > 0` 时加载。
- `methods/context.ts` / `context-refresh.ts` / `context/types.ts` / `context/builder.ts`：`globalMemoryDir` + `turnGlobalMemories` 经 builder config 传递；`globalMemories.length > 0 && globalMemoryDir` 时注入。context-refresh 复用 **turn 快照**（不重读磁盘）。
- `sections/global-memory.ts`：`buildGlobalMemorySection({ dir, memories })` → `ContextSection | null`。

### 协议

- `packages/shared/src/zcode-protocol-v4/command.ts` `sendText`：`includedGlobalMemoryIds: z.array(z.string().regex(GLOBAL_MEMORY_ID_PATTERN)).max(4).optional()`。`sendGoalCommand`/`createSession.firstInput` 不扩展（与 `includeGlobalMemory` 现有暴露面一致）。
- `packages/shared/src/zcode-protocol-v4/input-intent.ts` `conversationInputIntentSchema`：同名字段（queue 持久化与 promotion 透传）。
- `apps/zcode-cli/packages/contracts` `TurnInputIntentMetadata`：`includedGlobalMemoryIds?: readonly string[]`。
- `bootstrap/commands/input-intent.ts`：`CanonicalCommandIntent` + `inputIntentMetadata` + `inputIntentMetadataFromCanonical` + `inputIntentMetadataFromQueueItem` 四处透传。
- `bootstrap/.../session-flow.ts`：`payload.includedGlobalMemoryIds → submissionIntent`。
- CLI runtime 侧不信任 wire：校验 pattern + 去重保序，非法 id 静默丢弃（不报错）。

### 服务（`IMemoryService`）

```ts
interface GlobalMemoryEntryMeta {
  id: string;              // "default" 或 slug
  name: string;            // frontmatter.name 或 id；default 未命名（name === id）时的本地化显示名由 UI 提供
  description?: string;
  chars: number;           // body 字符数
  updatedAt: number | null;
}
interface GlobalMemoryEntry extends GlobalMemoryEntryMeta {
  content: string;         // body（frontmatter 之后）
}

listGlobalMemories(): Promise<GlobalMemoryEntryMeta[]>            // 规则 11 排序
readGlobalMemory({id}): Promise<GlobalMemoryEntry & {exists: boolean}>
writeGlobalMemory({id, name?, description?, content}): Promise<{updatedAt}>   // 重组 canonical frontmatter → 整体加密落盘
createGlobalMemory({name, description?, content?}): Promise<{id}>             // slug 派生 + 冲突消解
deleteGlobalMemory({id}): Promise<void>
// 兼容保留：readGlobalMemoryFile / writeGlobalMemoryFile = default 别名（接口仍明文，落盘自动加/解密）
```

错误码（沿用 `ServiceError` 模式）：`GLOBAL_MEMORY_CHARACTER_LIMIT_EXCEEDED`（已有）、`GLOBAL_MEMORY_ID_INVALID`、`GLOBAL_MEMORY_NOT_FOUND`。

- `list`：扫描 `*.md`；`MEMORY.md → default`；`default.md` 忽略；basename 不匹配 slug pattern 的文件忽略。
- `create`：无条数上限；`mkdir -p` 目录后整体加密 + atomic 写入。
- `write`/`delete`/`read`：id 校验失败 → `GLOBAL_MEMORY_ID_INVALID`；文件不存在 → `GLOBAL_MEMORY_NOT_FOUND`（read 返回 `exists:false` 兼容现状）。**write 例外**：`default` 缺失时允许创建（保留 `writeGlobalMemoryFile`「首次保存即创建」兼容语义）；非 default 缺失 → `GLOBAL_MEMORY_NOT_FOUND`，防止 write 绕过 create 的 slug 派生。目标为 symlink/非普通文件一律拒绝。
- 远端（web/mobile）沿用现有 IMemoryService 代理通道；`~/.zcode/cli/memories/global/` 解析在宿主侧。

## UI

### Composer — `V4ComposerMemoryPicker`

- memoryService 可用即渲染 Brain 图标按钮 + 勾选计数 badge（无总开关门控，2026-10-26 起恒显）；`data-testid="v4-composer-memory-picker"`。
- DropdownMenu 打开时 `listGlobalMemories()` 拉取最新清单；`DropdownMenuCheckboxItem` 逐条；第 5 项勾选时未选项 disabled（上限 4）。
- **条目 hover 内容 tooltip**：hover 单条记忆时展示该记忆完整正文（`content`），供勾选前预览。
  - 正文**懒加载**：meta 列表不含 content，首次 hover 才经宿主注入的 `onReadMemoryContent(id)`（内部走 `readGlobalMemory`）拉取；picker 生命周期内按 id 缓存（菜单重开不重复请求，同一轮 hover 复用）。拉取失败/条目已删除 → 面板显示空内容占位，不报错。
  - 面板为 `position: fixed` 的自定义浮层（**不是** Radix Tooltip——modal DropdownMenu 会拦截其 hover 链路），`pointer-events: auto` 以支持指针移入面板与滚轮滚动；宽 ≤ 384px（视口不足时收缩）、高 ≤ 320px 且 `overflow-y: auto` 纵向滚动；正文 `whitespace-pre-wrap` 保留换行。
  - **滚轮必须手动落 scrollTop**：modal 弹层挂载 `react-remove-scroll`（背景滚动锁），其 document 级监听会 preventDefault 全页 wheel，而浮层不是它注册的 shard——默认滚动被抑制。面板挂 `passive: false` 的原生 wheel 监听，把 `deltaY`（按 `deltaMode` 折算）累加到滚动容器 `scrollTop`。缺这一步时滚轮/触控板在真实 app 里无法滚动正文（浏览器验收用例覆盖）。
  - 定位：默认贴在条目下方，条目靠近视口底部时翻转到上方，水平方向 clamp 进视口。
  - 关闭：指针移出条目与面板后 150ms 宽限期关闭（覆盖两者之间的间隙移动）；菜单关闭立即关闭；触屏（coarse pointer）不展示（无 hover 语义）。
  - 上限 disabled（第 5 条起）的条目同样可 hover 预览——信息展示与可勾选性解耦。
- `ConversationComposer` 状态 `globalMemorySelectedIds: ReadonlySet<string>`（替代 `globalMemoryOptIn`）；发送 payload `includedGlobalMemoryIds: [...ids]`（空集不写字段），随 `...submission` 扩散到全部 sendText 站点；**发送成功复位为空集**（沿用 optIn 复位点）。
- `ComposerSubmissionConfig.includedGlobalMemoryIds?: string[]`——发送方冻结，与 includeGlobalMemory 同生命周期。
- 勾选的记忆在发送前被删（另一窗口/CLI）→ 照常发送，CLI 静默跳过。
- 发送后 `userInput` row 携带 `includedGlobalMemoryIds`（有序）；消息气泡渲染「携带全局记忆（N）」chip，悬浮卡按 id 列出当前记忆名称（`default` 未命名时显示本地化「默认」，已删除条目回退 id）。冷恢复从持久化的 `conversationInputIntent` 还原同一字段，保证历史消息与实时投影一致。

### 设置页 Global tab

- 列表：name、description、chars、updatedAt；`data-testid="settings-global-memory-list"`。`default` 与其他条目同规则：有自定义 name 显示自定义名，未命名（name 回退为 id）时才显示本地化 "默认"；picker 同样口径。
- 列表标题旁 info 图标（`data-testid="settings-global-memory-prompt-info"`）：悬浮说明 Prompt 注入范围——仅本轮勾选（≤4 条）、发送文件全文（frontmatter 的 name/description + 正文）、段标题用 id；在此编辑不会立即发送。
- 新建：inline 表单 name + description + content；`data-testid="settings-global-memory-create"`。新建期间列表不保留选中高亮、已选条目编辑器收起；点击列表条目视为放弃新建并切换选中。
- 点击条目进入编辑（`GlobalMemoryEditor` 按 `memoryId` 泛化：name/description/content 三字段 + 20480 计数 + 保存）。
- 删除：AlertDialog 确认；`default` 亦可删（删 MEMORY.md）。
- 无总开关（2026-10-26 起移除）：列表恒可编辑，`GlobalMemoryManager` 不再有 `disabled` 门控。

## 明确不做

- 不做「每条记忆独立默认开启」或 picker 勾选持久化；
- 不改 workspace 级 memory 现状；
- 不做记忆目录云同步/备份；
- 不做 id 重命名、记忆合并/拆分；
- 不给 `sendGoalCommand` / `createSession.firstInput` 扩展 ids（保持与 bool 一致的暴露面）。

## 验收

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`
- `pnpm --dir apps/zcode-cli typecheck` / `lint` / 受影响包测试
- 新增回归覆盖：
  - 服务：slug 校验、目录扫描、`MEMORY.md ↔ default` 映射、`default.md` 忽略、frontmatter 解析与回退、body 截断、create 无条数上限、冲突派生、delete default、落盘密文格式、明文就地迁移、坏密文跳过。
  - CLI：注入侧解密注入、明文文件注入后就地加密、坏密文静默跳过。
  - 协议：旧 bool → `["default"]` 映射；`[]` 显式无注入；ids 去重保序；非法 id 跳过；schema `.max(4)`。
  - CLI：选中注入顺序、全部无效 id 不注入、turn 快照在 context-refresh 中稳定。
  - UI：picker 序列化、第 5 项 disabled、发送成功复位、设置页列表/新建/编辑/删除。
