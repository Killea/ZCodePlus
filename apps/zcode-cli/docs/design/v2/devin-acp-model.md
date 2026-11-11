# Devin ACP Model Provider

## 状态

- L1 Candidate Contract。本文定义把本机 Devin CLI（`devin acp`）作为 ZCode 模型
  provider 接入的产品规则、状态所有者、接口与验收场景。
- 事实依据：对 devin-agent（`/home/hank/devin-agent`）的源码分析，以及对本机
  `devin 3000.11.3` 的 ACP 探针实测（initialize / authenticate / session/new）。
- Devin CLI 的 ACP 语义以 `devin-agent/docs/devin-cli.md` 路由镜像与
  `@agentclientprotocol/sdk` 类型为准；本文不复制其协议规范，只定义 ZCode 侧契约。

## 目标

用户在 ZCode 的模型选择里看到一个普通 provider：`Devin (local agent)`，其下有一个
模型 `swe-2-max`（显示名 `SWE-2 Max`）。选中后，ZCode 的每次模型调用驱动本机
`devin acp` 会话完成任务；桌面与手机远程网页走既有会话链路，无需特殊通道。

非目标：

- 不把 Devin 包装成 OpenAI/Anthropic HTTP API（无中间桥进程、无端口管理）。
- 不支持 Devin 的其他模型 UI（只暴露 `swe-2-max` 一个模型 id；实际解析交给 Devin）。
- 不支持远程 workspace 上的 Devin（本地 workspace 限定；远程 workspace 选择该模型
  直接报不可用，见「失败语义」）。
- 不实现 ZCode 原生工具对 Devin 的反向暴露（见「工具语义」分析）。
- 不实现 Devin session 的导入/导出 UI（`session/list` 等能力存在但不在本期）。

## 架构总览

```text
Renderer (desktop/web/phone)                    Host (desktop main)
  model selection {providerId:devin, swe-2-max} ──► window-scoped Local Host
                                                      │ stdio (zcode protocol)
                                                      ▼
                                           zcode-cli agent process
                                           cwd = workspacePath
                                                      │
                          modelFactory(selection)     │
                                                      ▼
                              adapters/model/devin-acp executor
                              (Model 接口: streamText/generateText)
                                                      │ spawn `devin acp`
                                                      ▼
                                           DevinAcpBridge (进程内)
                                           ndjson JSON-RPC stdin/stdout
                                           initialize → authenticate
                                           → session/new{cwd,mcpServers}
                                           → session/prompt ⇄ session/update
                                                      │
                                                      ▼
                                               devin CLI (本地 agent)
                                           SWE-2 系列模型 + 自有工具
```

要点：远程网页/手机 attach 的是桌面 Host 的会话运行时；`Model.streamText` 在
zcode-cli 进程内执行，`devin acp` 作为 CLI 的子进程在本机运行，远程端只看到普通
session 事件流，不需要任何协议扩展。

## 契约面改动

### provider-data-schema

`providerApiTypeDataSchema` 增加成员 `"devin-acp"`。该 api type 不需要
`baseUrl`/`headers`，但为了最小化 schema 破坏面，仍要求 `api` 对象存在：
`baseUrl` 写入哨兵值 `acp://devin`（通过 `z.string().url()` 校验），adapter 不读取。

`providerAccessDataSchema` 增加 discriminated variant：

```jsonc
{
  "type": "devin-acp",
  "binaryPath": "/abs/path/to/devin",      // 可选；缺省走 discovery
  "apiKey": "…",                           // 可选；Devin API key，走 authenticate meta.api_key
  "mode": "accept-edits",                  // 可选；Devin session mode
  "promptTimeoutMs": 7200000,              // 可选；默认 2 小时
  "mcpPassthrough": true,                  // 可选；默认 true
  "contextForward": "memory-only"          // 可选；memory-only|all-dynamic|none
}
```

