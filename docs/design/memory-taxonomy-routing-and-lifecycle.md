# 记忆分类体系、按需路由与生命周期衰减设计（Memory Taxonomy, Routing & Lifecycle Decay）

## 1. 背景与核心问题

在传统的 Agent 记忆系统设计中，通常将所有沉淀的记忆（Claims）混存在一个平铺的池子中，无论何种类型的记忆都通过统一的向量检索（Semantic Search）召回并注入上下文。这种“单一全量池”模型在实际运行中会暴露三大核心问题：

1. **认知负担过载与 Prompt 污染（Context Bloat）**：
   - 琐碎的事实与全局硬约束混杂，占用大量固定 System Prompt 预算。
2. **作用域泛化导致的跨项目污染（Scope Bleeding）**：
   - 将特定项目/工具的局部经验（例如“夸克网盘转存到‘来自：分享’”）当成全局规则广播到所有项目（如开发 `cf-mem` 或 `ADS` 时误注入网盘规则），造成模型幻觉与上下文混乱。
   - **根因分析**：上游 Hook 仅机械计算 `cwd` 的匿名哈希且子目录未向根回溯，导致后端抽取器（Extractor LLM）无法感知当前人类可读的项目名（如 `whisper`），盲目将项目特化经验提升为全局偏好。
3. **规则冲突与精神分裂（Rule Clashes）**：
   - 当历史偏好或旧工具路径（如已废弃的参数或旧目录）被向量检索召回时，与当前最新规范冲突，导致模型无所适从。
4. **只增不减无淘汰（Append-Only Decay Deficit）**：
   - 缺少基于使用反馈（Usage Feedback）的衰减淘汰与冲突版本替换机制，过期或低价值记忆永久驻留。

为解决上述问题，本设计借鉴 Hermes Agent 的分层沉淀思想，将 `cf-mem` 的持久记忆扩展为**分类分流消费模型**、**严格作用域隔离（Scope Isolation）**与**基于使用反馈的生命周期闭环**。

---

## 2. 五大记忆分类与作用域隔离体系（Taxonomy & Scope Matrix）

在 `memory_claims` 结构中显式引入 `category` 枚举字段与 `scope_kind` 作用域隔离机制：

```text
Memory Claims
├── 1. rule          (行为准则与硬约束)
│    ├── scope: global      -> 跨项目通用硬约束，全端基线注入
│    └── scope: workspace   -> 特定项目/仓库专用规则，仅在对应工作区注入
├── 2. tool_insight  (工具/技能经验)
│    └── scope: tool        -> 仅在激活对应 Tool/Skill 时动态局部挂载，绝不全局广播
├── 3. user_profile  (用户身份与长期偏好)    -> 会话启动浓缩摘要注入 (Summary Injection)
├── 4. domain_fact   (业务与架构事实)        -> 纯按需语义向量检索 (On-Demand RAG)
└── 5. task_state    (跨轮次任务断点)        -> 短生命周期状态 (TTL 自动过期)
```

### 分类判定与消费矩阵

