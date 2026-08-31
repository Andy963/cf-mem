# 配置参考

README 只展示第一次部署需要的配置。本页收录所有可配置项；大多数项目不需要修改默认值。

## 先判断你需要什么

| 功能 | 最少需要配置 |
| --- | --- |
| Embedding 接口 | `API_TOKEN` |
| 原始记忆 `/memory/index`、`/memory/search` | `MEMORY_API_TOKEN`（或回退 `API_TOKEN`）、`X-Project-Id`，以及 D1 和 `cf-vector` |
| 持久记忆 Claims | D1、`cf-claims`，以及对应 metadata index |
| 记忆自动提炼 | `PERSONAL_MEMORY_OWNER_ID`、抽取器配置；鉴权使用共享 token |
| 网页抓取 | `TAVILY_API_TOKEN`、`TAVILY_BASE_URL` |
| 管理后台 | Cloudflare Access、`ADMIN_ALLOWED_EMAIL` |
| 搜索精排 | `RERANK_DEFAULT_ENABLED` 或请求体中的 `rerank.enabled` |

## 第一次部署

基础部署可暂时复用 `API_TOKEN`。生产建议为 memory 单独设置全局鉴权 token，便于独立轮换：

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put MEMORY_API_TOKEN
```

`/memory/*` 永远不从 token 推断项目。每个请求必须带项目头：

```text
Authorization: Bearer <shared-token>
X-Project-Id: <project-id>
```

`MEMORY_API_TOKEN` 未设置时，当前版本暂时回退到 `API_TOKEN`，以保证迁移期间不中断；新部署
应尽快设置前者。`ALLOWED_MEMORY_PROJECTS`（逗号分隔）建议设为已存在的项目，例如
`personal,whisper,ads,cf-mem,study_copilot`，未知项目会返回 `403`。不要把 token 写进
`wrangler.toml` 或提交到 Git。

调用方项目 ID 的来源必须稳定且显式：共享 profile hook 默认发送 `personal`，也可以在
`~/.config/cf-mem/config.json` 中填写固定的 `project_id`（只有明确需要项目专属 profile
时才覆盖它）；Whisper 的 recall 使用 `RECALL_PROJECT_ID`，durable memory 使用
`WHISPER_DURABLE_MEMORY_PROJECT_ID`（未设置时回退 `RECALL_PROJECT_ID`）。不要让服务端
根据 token 猜测项目。

Whisper 的 profile connector 也可以用 `WHISPER_PROFILE_MEMORY_PROJECT_ID` 覆盖默认的
`personal`，但这会把跨工具共享画像切换到另一个项目，只有在明确需要时才设置。

旧客户端迁移期间可以暂时保留旧 secret：

```bash
npx wrangler secret put PROJECT_TOKENS_JSON
```

旧 token 现在只能作为临时凭据，并且必须带上与其原项目完全一致的 `X-Project-Id`；缺少项目头
或项目不一致会失败，服务端不会再用 token 自动选择项目。所有客户端迁移到共享 token 后，
删除 `PROJECT_TOKENS_JSON`、`PERSONAL_MEMORY_TOKEN` 和相关兼容配置。

## Secret

| 名称 | 什么时候需要 | 说明 |
| --- | --- | --- |
| `API_TOKEN` | 使用 `/`、`/health`、`/embed`、`/v1/embeddings` 或 `/web/*` | Embedding 和网页接口共用的鉴权 token |
| `MEMORY_API_TOKEN` | 使用项目级 `/memory/*` | 所有项目共用的全局鉴权 token；未设置时回退 `API_TOKEN` |
| `ALLOWED_MEMORY_PROJECTS` | 限制项目访问范围 | 逗号分隔的项目 ID；留空表示允许所有合法项目 ID |
| `PROJECT_TOKENS_JSON` | 迁移旧客户端 | 旧版凭据校验，仅作兼容兜底；不参与新路由 |
| `PERSONAL_MEMORY_TOKEN` | 迁移旧客户端 | 旧版个人凭据，仅作兼容兜底；不参与新路由 |
| `EXTRACTOR_LLM_API_KEY` | 使用个人记忆自动提炼 | 抽取、验证、对齐请求使用的模型 key |
| `TAVILY_API_TOKEN` | 使用 Tavily 搜索、抓取或网页提取 | Tavily Worker 的访问 token |

## 普通变量

这些变量放在本地 `wrangler.toml` 的 `[vars]` 中。secret 不要放在这里。

| 名称 | 默认值 | 作用 |
| --- | --- | --- |
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Workers AI embedding 模型 |
| `CORS_ALLOW_ORIGIN` | `*` | CORS 允许的来源；生产环境建议改成实际来源 |
| `PERSONAL_MEMORY_PROJECT_ID` | `personal` | 旧版个人凭据绑定的项目 ID；仅兼容期使用 |
| `PERSONAL_MEMORY_OWNER_ID` | 无 | 开启 `/memory/profile/ingest` 时必填，用于证据和提炼结果归属；兼容旧变量名 |
| `TAVILY_BASE_URL` | 无 | Tavily Worker 地址，例如 `https://tavily.example.com` |
| `RERANK_MODEL` | `@cf/baai/bge-reranker-base` | `/memory/search` 的精排模型 |
| `RERANK_DEFAULT_ENABLED` | `false` | 是否默认开启精排；也可以只在请求中开启 |
| `RAW_MEMORY_RETENTION_DAYS` | `90` | 原始 segment 的保留天数 |
| `RAW_MEMORY_MAX_BYTES_PER_PROJECT` | `104857600` | 每个项目的原始记忆逻辑字节上限 |
| `RAW_MEMORY_TARGET_BYTES_PER_PROJECT` | `83886080` | 超过上限后清理到的目标水位 |
| `ADMIN_ALLOWED_EMAIL` | 无 | Cloudflare Access 管理员邮箱，小写比较 |
| `EXTRACTOR_LLM_API_BASE` | 无 | 个人记忆抽取器的 OpenAI 兼容接口地址 |
| `EXTRACTOR_LLM_MODEL` | 无 | 个人记忆抽取、验证和对齐使用的模型 |
| `PROFILE_EXTRACTOR_PROTOCOL` | `chat_completions` | 抽取器协议，也支持 `responses` |

## 个人记忆自动提炼

以下变量和 secret 必须同时配置，`/memory/profile/ingest` 才能被 Cron 自动处理。请求项目由
`X-Project-Id` 决定，不再限定为 `personal`：

```toml
[vars]
PERSONAL_MEMORY_OWNER_ID = "your-owner-id"
EXTRACTOR_LLM_API_BASE = "https://api.example.com/v1"
EXTRACTOR_LLM_MODEL = "gemini-3.7-flash-high"
PROFILE_EXTRACTOR_PROTOCOL = "chat_completions"
```

```bash
npx wrangler secret put EXTRACTOR_LLM_API_KEY
```

`PROFILE_EXTRACTOR_PROTOCOL` 支持 `chat_completions` 和 `responses`。当前端点使用
OpenAI 兼容的请求格式，因此保持 `chat_completions` 即可，不需要改成模型厂商专用协议。

批处理和语义召回可以按需调整：

| 名称 | 默认值 | 作用 |
| --- | --- | --- |
| `PROFILE_CONTEXT_MIN_SCORE` | `0.55` | profile claim 语义召回最低分 |
| `PROFILE_BATCH_MAX_CHARS` | `10000` | 一批用户证据的字符上限，最多钳制到 `12000` |
| `PROFILE_BATCH_MAX_SEGMENTS` | `24` | 一批证据的条数上限 |
| `PROFILE_BATCH_IDLE_MS` | `900000` | 尾批等待时间，单位为毫秒 |

## Claims 语义去重

默认已启用，所有参数都有内置默认值，通常不需要在 `wrangler.toml` 里配置任何东西：

| 名称 | 默认值 | 作用 |
| --- | --- | --- |
| `CLAIM_DEDUP_SAME_SCORE` | `0.92` | 达到此相似度时直接 reinforce |
| `CLAIM_DEDUP_REVIEW_MIN_SCORE` | `0.75` | 低于此分数时直接作为新 claim 插入 |
| `CLAIM_DEDUP_TOP_K` | `12` | Vectorize 召回候选数，范围 `1–50` |
| `CLAIM_DEDUP_LLM_ENABLED` | `true` | 是否启用灰区 LLM 裁决；缺少抽取器配置时自动关闭 |
| `CLAIM_DEDUP_AUTO_REPLACE` | `false` | 是否允许 LLM 判定 update 后自动替换旧 claim |

`cf-claims` 必须创建以下 metadata index，过滤才会在 topK 截断前生效：

```bash
for property in status scope_kind scope_id category type workspace_id; do
  npx wrangler vectorize create-metadata-index cf-claims \
    --property-name "$property" --type string
done
```

如果 index 已存在，命令会提示已存在，可以跳过。Vectorize 写入存在延迟可见窗口时，
Worker 会从 D1 重新嵌入同一语义 scope 中尚未出现在向量结果里的 active claim。

## Cloudflare 资源

默认 `wrangler.toml` 使用这些资源名称：

| 绑定 | 资源 | 用途 |
| --- | --- | --- |
| `DB` | `cf-text` | 原始记忆、Claims、抽取任务 |
| `SEGMENTS_INDEX` | `cf-vector` | 原始记忆向量 |
| `CLAIMS_INDEX` | `cf-claims` | 持久记忆向量 |
| `AI` | Workers AI | embedding 和可选精排 |

创建资源和应用迁移的命令见 README。已有资源无需重复创建。

## 管理后台

管理后台需要同时配置 Cloudflare Access 和：

```toml
[vars]
ADMIN_ALLOWED_EMAIL = "admin@example.com"
```

生产环境建议设置 `workers_dev = false`，只通过受 Access 保护的自定义域名访问后台。
后台写操作会记录操作人、时间、原因和修改前后快照。

## 原始记忆保留与清理

Worker 每五分钟执行一次清理任务：

- 删除过期且不再被 active claim 引用的原始 segment；
- 删除对应的 `cf-vector` 向量；
- 超过项目逻辑字节上限时清理最旧的可删除 segment；
- Vectorize 暂时失败时通过 D1 deletion job 在后续 Cron 重试。

这部分默认配置适合小型部署。提高保留天数或项目上限前，应确认 D1 和 Vectorize
用量预算。