新 class `DevinAcpAccessConfig extends ConfigOverlay`，接入
`ProviderAccessConfig` 联合、`serializeRegistryProviderConfig` 与各 form/resolve 分支。

### 内置模板与模型规则（本地 Overlay 层）

Devin 是本 fork 的私有 Provider，不能写进 `zcode-builtin.json`/`zcode-builtin.test.json`
参与远端 Release 的 revision 竞争——远端目录每次下发都会把本地条目顶掉。模板与规则
改为放在 `config/provider/zcode-local-overlay.json`，由
`NodeZCodeBuiltinProviderConfigSource` 在**快照层**叠加：

- Overlay 默认取 `bundledFilePath` 同目录的 `zcode-local-overlay.json`（可用
  `localOverlayFilePath` 覆盖或传 `null` 禁用）；文件缺失时等同无 Overlay。
- 文件结构与 Release 的 `config` 段相同（`providerConfigRules`/`modelConfigRules`），
  复用同一组 parse 函数与 Schema 校验。
- 合并语义：providers/providerTemplates 按 id overlay（Overlay 赢）；modelConfigRules
  追加在末尾（`resolve` 顺序 overlay，Overlay 规则后置生效）。snapshot `revision`
  保持 `zcode-builtin:<rev>:<sha256>` 形态，Overlay 内容哈希并入 key。
- Overlay 不写入 Active/LKG Release，也不参与 `applyRemoteRelease` 的同 revision
  冲突比较——远端目录照常更新，本地条目永远叠加。
- **Agent 传播**：物化 Active 时把 Overlay 随行复制到 Active 目录
  （`zcode-local-overlay.json`）。Agent/Worker 进程的 Source 以 Active 路径为
  bundledFilePath，其同目录默认查找即命中同一 Overlay；Bundled Overlay 移除时
  随行副本同步删除。
- 打包：`stageBuiltinProviderConfig` 把 Overlay 拷进 CLI `dist/provider/`；
  electron-builder `extraResources` 放到 `resources/config/provider/`。

Overlay 中的模板 `devin-acp`：

```jsonc
{
  "templateId": "devin-acp",
  "templateNameMap": { "zh-CN": "Devin (本地 Agent)", "en-US": "Devin (local agent)" },
  "config": {
    "access": { "type": "devin-acp" },
    "api": { "type": "devin-acp", "baseUrl": "acp://devin" },
    "builtinModelIds": ["swe-2-max"],
    "logo": { "type": "builtin", "key": "devin" }
  }
}
```

`modelConfigRules` 增加规则匹配 `.*swe-2.*`：

- `properties`：`supportsToolCall: true`（**必须 true**：runtime 每轮无条件向
  ModelRequest 注入工具契约，`validateRequestProperties` 在 `supportsToolCall:false`
  时会本地抛错；executor 忽略这些工具），`supportsImage` 随 Devin prompt capability。
- `optionSpecs`：`reasoningLevel.values` 至少一个合法值（`["default"]`；
  `validateOptions` 拒绝空值/非法值），`maxOutputTokens.max` 填名义上限（executor
  语义上不消费）。

### Executor 分发点

`AiSdkModelAdapter.createModel` 内部对 `providerConfig.api.type === "devin-acp"`
短路：不构造 AI SDK provider/fetch，改为构造 `DevinModelExecutor` 并走统一的
`createModel()` 包装（保留 ExecutableModel 的能力/option 校验与 `bind()`）。
`ApiProviderModelRuntime`、Registry、modelFactory 全部无感。

## 组件设计

### DevinAcpTransport

`adapters/src/model/devin-acp/transport.ts`。子进程 spawn（参数数组形式，遵守
跨平台规则），stdin/stdout ndjson JSON-RPC；可直接复用
`@agentclientprotocol/sdk`（devin-agent 已验证同一依赖）或自带最小
request/notification dispatch（frame 上限 4MB、stderr 截断 16KB、exit 归一化）。
spawn 选项：`command=devin binary 绝对路径`、`args=["acp","--model",<modelId>]`、
`cwd=workspacePath`（= zcode-cli 进程 cwd）。