| 分类标识 (`category`) | 作用域限定 (`scope`) | 核心定义与提取准入特征 | 正例 / 反例 | 消费与注入通道 (Routing) |
| :--- | :--- | :--- | :--- | :--- |
| **`rule`**<br>(全局准则) | `global` | 跨所有项目必须严格遵守的**通用硬性红线与工作哲学**。<br>特征：必须包含强规范动词（`必须`、`严禁`、`优先`、`默认`）。 | **正例**：“必须始终使用中文回复，严禁夹杂英文表达”、“严禁直接在 master 开发，必须在 dev 分支开发并测试”<br>**反例**：“夸克转存到来自：分享”（属于工具/项目特化，严禁进 global） | **全端注入（最高优先级）**<br>上限严格控制在 5~8 条（< 150 Token），作为全局 Base System Instructions。 |
| **`rule`**<br>(项目特化准则) | `workspace` | 仅在**特定代码仓库或项目环境**下生效的开发规范。 | **正例**：“在 whisper 仓库中，日志严禁打印用户 content，只保留元数据”<br>**反例**：“git commit 必须简洁”（属于 global 规则） | **仅在对应 Workspace 注入**<br>根据 `workspace_id`（路径哈希）隔离，切到其他仓库时不注入。 |
| **`tool_insight`**<br>(工具经验) | `tool` | 针对特定工具、脚本、第三方 API、网盘或系统的**具体参数、真实路径与避坑经验**。 | **正例**：“quark-save 目标目录名为‘来自：分享’，含全角冒号”、“alipan-save token 为 .bub/alipan-save/token.json”<br>**反例**：“今天天气真好” | **Tool/Skill 触发时动态挂载**<br>日常对话与全局 Prompt 绝不注入；仅当 Agent 激活对应 Tool/Skill 时，动态挂载该工具的专属规范。 |
| **`user_profile`**<br>(用户画像) | `global` | 用户的技术背景、工作哲学、系统环境等**长期稳定属性**。 | **正例**：“Andy 熟悉 Rust/Go/Python，重视长期架构质量 Slow is Fast”<br>**反例**：“我今天想学一下 Rust”（短期临时状态） | **SessionStart 摘要注入**<br>注入浓缩后的 Profile 摘要（1~2 句话），不平铺细碎条目。 |
| **`domain_fact`**<br>(业务/架构事实) | `workspace` / `global` | 仓库架构、数据库名、服务端点、业务历史决策等**事实性知识**。 | **正例**：“cf-mem 对应 D1 数据库为 cf-text，域名为 mem.example.com”<br>**反例**：“编译报了个语法错误”（瞬时报错） | **纯按需语义召回 (On-demand RAG)**<br>全局 Prompt 绝不注入；仅当用户 Query 命中向量相似度时，Top-K 召回。 |
| **`task_state`**<br>(临时工作状态) | `workspace` | 跨轮次、跨会话未完成的断点、TODO、进行中的重构目标。 | **正例**：“whisper 的 memory consolidation spec 已编写完毕，等待接入 Worker”<br>**反例**：“已完成日记清理”（已结束的事实转为 fact 或归档） | **仅在 Resume / Handoff 时注入**<br>新任务不注入；带有 24~72 小时 TTL，过期自动作废。 |

---

## 3. 长会话规则刷新与注意力保活机制（Rule Refresh & Floor Guardrail）

在现代大模型进入 1M 上下文时代后，仅在会话初始注入规则会导致**注意力漂移（Attention Dilution）**与**静默压缩失忆（Compaction Erasure）**。因此建立“事件驱动 + 双阈值竞态兜底”的规则保活刷新体系。

### 3.1 刷新决策树

```text
               用户提交 Prompt (UserPromptSubmit) / 会话事件 (SessionStart)
                                       │
                ┌──────────────────────┴──────────────────────┐
                ▼                                             ▼
       SessionStart 事件                               UserPromptSubmit 事件
                │                                             │
      ┌─────────┴─────────┐                                   ▼
      ▼                   ▼                       累加 turn_count 与 tokens
matcher == compact   startup / resume                       │
      │                   │                                   ▼
      │ (P0: 压缩发生)      │ (首次启动)             ┌───────────┴───────────┐
      │                   │                      ▼                       ▼
      └─────────┬─────────┘                turn_count >= 32 ?   accum_tokens >= 256k ?
                │                                │                       │
                │                                └───────────┬───────────┘
                │                                            ▼ (任一满足: P1 兜底触发)
                └────────────────────────┬───────────────────┘
                                         ▼
                   1. 从 cf-mem 拉取 active 状态的 rule (global + current workspace)
                   2. 构造 <system-reminder> 注入当前轮上下文尾部
                   3. 计数器归零: turn_count = 0, accum_tokens = 0
```

### 3.2 刷新触发准则

