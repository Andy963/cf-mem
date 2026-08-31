# 持久记忆设计（Durable Memory Design）

## 目标

把 `cf-mem` 从一个原始片段 RAG 后端，扩展为持久记忆后端，同时不丢失支撑每条记忆的原始证据。

系统必须区分三种东西：

1. **证据（Evidence）**：`memory_segments` 中不可变的原始文本。
2. **主张（Claims）**：从证据中提炼出的结构化、分版本的记忆。
3. **上下文（Context）**：返回给 Agent 的一小撮 active claims 及其证据。

这套设计刻意保持通用：它建模用户偏好、指令、决定、档案事实和任务状态，不编码任何具体产品领域的规则。

## 非目标

- 替换或删除 `memory_segments` 中的原始会话数据。
- 把模型推断当成已确认的用户偏好。
- 用向量相似度来裁决两条冲突的当前偏好哪条有效。
- 让记忆检索承担完成校验（completion verification）或工具执行校验的责任。

## 现状

`memory_segments` 在 D1 存原文、在 Vectorize 存向量。持久 claims 存在 `memory_claims`，
证据关联存在 `memory_evidence`；`/memory/index` 对同一 id 的相同内容去重，
`/memory/search` 做向量检索并可选 rerank。`/memory/claims` 支持确定性身份键检查，
外加由专用 Vectorize 索引支撑的 scope 内语义去重。

## 目标数据模型

### `memory_segments`

保持为证据存储。现有的写入和检索行为不变。

### `memory_claims`

一行 = 一条持久陈述的一个版本。

| 字段 | 用途 |
| --- | --- |
| `id` | 稳定的 claim 标识符 |
| `project_id` | 强制隔离键 |
| `scope_kind`, `scope_id` | 归属 scope：`project`、`user` 或 `session` |
| `category` | `rule`、`tool_insight`、`user_profile` 或 `domain_fact` |
| `type` | `preference`、`instruction`、`decision` 或 `profile` |
| `subject`, `memory_key` | 用于合并的规范身份键 |
| `value_json`, `canonical_text` | 机器可读的值 + Agent 可读的文本 |
| `status` | `active`、`superseded`、`retracted` 或 `proposed` |
| `provenance` | `user_explicit`、`user_confirmed` 或 `model_inferred` |
| `confidence` | `[0, 1]` 内的数值 |
| `applicability` | `global`、`workspace` 或 `semantic` |
| `workspace_id` | 工作区适用范围；仅用于 `applicability = workspace` |
| `superseded_by` | 替代它的 claim id（如有） |
| `use_count` | claim 被注入上下文的累计次数 |
| `last_used_at` | claim 最近一次被注入上下文的时间 |
| 有效期与时间戳字段 | 时间维度可审计 |

### `memory_evidence`

把 claim 关联到原始 `memory_segments`。关系为 `supports` 和 `contradicts`。
claim 对 claim 的替换用 `memory_claims.superseded_by` 表示。证据关联始终按项目隔离。

## Claim 安全规则

1. claim 只能引用同项目内的 segment。
2. `user_explicit` 和 `user_confirmed` 的 claim 必须至少有一条支撑 segment。
3. `model_inferred` 的 claim 创建时必须是 `proposed` 状态；未经显式确认，永远不会作为
   active 用户记忆返回。
4. 同一 (project, scope, category, type, subject, memory_key, workspace) 组合下最多只有一条 active claim。
5. 替换会创建新 claim 并把旧 active claim 标为 `superseded`；历史 claim 永不覆写。
6. 撤回把状态改为 `retracted`，但保留完整证据链。
7. 语义去重只比较同项目、同 scope、同 category、同 type、同 workspace 的 active 且当前有效的 claim。
   Vectorize 结果先用 metadata 过滤收窄，状态与有效性的最终裁决权始终在 D1。
8. 处于 Vectorize 最终一致性的可见窗口内时，做 create 决策前会把向量结果中缺失的
   same-scope active claims 从 D1 重新嵌入补齐。
9. 语义上的「读取 → 裁决 → 写入」序列由短期的 D1 租约锁（lease lock）保护，
   防止并发请求插入重复的语义 claim。

## 分类路由与生命周期

Claims 按四类路由：`rule` 用于全局或工作区行为约束，`tool_insight` 按工具名称
（`scope_id`）局部挂载，`user_profile` 用于用户画像，`domain_fact` 只在有实际查询时做语义召回。

`domain_fact` 与 `user_profile` 的响应包含动态 `active_score`：

`confidence * exp(-0.023 * deltaDays) * (1 + ln(1 + use_count))`

其中 `deltaDays` 从 `last_used_at`（没有使用记录时回退到 `created_at`）计算。当前实现将该值
作为召回与审计指标返回，未增加 `archived` 状态或自动归档迁移；现有状态机仍只有
`active`、`superseded`、`retracted` 和 `proposed`。

同一分类和语义 scope 内，`rule` 与 `tool_insight` 的参数更新或冲突会自动创建新版本并将旧版本
标记为 `superseded`；其他分类仍需显式允许替换或在冲突时停止，避免静默覆盖事实。

## API 契约

现有端点全部保持不变。

### `POST /memory/claims`

创建或变更结构化 claims。支持的操作：

- `create`：为某个 canonical key 创建第一条 active claim。
- `reinforce`：给现有 active claim 追加支撑证据并提高置信度，但不改值。
- `supersede`：创建替代 claim，并把同一 canonical key 的旧 active claim 标记为 superseded。
- `retract`：把指定的 active claim 标记为 retracted。