### DevinAcpBridge

`modelFactory` 每次调用都会新建 `DevinModelExecutor`，但 bridge 不能随之新建：
spawn + initialize + authenticate 成本很高，且本机无 `credentials.toml` 时
`devin-browser` 方法每次都走浏览器 PKCE（"每次调用都弹登录"的根因）。
`DevinModelExecutor` 因此持有**模块级静态 bridge 池**，key =
{binaryPath, apiKey(sha256), modelId, mode, cwd, promptTimeoutMs, mcpPassthrough}；
同 key 的 executor 复用同一 `devin acp` 进程与 ACP session——authenticate
每 agent 进程生命周期至多一次，且 Devin 侧保留真实会话历史（不再每轮靠
序列化前缀冷启动）。池化复用时 `updateDeps` 刷新 listMcpServers/logger。

> 彻底免弹窗的另一条路径：用户执行一次 `devin auth login`（持久化
> `credentials.toml`，不过期）或在 access.apiKey 填 Devin API key
> （`meta.api_key` 通道，无浏览器）。两者都属用户侧选择，代码不代填。

进程内单例，管理 `devin acp` 生命周期与会话池：

```text
key = (providerId, traceContext.sessionId ?? "workspace:" + process.cwd())
value = { transport, acpSessionId, lastContextHash, busy }
```

- `initialize`：`protocolVersion:1`，`clientCapabilities:{}`（不广告 fs/terminal/
  elicitation → Devin 不发 elicitation、不请求 client 侧文件/终端操作）。
- `authenticate`：每次 spawn 后必调（实测无认证 `session/new` 返回 -32000）。
  `apiKey` 在场走 `{methodId:"devin-browser", meta:{api_key}}`；否则
  `{methodId:"devin-browser"}`——本机已有 ACP 凭证时秒回 `{}`；返回体含 URL
  时抛 `auth-required` 结构化错误携带 URL（见「认证」）。
- `session/new`：`{cwd: process.cwd(), mcpServers}`；`additionalDirectories`
  能力在场时透传 workspace 附加目录。结果缓存 `sessionId` 与
  `configOptions`（model/mode 当前值用于 UI 展示回读）。
- `session/set_config_option`：创建后按需写 `{configId:"model",value:modelId}`
  与 `{configId:"mode",value:access.mode}`（写入前比对 currentValue，相同跳过）。
- `session/load`：zcode session 持久化恢复且已知 `acpSessionId` 时优先 resume，
  失败回退 `session/new`（不回放历史，Devin 自行检查工作区）。
- 并发：同一 ACP session 的 `session/prompt` 串行（busy 守卫，排队而非拒绝；
  与 CommandInbox 串行语义一致）。不同 zcode sessionId 各自独立 acp session。
- 生命周期：随 zcode-cli 进程退出而 kill；`session/cancel` 走 notification，
  transport stop = close stdin → SIGTERM(1s) → SIGKILL(1s)。

### DevinModelExecutor（streamText）