1. **P0 级强保活（事件驱动）**：
   - 当收到 `SessionStart` 且 `matcher == "compact"` 时，**零延迟立即重新注入**，瞬间自愈压缩导致的上下文失忆。
2. **P1 级下限保活（双阈值竞态，哪个先达到按哪个触发）**：
   - **轮次阈值**：`turn_count >= 32 轮`（防多轮短文本交互中的注意力渐进漂移）。
   - **Token 累积阈值**：`accumulated_tokens >= 256k Token`（约 800k 字符，占 1M 上下文的 1/4，防单次大文件读入/巨型 grep 输出导致的规则稀释）。
3. **刷新载体格式**：
   - 统一采用系统级提醒标签 `<system-reminder>` 包裹，确保大模型拥有最高的元指令遵守权重，且不会在回答中误复述。

```xml
<system-reminder>
# System Level Behavioral Constraints
- 必须始终使用中文回复，严禁在回复中夹杂英文谚语或其他英文表达
- 严格遵循 Slow is Fast 原则，代码修改必须在 dev 分支开发并验证，严禁直接在 master 开发
</system-reminder>
```

---

## 4. 生命周期与使用反馈衰减模型（Decay & Lifecycle）

记忆必须建立“访问强化、未用衰减、冲突覆盖、显式撤回”的自平衡循环，避免单一递增。

### 4.1 状态机与流转模型

```text
[Proposed] ──(Extractor/Verifier 确认)──> [Active]
                                              │
               ┌──────────────────────────────┼──────────────────────────────┐
               │ (语义相似且参数冲突)          │ (60天无访问/活跃分跌破阈值)    │ (用户显式纠偏/删除)
               ▼                              ▼                              ▼
          [Superseded]                   [Archived]                     [Retracted]
      (由新版本 claim 替换)            (移出活跃向量库，冷存)           (全端立即停用)
```

### 4.2 动态衰减评分公式（Active Score）

针对 `domain_fact` 与 `user_profile`，引入基于半衰期与使用反馈的活跃度评分算法：

\$\$\text{ActiveScore} = \text{confidence} \times e^{-\lambda \times \Delta t} \times (1 + \ln(1 + \text{use\_count}))\$\$

- **\$\text{confidence}\$**：提取时的置信度（0.0 ~ 1.0）。
- **\$\Delta t\$**：距上次有效访问（`last_used_at`）的天数。
- **\$\lambda\$**：衰减因子（\$\lambda = 0.023\$，对应半衰期约 30 天）。
- **\$\text{use\_count}\$**：该条记忆被召回并实际采纳的累计次数。

#### 淘汰策略（Retirement）：
- 当 \$\text{ActiveScore} < \text{THRESHOLD}\$ 时，状态自动转为 `archived`。
- `archived` 状态的条目会从 Vectorize 活跃索引中移除，不再参与日常快速召回，仅保留在 D1 存储中供深度审计与全量搜索检索。

### 4.3 冲突版本替换（Superseding）

规则（`rule`）与工具经验（`tool_insight`）不走时间衰减，走**语义冲突覆盖**：
1. 新 Claim 生成后，与同 scope/category 的已有 Claim 计算语义相似度。
2. 若 Cosine 相似度 > 0.85 且判断为相同实体的参数变更：
   - 新 Claim 状态设为 `active`；
   - 旧 Claim 状态置为 `superseded`，并记录 `superseded_by = <new_claim_id>`。
3. 严格禁止同一个 Tool 或 Scope 存在两条相互矛盾的 `active` 规则。

---

## 5. 后端接口与存储层演进（Backend Schema & API）

### 5.1 数据表扩展（`memory_claims`）

在 D1 数据库 `memory_claims` 表中补充字段定义：

```sql
ALTER TABLE memory_claims ADD COLUMN category TEXT NOT NULL DEFAULT domain_fact;
-- 可选值: rule, tool_insight, user_profile, domain_fact, task_state

CREATE INDEX idx_claims_category_scope_status ON memory_claims(project_id, category, scope_kind, status);
```

### 5.2 查询 API 分流设计