所有变更都由 Worker 校验并受共享 token 与 `X-Project-Id` 限制。自动化客户端必须把证据上报到
`POST /memory/extraction/ingest`，候选提取、验证和自动变更 claim 都由 Worker 负责。
`POST /memory/claims` 只保留给显式授权的管理操作。

### `GET /memory/context` 与 `POST /memory/context`

按 scope 与时间确定性排序，返回生效中的非 proposed claims 及其支撑 segment ids。
它面向每轮对话前的上下文加载器。

传入 `categories` 后，Worker 按分类路由：规则查询全局及当前工作区，工具经验需要 `scope_id`，
用户画像按用户 scope 查询，业务事实只在 query 非空且非 trivial 时使用 claim 向量索引，
任务状态只返回当前用户或会话的未过期记录。未传 `categories` 时保持旧版 scope 与语义合并行为。

初始选择是结构化的，不是语义的：

1. 请求的 user scope；
2. 请求的 project scope；
3. 请求的 session scope;
4. 仅限 active 状态的 claim。

这保证了在引入第二个向量索引之前，当前适用的指令和偏好依然是可靠的。

## 分阶段交付

### Phase 1：持久 claim 台账

1. 新增 `memory_claims`、`memory_evidence` 迁移。
2. 新增 D1 访问函数和严格的 claim 请求校验。
3. 实现 claim 变更操作和确定性的 `/memory/context`。
4. 对 Worker 跑类型检查，并用基于 D1 的测试环境演练全部变更路径。

### Phase 2：候选提取

1. 客户端把有界的、已索引的证据上报到 Worker 自有的提取队列。
2. 要求结构化候选输出，必须引用源 segment ids，并且分类上要把偏好与观点、当前工作状态区分开。
3. 在任何候选可以变更 `memory_claims` 之前，先跑一遍独立的验证步骤。
4. 持久化候选/裁决审计记录；拒绝观点和含糊的当前工作流陈述，而不是把它们当偏好。
5. 混合会话片段中只允许使用用户说话的部分作为提取证据；没有引用队列中某个证据
   segment id 的候选直接拒绝。

### Phase 2b：Worker 侧链接抓取

用户证据里的链接由 Worker 自己解析（即链接内容设计的「Worker fetch」选项），
而不是每个提交客户端各自抓取。之所以这样选，是因为需要登录或在私网才能访问的页面明确在范围之外；
没有这个需求的话，客户端抓取既没收益还要多写 N 份实现。

1. ingest 时剥离客户端内联的 `<referenced_web_content>` 块，并中和行首的角色标记，
   保证信任分隔符一定是 Worker 自己写的、可验证的那一个。
2. flush 时按批抓取一次：不给客户端加延迟，任务重试时不重复抓，一批内每个不同的 URL 只抓一次。
3. 每个页面存成独立的 `kind: "web_reference"` segment，携带 `source_url`、`final_url`、
   `fetched_at`、`fetch_provider` 和 `content_hash`。segment id 由 URL 加内容哈希派生：
   页面变了就变成新 segment，而不是覆写一条已有 claim 引用的证据。
4. 用户发言和抓到的页面分开预算（12000 / 6000 字符），且只有用户发言计入攒批阈值，
   避免一个链接吃掉整批预算。
5. 要求每个被接受的候选至少引用一条 `kind: "user"` 的 segment。因此「永远用英文回答」
   这类出现在网页里的指令无法把自己提升成 claim。

抓取有 SSRF 防护（scheme、端口、凭据、私网地址、逐跳重定向检查）。Workers 在抓取前
无法解析 DNS，所以公网域名解析到私网地址是一个已知且接受的缺口。

### Phase 3：语义化持久记忆检索

1. 新增专用 `CLAIMS_INDEX` Vectorize 绑定和 `project:<project_id>:claims` namespace。
2. 只对 active claim 文本做向量化；supersede/retract 时移除或更新向量。
3. topK 截断之前先施加 status、scope、type、workspace 元数据过滤，阈值判定使用精确余弦分数。
4. 新写入的向量尚未查询可见时，走 D1 候选兜底。
5. 语义 create 决策用短期 D1 租约锁串行化。
6. 融合确定性的 active 指令/偏好与语义命中的 claims 以及原始证据命中。
7. 向量召回之后，D1 的状态、scope、有效期和项目检查仍是最终裁决者。

### Phase 4：Whisper 集成

1. 每轮 Whisper 开始前用当前 user、project、session scope 加载 `/memory/context`。
2. 选中的 claims 作为有界的、标注清晰的上下文块注入。
3. 保留 `recall.search` 用于检索原始会话证据和历史细节。
4. 记录注入的 claims 是否被实际使用，以便审计和修正陈旧或有害的记忆。

### Phase 5：评估与运维

维护覆盖以下场景的回归用例：显式偏好、强化、替换、撤回、临时陈述、模型推断候选、
项目隔离、证据可追溯性、Vectorize 最终一致性以及并发 claim 写入。跟踪抽取精度、
冲突率、陈旧记忆率、重复率、锁竞争和上下文 token 预算等指标。

## 实施进度

- [x] Phase 1.1 数据迁移
- [x] Phase 1.2 claim 台账访问与校验
- [x] Phase 1.3 claim 变更 API
- [x] Phase 1.4 确定性 context API
- [x] Phase 1.5 类型检查
- [x] Phase 2 提取生产者
- [x] Phase 2b Worker 侧链接抓取
- [x] Phase 3 语义 claim 索引
- [x] Phase 4 Whisper 集成
- [ ] Phase 5 评估与运维