```text
ModelRequest.messages
  ├─ system 消息 → contextForward 过滤 → ACP resource part（首发/变更时）
  ├─ 末尾 user 消息 → ACP text part（唯一必须发送的内容）
  └─ assistant/tool 历史 → 不发送（Devin session 自有记忆；首轮冷起除外见下）

session/update 通知 → ModelStreamEvent（交叉段必须各开递增 id 的块，
块序 = 到达序；共用固定 id 会让渲染层按块建序、把后建的块整段挪到结尾）
  ├─ agent_message_chunk   → text_delta
  ├─ agent_thought_chunk   → reasoning_delta
  ├─ tool_call/update    → 文本标记 `[devin tool] <title> (<终态>)`；
  │                        无标题纯心跳丢弃，同 toolCallId+title 去重（每工具一行），
  │                        in_progress/pending 状态不展示
  ├─ plan                → 文本标记；按格式化文本去重（内容不变只发一次）
  │                        ⚠ 绝不映射为 tool_call 事件（否则 zcode 尝试执行）
  ├─ usage_update          → finish.usage{contextTokens=used, contextWindow=size}
  │                        （ última del turno; NO entra en token ledger — ver
  │                        「Context meter」）
  └─ elicitation/request   → 自动回 `{action:"cancel"}`（兜底；正常不会到达）

session/prompt resolve → {type:"finish", finishReason, usage}
abortSignal            → session/cancel（notification）+ iterator return
promptTimeoutMs        → 同取消路径，error event 归类 timeout
```

首轮（新 acp session）且 messages 含历史时，由 executor 内的确定性
formatter（无模型调用）把 transcript 序列化+截断为一段 text 前缀随首个
prompt 发送：逐条 role 打标、assistant/user 文本截断到上限、tool 消息只留
一行执行摘要。这覆盖"中途切模型/恢复后 load 失败/compact 后"三类边角；
正常续聊发"最后一条 assistant 之后的全部未见消息"（steer/附件/
reminder 等多条都送达，非只发最后一条 user）。`embeddedContext` 为
resource part 的协议用途。

#### 历史同步校验（syncedHash）

bridge 为每个主会话 sessionKey 记录"Devin 已见历史前缀"指纹
（prompt 成功完成后写入）。续聊时若 ZCode 历史前缀 hash 与记录不一致
（编辑/回滚/fork/换模型后切回），先 `invalidateSession` 再走 isNew
全量路径——否则增量续聊会让 Devin 在错误历史上继续。

#### Sidecar 一次性 session

sidecar 的 sessionKey 稳定（`{sessionId}#{operation}`）但**每次调用
后在 finally 中 invalidate**：复用会让每次 compact 的完整转录在同一
ACP session 里累积膨胀并互相污染。sidecar 流中 `[devin tool]`/`[plan]`
标记不写入文本输出（标题/摘要里出现工具标记即坏数据）。
已知边界：memory agent 依赖 `toolCalls` 写记忆，Devin 不会产生
toolCalls——该链路对 devin-acp 当前不闭环，产品方向待定（交给 Devin
还是固定回退 HTTP 模型）。

#### Sidecar 调用隔离（compact/标题/记忆等）

`sessionKey` 按调用语义分键：`modelCall.operation` 为 `agent_step` 或未设
（主对话回合）→ `traceContext.sessionId`；**其余 operation**
（`context_compaction`、`session_title`、memory extract 等）→
`{sessionId}#{operation}`，走独立 ACP session。

原因：sidecar 调用是自包含任务而非会话续聊。若与主会话共用一个 ACP
session，"请总结这段对话"这类指令会成为 Devin 的真实上下文且转录本身
不会送达（续聊路径只发最后一条 user 消息）——实测导致压缩后 Devin
回复跑偏（"A 还没做，是否要做"）。sidecar 的 messages 即任务主体，
由同一确定性 serializer 全量序列化（上限放宽到 400K 字符、含 system
角色）单条 text part 发送，不做 contextForward 注入。

### 并发与生命周期约束

- `ensureSession` 对同 key 并发做在途去重（`creating` map）：防重复
  `session/new` 产生幽灵 session；只有创建发起者拿到 `isNew=true`。
- `runPrompt` 按 `acpSessionId` 串行排队：同一 ACP session 并发 prompt
  会让 update handler 互相覆盖、事件错归因。
- `traceContext.sessionId` 缺失时 sessionKey 用随机值：牺牲续聊换隔离，
  防止无上下文的调用把多个 ZCode session 混进一个 ACP session。
- bridge 进程池 LRU 上限 4，驱逐时 `dispose()`：配置每次变更都会改
  池 key，不设上限会让旧 `devin acp` 子进程陪跑到 agent 退出。