```http
# 0. 对话证据上报 (必须携带解析出的真实项目语义)
POST /memory/profile/ingest
Content-Type: application/json
{
  "text": "用户对话内容...",
  "source_app": "codex",
  "external_session_id": "codex:019c...",
  "workspace_id": "ws_whisper_7e939a",
  "workspace_name": "whisper"
}

# 1. 会话启动 / 刷新注入 (仅拉取全局规则 + 当前工作区规则 + 身份画像)
GET /memory/context?categories=rule,user_profile&workspace_id=ws_123&limit=15

# 2. 工具调用上下文动态挂载 (仅拉取对应工具的 insights)
GET /memory/context?categories=tool_insight&scope_id=quark-save

# 3. 业务事实按需语义检索
POST /memory/search
Content-Type: application/json
{
  "query": "cf-mem 数据库名称是什么",
  "categories": ["domain_fact"],
  "workspace_id": "ws_123",
  "top_k": 3
}
```

---

## 6. 客户端消费契约与分工（Client Routing）

### 6.1 助手 Hooks (Codex / Claude / Droid)
- **`SessionStart` (hook-context)**：
  - 启动与发生 `compact` 时，调用 `GET /memory/context?categories=rule,user_profile&workspace_id=...`；
  - 构造 `<system-reminder>` 注入顶部，重置计数器（`turn_count = 0, accum_tokens = 0`）。
- **`UserPromptSubmit` (hook-capture)**：
  - 异步将用户 Prompt 投递至 `POST /memory/profile/ingest` 缓冲池；
  - 维护本地滑窗计数（`turn_count += 1`，累加 Token）；
  - 命中 `turn_count >= 32` OR `accum_tokens >= 256k` 时，附加 `<system-reminder>` 刷新规则并归零。

### 6.2 Whisper Bot 运行时
- **日常对话**：不加载全部工具知识；
- **激活 Skill 时**：根据当前 Skill 名称（如 `alipan-save`），按需向 `cf-mem` 查询 `tool_insight` 并挂载到当前执行步骤中；
- **Handoff / 锚点重建**：在重建 `task_anchor` 时精准挂载当前活跃规则。

---

## 7. 工作区与项目语义解析协议（Workspace & Project Resolution）

### 7.1 Hook 端的仓库根目录与项目名解析
Hook 严禁直接使用 `os.getcwd()` 独立哈希（避免在 `whisper/tests/` 子目录下执行时哈希割裂）。必须通过向上回溯确定真实的 Git 根目录或项目主文件：

```python
def _resolve_workspace_info() -> tuple[str, str] | None:
    cur = Path.cwd().resolve()
    root = None
    for p in [cur] + list(cur.parents):
        if (p / ".git").exists() or (p / "pyproject.toml").is_file() or (p / "package.json").is_file():
            root = p
            break
    if not root:
        return None
    
    project_name = root.name  # 例如 "whisper", "cf-mem", "study_copilot"
    workspace_id = f"ws_{project_name}_" + hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:16]
    return workspace_id, project_name
```

### 7.2 抽取器 Prompt 的项目语义感知与防泛化约束
在 `cf-mem` 调用抽取大模型（`callExtractor`）时，不仅传递 `workspace_id`，同时注入人类可读的 `workspace_name`：

```markdown
# 抽取器输入元数据
Current Workspace: whisper (Repo Path: /home/andy/repos/whisper)

# 抽取器 Prompt 防泛化负向指令：
1. 必须优先结合当前 Workspace 项目上下文判断规则边界。
2. 凡是涉及特定项目代码、特定仓库脚本、本地特定工具参数或目录路径的偏好（如特定网盘文件夹名、特定 API Token 路径、特定组件规范），**必须将 applicability 标记为 "workspace" 或 "tool"，严禁标记为 "global"**。
3. 只有跨越所有软件工程项目通用的底层原则（如“必须使用中文回复”、“严格在 dev 分支开发”），才允许标记为 "global"。
```