- `streamText` generator 被提前丢弃（非 abortSignal 路径）时 finally
  发 `session/cancel`：防 Devin 侧任务继续跑、updates 无界堆积。
- `session/set_config_option`(mode) 在 `session/new` 后 await：避免首个
  prompt 先于 mode 生效。
- prompt 失败（超时/中止/传输错误）会把 ACP session 标脏并触发重建：
  Devin 侧状态未知，不能按"已同步"续聊。
- `request_permission` 优先 `allow_once`：`allow_always` 会把规则永久
  写进 Devin 配置，绕过用户选的 ask/plan 模式。
- session cwd = runtime `workingDirectory`（非 `process.cwd()`）；
  `authenticate` 浏览器 PKCE 用 10min 超时；stdin 'error'(EPIPE) 有
  监听兜底（否则未处理 error 事件会让整个 agent 进程崩溃）。
- contextForward 分段排除 fenced code 内的 `# ` 行（防 Memory 段被
  `# 注释` 截断）；Windows `.cmd/.bat` 经 cmd.exe 运行（shell:false
  下新版 Node EINVAL）。

### Context meter（用量感知）

Devin reporta su contexto real por `session/update{sessionUpdate:"usage_update",
used, size, cost?}` — el mismo dato que muestra `devin` en su propia UI
(`71% (186K / 262K)`). Diseño de la integración:

- `ModelUsage` gana `contextTokens?`/`contextWindow?`: son **ocupación de contexto
  gestionada por el agente** (acumulativa del ACP session), NO tokens de la
  petición. Nunca se escriben en `inputTokens`/`totalTokens` para no contaminar
  el ledger de tokens ni las estadísticas de consumo.
- `getModelUsageContextTokens` prefiere `usage.contextTokens` cuando existe;
  `model_complete.contextWindow` usa `usage.contextWindow ?? model.properties.
  contextWindow` (el valor reportado por ACP es autoritativo sobre el estático).
- El `cost` ({amount,currency}) viaja en `finish.providerMetadata.devinCost`
  solo a efectos de diagnóstico: es "valor reportado por CLI", sin verificación.
- Si Devin no envía `usage_update`, `finish.usage` queda `{}` y el meter sigue
  oculto — nunca se sintetiza un valor.
- `usage_update` es extensión **unstable** de ACP (sin capability de cliente);
  se consume si llega, se ignora si no.

### 上下文与记忆注入

`request.messages` 中 system 角色内容由 ContextBuilder 组装为最多三条：
`cli_prefix`、stable 块、dynamic 块。全局记忆（`# Global Memory`）与项目记忆
（`# Memory`）都在 dynamic 块内。

`contextForward` 策略：

| 值 | 行为 |
| --- | --- |
| `memory-only`（默认） | 按 `# ` 段标题白名单提取 `Global Memory`/`Memory`/`Environment Info`/`Request User Context` 等段落，作为 `resource` part 发送 |
| `all-dynamic` | 整个 dynamic system 块作为 resource part 发送 |
| `none` | 不注入 |

不在白名单内的 ZCode 工具说明、行为规则**不进入** Devin（见「工具语义」）。
resource part 与 text part 一次 `session/prompt` 内同发；按内容 hash 去重，
只在仅新 ACP session 的首个 prompt 随 resource part 发送（v1 不做中途变化重发）。记忆写回由 zcode 既有 Extraction 负责
（transcript 含 Devin 流回文本，闭环成立）。

workspace 规则文件（`AGENTS.md`、`.claude/`、`.cursor/` 等）由 Devin 自身的
`load_cwd_rules` 原生加载（实测扫描 devin/agents_standard/cursor/windsurf/
claude/opencode/zed/copilot 七家），ZCode 不做额外转发。

### MCP 透传

`session/new.mcpServers` 接收 ZCode 已解析的 `mcp.servers` 配置
（`mcpPassthrough: true` 时默认全量，或按 server 名单过滤——UI 可选）。

| ZCode `mcp.servers` 项 | ACP mcpServers 项 |
| --- | --- |
| `type:"stdio"` + command/args/env | `{name, command, args, env:[{name,value}]}` |
| `type:"http"/"sse"` + url/headers | `{name, type:"http"|"sse", url, headers:[{name,value}]}` |
| `enabled:false` / 插件标记 disabled | 跳过 |

约束：

- stdio server 会被 zcode 与 devin 各自 spawn 一份实例；有状态/重资源 server
  （playwright 等）建议用户在 UI 里取消勾选。
- env/headers 可能含凭据：只进子进程 env 与 ACP 参数，不进日志（沿用
  redactSensitive 同款规则）。
- Devin 自身 `~/.config/devin/mcp_config.json` 由其 CLI 原生加载，与 ZCode
  透传列表是并集，name 冲突时 Devin 侧行为未定义——UI 提示存在冲突的 server 名。

Bridge 依赖新端口 `DevinAcpDeps.listMcpServers(): DevinAcpMcpServer[]`，由
bootstrap 在装配 `createModelAdapter` 时从已解析 config 注入；adapter 不直接
读配置文件。

## 工具语义（用户决策记录）

问题：ZCode 的 system prompt 描述了自有工具（Bash/Read/Write/…），能否让
Devin 使用？

结论：

1. **ZCode 原生工具 Devin 无法调用。** 模型通道只能回传文本；把 zcode 工具
   schema 写进 Devin prompt 只会诱导它输出不会被调用的伪 tool call 文本。
   Devin 自带等效工具集（文件/终端/web），功能面覆盖。
2. **ZCode 的 MCP server 可以共享**（上节透传方案）。这是"同一批 MCP 工具
   两边可用"的正确通道——走 `session/new.mcpServers` 而不是 prompt。
3. system prompt 的取舍：默认 `memory-only` 白名单注入；不转发 ZCode 工具
   契约段落。`all-dynamic` 选项保留给需要完整上下文的高级用户，代价是混入
   ZCode 专属指令文本。
4. 远期可选（不在本期）：把 ZCode 工具以 MCP server 形态暴露给 Devin——
   那才是"Devin 调用 ZCode 工具"的正规通道。

## 认证

```text
authenticate(methodId:"devin-browser", meta:{api_key?})
   ├─ 返回 {}            → ready（本机 ACP 凭证命中或 api_key 被接受）
   ├─ 返回 {url,…}       → auth-required：URL 交给 UI
   │                       desktop: IPlatformService openExternal
   │                       web/phone: 展示 URL + 「我已完成登录」重试按钮
   └─ error              → auth-required 或不可恢复错误上抛
```

- 每次 spawn 后必调（Devin ACP 模式不使用本地 CLI 凭证）。凭证按机器持久，
  浏览器 PKCE 通常只需一次。
- 需要用户操作时，executor 抛带 `devin-auth-required` 标记与 URL 的
  ModelProtocolError（recoverable），UI 设置页与 turn 错误提示都能消费；
  connectivity test 同路径复用。
- `apiKey` 存于 provider access config（与现有 api-key 字段同等级保护：
  不进日志/示例/提交）。

## 状态所有者与生命周期

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| devin 二进制发现/校验 | adapters DevinDiscovery（新） | configured → PATH → `~/.local/bin` 等公共路径；`devin --version` 校验，minVersion 门 |
| acp 子进程 | DevinAcpBridge（CLI 进程内） | 生命周期跟随 zcode-cli；不等 Host |
| ACP sessionId | DevinAcpBridge 会话池 | key=(providerId, zcode sessionId)；随 session 持久化记录可 resume |
| busy/串行 | DevinAcpBridge per-session | prompt 排队；cancel 不打断在途已提交任务 |
| auth 状态 | devin CLI 凭证存储（机器级） | ZCode 不持久化 token；只持久化用户填的 apiKey |
| provider/model 配置 | 既有 personal provider config | 复用 overlay/registry/selection 全链路 |

## 失败语义

| 场景 | 行为 |
| --- | --- |
| binary 未找到/不可执行/版本过低 | connectivity/turn 报 `devin-binary-missing`，设置页给路径修正入口 |
| auth-required | recoverable 错误 + URL；重试走重连流程 |
| 远程 workspace 选择 devin 模型 | `devin-unsupported-remote`（本地限定） |
| devin 进程退出/协议错误 | stream error event；下个 prompt 惰性重建 transport+session |
| prompt 超时（默认 7200s） | session/cancel + timeout 错误，不自动重发 |
| 用户取消（abortSignal） | session/cancel；stream 正常结束 |
| elicitation/未知 client 请求 | 自动 cancel/空响应，诊断日志 debug |
| usage 缺失 | finish.usage 记 0，不伪造 |

## UI（设置页）

新增「Devin」provider 表单（api.type=devin-acp 分支渲染）：

- Binary：自动探测结果（路径+版本）/手动绝对路径输入/重新探测
- Auth：状态徽标（authenticated / needs-login）；`apiKey` 输入；
  「浏览器登录」按钮（desktop openExternal；web 显示 URL）
- Mode：`accept-edits`（默认）/`smart`/`plan`/`bypass`——模式语义沿用
  session/new 返回的描述文案，不回写硬编码
- Prompt timeout：数字输入，默认 7200s
- MCP passthrough：开关 + 已配置 server 勾选列表（冲突名标黄）
- 模型说明：固定 `SWE-2 Max`（`swe-2-max`），副文案注明实际档位以
  Devin 解析为准（当前家族只有 swe-2-high）
- 连接测试：走正式 Model 链（spawn→initialize→authenticate→session/new）
  回显：CLI 版本、auth 状态、实际生效 model/mode currentValue

移动端/远程网页同表单可读可改（settings 是共享 packages/ui）；浏览器登录
按钮降级为展示 URL。

## 测试

- 单测（adapters）：ndjson framing、update→event 映射、contextForward 过滤、
  session 池 key/busy/cancel、auth 三分支、mcpServers 形状转换、超时路径。
- 单测（provider）：schema variant 序列化/overlay/校验、模板创建。
- 集成：mock devin acp（fixture 进程回放协议），覆盖 initialize→auth→new→
  prompt→update→finish 全链路与取消/退出/auth-required。
- Live smoke（手动，不进 CI）：真 `devin acp`，最小 prompt 到 finish。
- E2E：设置页建 provider→连接测试→模型选择→turn 流式→取消；远程网页
  attach 后同一链路（验收重点：Devin 任务在桌面执行，手机只见事件流）。

## 风险与开放问题

- `swe-2-max` 在本机实测解析为 `swe-2-high`（swe-2 家族当前唯一档）。模型 id
  以用户账号 advertised options 为准；若未来家族扩档，`--model`/`set_config_option`
  的 fuzzy 解析仍生效，无需改码。上线前需用真实账号确认目标档。
- `meta.api_key` 的 authenticate 参数形状在 dummy key 下返回 `{}`，需要真实
  key 验证路径有效性；失败时回退浏览器流程。
- `devin acp` 启动即加载用户全局 mcp_config.json（实测拉起了 playwright/stripe/
  vocab-dict 连接）。是否有 per-spawn 禁用开关未确认；若有按默认关闭+透传列表
  精确控制更佳。
- Devin session 的真实 context 长度/compact 行为归 Devin 管；ZCode 侧的
  contextWindow/maxOutputTokens 仅为名义值。
- Devin CLI 版本漂移：discovery 设 minVersion；协议字段以 advertised
  capabilities 为准，不假设 `_meta` 扩展。
