# cf-mem 完整参考（Cloudflare Workers AI + D1 + Vectorize）

> 这是完整的接口与运维参考。第一次部署请先阅读根目录 README；所有配置项的集中说明见
> [`configuration.md`](configuration.md)。

一个单 Worker 的 RAG 记忆后端：

- embedding：调用 Cloudflare Workers AI 生成向量
- text storage：把原文 + 元数据落到 D1（`cf-text`）
- vector storage：把向量 + id + 少量可过滤 metadata 落到 Vectorize（`cf-vector`）
- project isolation：`/memory/*` 按全局鉴权 token + 显式 `X-Project-Id` + D1 `project_id` + Vectorize namespace 做硬隔离

> 说明：`migrations/` 只用于初始化或升级 D1 表结构；Worker 运行时不会读取这些 SQL 文件。

## Endpoints

- `GET /`（同 `GET /health`）
- `GET /health`
- `POST /embed`（返回 Workers AI 原始结果，便于调试）
- `POST /v1/embeddings`（OpenAI embeddings 兼容格式）
- `POST /web/extract`（取网页正文：优先 Tavily Extract，逐 URL 回退到 Worker 直连抓取）
- `POST /web/search`（Tavily Search，纯转发）
- `POST /web/crawl`（Tavily Crawl，纯转发）
- `GET /memory/health`
- `POST /memory/index`
- `POST /memory/search`
- `POST /memory/claims`
- `POST /memory/profile/ingest`
- `POST /memory/extraction/ingest`
- `GET /memory/context`
- `POST /memory/context`
- `GET /memory/claims`
- `POST /memory/forget`
- `GET /admin`（Cloudflare Access 保护的只读管理页）
- `GET /admin/api/claims`（admin 专用：筛选、搜索和分页查看 claims）
- `GET /admin/api/claims/:id`（admin 专用：查看 claim 及关联证据）
- `PUT /admin/api/claims/:id`、`POST /admin/api/claims/:id/retract`、`POST /admin/api/claims/:id/tags`、`DELETE /admin/api/claims/:id/tags/:tag`（admin 专用：带审计的管理操作）

## 快速开始（部署到你的 Cloudflare 账号）

安装依赖：

```bash
cd cf-mem
npm install
```

准备 `wrangler.toml`：

仓库默认只追踪 `wrangler.toml.example`，你需要复制一份成本地的 `wrangler.toml`（该文件已在 `.gitignore` 中忽略）：

```bash
cp wrangler.toml.example wrangler.toml
```

创建 D1：

```bash
npx wrangler d1 create cf-text
```

把 `wrangler d1 create` 输出的 `database_id` 填回你本地的 `cf-mem/wrangler.toml`。

创建 Vectorize（BGE-M3 维度为 1024）：

```bash
npx wrangler vectorize create cf-vector --dimensions 1024 --metric cosine
npx wrangler vectorize create cf-claims --dimensions 1024 --metric cosine
npx wrangler vectorize create-metadata-index cf-claims --property-name status --type string
npx wrangler vectorize create-metadata-index cf-claims --property-name scope_kind --type string
npx wrangler vectorize create-metadata-index cf-claims --property-name scope_id --type string
npx wrangler vectorize create-metadata-index cf-claims --property-name category --type string
npx wrangler vectorize create-metadata-index cf-claims --property-name type --type string
npx wrangler vectorize create-metadata-index cf-claims --property-name workspace_id --type string
```

初始化 D1 schema（应用全部 migrations）：

```bash
npx wrangler d1 migrations apply cf-text --remote
```

配置 embedding 鉴权（`/`、`/health`、`/embed`、`/v1/embeddings`）：

```bash
npx wrangler secret put API_TOKEN
```

配置网页抓取（`/web/*`，复用 `API_TOKEN` 鉴权；两项都是可选的）：

```bash
npx wrangler secret put TAVILY_API_TOKEN
```

把 `TAVILY_BASE_URL` 放进 `wrangler.toml` 的 `[vars]`，例如
`TAVILY_BASE_URL = "https://tavily.example.com"`。只有访问 token 需要使用 secret。

`POST /web/extract` 只需要 `{"urls": [...]}`（最多 10 个）。Tavily 配置齐全时优先走它；**未返回结果
的 URL 会逐个回退到 Worker 直连抓取**，因此一个坏链接不再把整批拖到弱路径上。响应形状统一：

```json
{
  "provider": "tavily|direct|mixed|none",
  "results": [{ "url": "...", "final_url": "...", "title": "...", "raw_content": "...", "provider": "direct", "fetched_at": 0 }],
  "failed_results": [{ "url": "...", "error": "HTTP 404" }]
}
```

抓取受这些约束：仅 http/https、仅 80/443 端口、拒绝凭据式 URL、拒绝私有与本地地址（含 IPv4 映射与
NAT64 形式的 IPv6）、手动逐跳校验重定向（最多 5 跳）、10s 超时、512KB 正文上限，只接受
HTML/XHTML/纯文本。Worker 无法在 fetch 前做 DNS 解析，因此指向内网地址的公网域名不在防护范围内；
需要登录态或内网的页面同样不在支持范围内。`/web/search` 与 `/web/crawl` 没有本地等价物，未配置
Tavily 时返回 `503`。

配置 memory 项目隔离（`/memory/*` 请求必须带项目头）：

```bash
npx wrangler secret put MEMORY_API_TOKEN
```

请求头示例：`Authorization: Bearer <shared-token>` 和 `X-Project-Id: whisper`。
请求体如包含 `project_id`，也必须与该请求头一致。

部署：

```bash
npm run deploy
```

## 自定义域名（可选）

默认不绑定自定义域名，只会部署到 `workers.dev` 域名上（由 Wrangler 输出）。

如果你需要绑定自己的域名路由，在你本地的 `cf-mem/wrangler.toml` 里取消注释并修改：

```toml
# [[routes]]
# pattern = "mem.example.com/*"
# zone_name = "example.com"
```

## Admin dashboard

`/admin` is a read-only memory console. It shows aggregate active claim, raw segment, storage, and
per-project usage figures, and lets the administrator filter, search, and inspect full extracted
claims. The detail pane shows the structured value and linked raw evidence text. It has no write
actions outside the administrator's explicit edits, retractions, and tag changes. These changes
are recorded with the Cloudflare Access email, timestamp, reason, and before/after snapshots; the
original claim is never physically deleted. It never exposes API tokens.

Protect both `mem.example.com/admin*` and `mem.example.com/admin/api/*` with one Cloudflare Access
Application. Configure the Access policy to allow the administrator's email, then set the same
lowercase email as `ADMIN_ALLOWED_EMAIL` in `[vars]`. Access injects
`Cf-Access-Authenticated-User-Email`; the Worker verifies it against that value before rendering
the page or returning metrics.

For production, use a custom-domain route and set `workers_dev = false`. Otherwise the same Worker
may also be available under a `workers.dev` address, which is outside the custom-domain Access
policy and could allow a forged header to bypass the Worker-level email check.

## 配置项

完整变量表、secret 分类、默认值和按功能配置示例统一放在
[`configuration.md`](configuration.md)。本页只保留各功能的操作说明，避免同一配置在多处
重复维护。

## 项目隔离模型

`/memory/*` 现在默认按项目硬隔离：

1. 每个请求先用 `MEMORY_API_TOKEN`（迁移期间未设置时回退 `API_TOKEN`）验证全局 token
2. `X-Project-Id` 是唯一的项目路由来源；不再从 token 推断项目
3. 写入 D1 时强制写入 `project_id`
4. 写入 Vectorize 时强制写入 `namespace = project:<project_id>`
5. 查询 Vectorize 时固定只查当前项目 namespace
6. 即使请求体自己传了 `project_id`，也只能与请求头一致；不一致直接返回 `400`

这意味着：

- 不同项目不会共享同一个 Vectorize namespace
- 不同项目不会通过 API 读到彼此的 memory 数据

### project_id 长度约束

Vectorize 的 vector id 上限是 64 字节，而 segment id 的实际形式是
`project:<project_id>:<segment_id>`，因此 `project_id` 会直接吃掉这个预算：

- `project_id` 最长 **32 字符**，超出的会返回 `400`
- 自动派生的 segment id（`seg_<hash>` / `pe_<hash>`）会按剩余预算自动收窄摘要宽度，
  最短保留 16 个十六进制字符；`project_id` 在 19 字符以内时摘要宽度与旧版完全一致，
  因此不会改变既有数据的 id
- 请求体显式传入的 `id` 无法自动收窄，拼接后超过 64 字节会返回 `400` 并说明实际字节数
- 相同的业务 id 进入存储前也会被自动加上项目作用域，避免跨项目覆盖

## 代码结构（src）

核心思路：按功能分层，避免 `src/index.ts` 变成 God file；其中 memory schema 默认导出名为 `defaultMemorySchema`，你可以替换为自己的 schema 以适配不同的存储字段/过滤逻辑。

```text
src/
  index.ts              # entry + route-level auth
  auth.ts               # shared token + explicit project header -> project scope
  project.ts            # project id / namespace helpers
  env.ts                # Env typings
  utils.ts              # shared helpers

  api/                  # HTTP layer (request/response)
  ai/                   # Workers AI wrappers
  db/                   # D1 access
  vector/               # Vectorize access
  web/                  # SSRF-guarded page fetching (Tavily relay + direct fallback)
  memory/               # schema + index/search orchestration
```

## 数据模型（D1）

表名：`memory_segments`（见 `cf-mem/migrations/0001_init.sql` 和 `cf-mem/migrations/0002_project_isolation.sql`）

- `id`：项目作用域内唯一 id；若请求未提供，会基于 `project_id + session_id + tape + text` 派生稳定 id
- `project_id`：项目隔离键
- `text`：原文
- `metadata_json`：原始元数据（完整 JSON，Worker 会补入 `project_id`）
- `session_id` / `tape`：常用过滤列
- `content_hash`：用于避免重复 embedding/写入
- `created_at` / `updated_at`：毫秒时间戳
- `expires_at`：raw segment 的 TTL 截止时间
- `deletion_state`：`active` 或等待 vector 删除完成的 `pending_delete`

## Retention 与删除

Worker 每五分钟运行一次 Cron sweep。它会删除过期、且不再支撑 active claim 的 raw
segments，并同步删除 `cf-vector` 中的同 ID vector。同一次 sweep 也会检查每个 project 的
logical-byte 上限，超限时从最旧的可删除 segment 开始清理到目标水位。

配额检查不再挂在 `/memory/index` 的写路径上：它需要扫描该 project 的全部活跃 segment
（`SUM(LENGTH(...))` 加上逐行的 evidence join），放在写路径会随数据量线性拖慢写入。代价是
配额执行最多滞后一个 Cron 周期（5 分钟）。

删除通过 D1 `memory_deletion_jobs` outbox 执行：先将 segment 标记为不可检索，再删除
Vectorize vector，最后删除 D1 row；待删除 claim 会立即 retract，避免其在重试期间继续注入上下文。
Vectorize 暂时失败会保留 job 并由下一次 Cron sweep 自动重试。
这只使用 Worker 的 D1/Vectorize bindings，不需要 Whisper 持有 Cloudflare 管理 API token。

`POST /memory/forget` 提供项目内的 user 或 session scope 删除，业务调用方必须在自己的认证层
验证该 scope 属于当前用户。Whisper Telegram 仅在 private chat 中公开 `/forget CONFIRM` 与
`/forget_all CONFIRM`，并使用共享 token 与 `X-Project-Id` 调用此业务 API。

## Shared profile extraction

`POST /memory/profile/ingest` accepts bounded user evidence from the project selected by
`X-Project-Id`:

The shared profile connector sends `X-Project-Id: personal` by default so user preferences
remain cross-tool. A caller that intentionally needs project-local profile evidence can set an
explicit `project_id` in its connector configuration.

```json
{
  "text": "I prefer concise replies.",
  "role": "user",
  "source_app": "codex",
  "external_session_id": "session-123",
  "workspace_id": "ws_cf-mem_0123456789abcdef",
  "workspace_name": "cf-mem"
}
```

`role` is optional and defaults to `user`. Set `role: "assistant"` to submit the assistant's own
final reply for the turn. Assistant evidence exists because project facts — a design conclusion,
a root cause, an interface contract — are stated in the reply, not in the prompt. It is stored
under an `[assistant]` marker, surfaced to the extractor as evidence of `kind: "assistant"` with
its own character budget, and governed by a weaker evidentiary bar:

- It is a valid source for `domain_fact` and `tool_insight`.
- It may **never** be the sole support for a `rule` or `user_profile` candidate; those must rest
  on what the user themselves said.
- It is treated as a proposal, not established truth. The extractor only promotes a conclusion the
  user accepted or that was actually carried out, so speculation and corrected answers are not
  hardened into memory.

A batch that contains no user evidence is not extracted at all, so an assistant monologue cannot
produce claims on its own.

`scripts/install-hooks.sh` wires both directions for codex, droid, and claude:
`UserPromptSubmit` runs `cf_mem_hook.py hook-capture` for the prompt, and `Stop` runs
`cf_mem_hook.py hook-assistant` for the final reply. The assistant hook reads the reply from the
event payload, falling back to the last assistant turn in `transcript_path`. Before upload it
scrubs credential-shaped strings (`sk-…`, `ghp_…`, `AKIA…`, JWTs, and `token=`/`api_key=`
assignments) and skips replies under 80 characters, which are acknowledgements rather than facts.

The workspace resolver no longer returns nothing for a directory without a `.git`,
`package.json`, or `pyproject.toml` marker: it falls back to the directory itself, so extracted
facts carry a project identity. Two exclusions apply even when a marker is present — a stray
`/tmp/.git` is enough to make every temp session look like one shared repository:

- `/` and `$HOME` are matched **exactly**. `/` is every path's ancestor and `$HOME` is where real
  projects live, so testing either by ancestry would disqualify `~/repos/<project>` too.
- The temp roots (`/tmp`, `/var/tmp`, and the macOS `/private/…` spellings) are matched by
  **ancestry**, since anything beneath them disappears on reboot.

Claiming a workspace in those locations would be worse than having none:
`defaultClaimApplicability` turns any workspace id into workspace scope, pinning a
globally-intended rule to a directory that will not exist next week.

It buffers the evidence and returns `202` with
`{"ok":true,"evidence_id":"...","buffered":true,"job_id":null}`. Ingest no longer creates one
extraction job per message: extracting each message in isolation fragmented the context a
preference is usually expressed across ("还是用 pytest 吧" only makes sense against the preceding
turn), and cost three model calls per message. Evidence is instead batched — see
[Evidence batching](#evidence-batching) below. `job_id` remains in the response as an explicit
`null` so the payload shape stays stable for existing callers.

The five-minute Cron claims and processes
jobs using D1 leases, exponential backoff, and a bounded attempt count. Keeping the three external
model calls out of the ingest request prevents a short request lifecycle from stranding a leased
job. The extractor endpoint, key, model, and fixed personal owner ID are Worker-only bindings:

```text
EXTRACTOR_LLM_API_BASE
EXTRACTOR_LLM_API_KEY
EXTRACTOR_LLM_MODEL
PERSONAL_MEMORY_OWNER_ID
```

The extractor only sends the standard bearer token and JSON request headers. The configured endpoint
must expose an OpenAI-compatible Chat Completions API.

The extractor must be OpenAI Chat Completions compatible. It runs candidate extraction, independent
promotion verification, then reconciliation against existing active claims. Reconciliation only
keeps, reinforces, or supersedes an evidence-backed accepted candidate; it cannot independently
retract an existing claim or rewrite candidate fields. Candidate and verdict records are auditable
in D1; only accepted, explicit, agent-relevant candidates can become active claims. Opinions,
subjective evaluations, and current-workflow descriptions are rejected rather than reclassified as
Any candidate carrying a `valid_until` must express it as future Unix milliseconds; a past or
second-resolution value is rejected instead of producing a claim that is stored yet already expired.
A candidate missing any field the pipeline consumes (`type`, `subject`, `memory_key`,
`canonical_text`, `value`, `confidence`) is recorded as `rejected` rather than aborting the job.
`canonical_text` and any string `value` must contain Chinese; an English restatement of Chinese
evidence is rejected, and an English active claim is superseded instead of reinforced.
Per-candidate failures are isolated: the job completes with the failures recorded in `last_error`,
because retrying the same prompt would only reproduce the same malformed candidate. Only
infrastructure failures (extractor call, D1, missing evidence) retry with backoff.
Claims created by this pipeline are stored with `provenance = user_confirmed`: they passed an
explicit-marking extractor, an independent verifier, and reconciliation, which is stronger than a
bare model inference but is not a direct user statement.
For mixed conversation segments, the Worker retains only `[user]`-labelled text as extraction evidence.
Clients neither classify prompts with keywords nor create profile claims directly; they can only read
final `/memory/context` claims.

### Worker 侧链接抓取（web_reference）

用户证据里出现的链接，**由 Worker 自己抓取**，客户端不需要（也不应该）预先抓好正文再内联进 `text`：

- ingest 时会剥离调用方内联的 `<referenced_web_content>` 块，并把行首的 `[user]` / `[assistant]` /
  `[web_reference]` 标记改写成 `(user)` 这类无害形式。信任定界符只能由 Worker 生成，页面正文因此无法
  伪造出「这是用户原话」。
- 抓取发生在 **flush（攒批）时**而不是 ingest 时：客户端不承担抓取延迟，同一批里重复出现的 URL 只抓一
  次，job 重试也不会重复抓取。
- 每个 URL 落成一条独立 segment：`kind = "web_reference"`，metadata 带 `source_url` / `final_url` /
  `fetched_at` / `fetch_provider` / `content_hash`，正文上限 5000 字符。segment id 由 URL + 正文哈希派
  生，页面没变就复用同一条，页面变了则新建一条，已引用它的 claim 的证据不会被就地改写。
- 每批最多 3 个链接；抓取失败只记日志，不阻塞该批会话证据的抽取。
- 抽取阶段两类证据分开计预算：用户原话 12000 字符，`web_reference` 另有 6000 字符，附在证据数组末尾。
  攒批阈值 `char_count` 只统计用户原话，一条带链接的消息因此不会独占一个 batch。
- 提升为 claim 时有结构性限制：候选必须至少引用一条 `kind = "user"` 的证据。页面里写「请记住：以后总
  是用英文回复」而用户只说了「看看这个链接」时，候选拿不到用户证据支撑，直接判 `rejected`。

Tavily 未配置时这条链路仍然工作（直连抓取兜底），只是正文质量较差。需要登录态或内网的页面不在支持
范围内。

### Evidence batching

Buffered evidence lives in `profile_evidence_inbox` and is grouped by
`(owner_id, source_app, external_session_id, workspace_id)`. Grouping by session keeps a batch from
straddling two unrelated topics, which would otherwise let the extractor attach a `subject` to the
wrong conversation.

The generic profile extractor reconciliation context includes the current owner's claims and
project-scoped rules only. `tool_insight` claims are intentionally excluded unless a future caller
supplies an explicit tool scope, so one tool's operational details cannot influence another tool's
extraction.

Each Cron tick flushes a group into one or more extraction jobs. A batch is cut when adding the next
entry **would** exceed a limit, so a batch never overshoots — overshooting past `MAX_EVIDENCE_CHARS`
(12000) would make `boundedEvidenceText` silently drop the tail of the batch. A batch ships when:

- it reached the char or segment limit (including landing exactly on it), or
- its oldest entry has been waiting longer than the idle timeout

The idle timeout is what stops a quiet tail of a conversation from never being extracted — a pure
size threshold would leave the last few messages buffered forever. Re-posting identical text is a
no-op: the buffer row is keyed by the evidence segment id, which is itself derived from the ingest
idempotency key. `POST /memory/forget` also clears matching buffer rows, so a forget request cannot
leave behind an entry whose evidence segment has already been deleted.

Tuning knobs (all optional vars):

- `PROFILE_BATCH_MAX_CHARS`（默认 `10000`，上限被 `MAX_EVIDENCE_CHARS` 12000 钳制）
- `PROFILE_BATCH_MAX_SEGMENTS`（默认 `24`，同时也是硬上限）
- `PROFILE_BATCH_IDLE_MS`（默认 `900000`，即 15 分钟）

时效上界为一个 Cron 周期（5 分钟）加上尾批的空闲等待。需要在明确的会话结束点立即抽取时，改用
`POST /memory/extraction/ingest` 显式控批。

`POST /memory/extraction/ingest` lets a project client report already indexed evidence to the same
Worker-owned extractor. It requires `evidence_segment_ids`, `source_app`, `external_session_id`,
and `user_id`. Every referenced segment must belong to the authenticated project. This is the
integration endpoint for services such as Whisper: they report evidence but never invoke an LLM or
call `POST /memory/claims` for automated extraction.

## Vectorize metadata / namespace

写入 Vectorize 时：

- namespace：固定为 `project:<project_id>`
- metadata 会从 `metadata_json` 里投影出少量字段（如果存在）

当前投影字段：

- `project_id`（string）
- `session_id`（string）
- `tape`（string）
- `kind`（string）
- `chat_id`（number）
- `user_id`（number）
- `category`（string）
- `workspace_id`（string）

如果你还需要在 Vectorize 侧做 metadata filter，建议创建 metadata index（至少 `project_id` / `session_id` / `tape`
以及使用的 `category` / `workspace_id`）：

```bash
npx wrangler vectorize create-metadata-index cf-vector --property-name project_id --type string
npx wrangler vectorize create-metadata-index cf-vector --property-name session_id --type string
npx wrangler vectorize create-metadata-index cf-vector --property-name tape --type string
npx wrangler vectorize create-metadata-index cf-vector --property-name category --type string
npx wrangler vectorize create-metadata-index cf-vector --property-name workspace_id --type string
```

没有 metadata index 时，带 `filter` 的向量查询召回会不足。此时 `/memory/search` 会补一次
不带 filter 的查询，**按 id 合并**两次结果后再由 D1 侧统一做精确过滤——而不是丢弃第一次的
命中。第一次查询返回的正是最可能通过过滤的那批向量，直接覆盖会让召回反而低于不回退。
无论走哪条路径，D1 侧过滤都保证结果不会跨出 filter 与鉴权项目。

## 调用示例

Health：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" https://<your-worker>/health
```

Embedding（OpenAI 兼容）：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  https://<your-worker>/v1/embeddings \
  -d '{"input":["hello","world"]}'
```

Memory health（使用共享 token 与项目头）：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "X-Project-Id: cf-mem" \
  https://<your-worker>/memory/health
```

Index memory（Worker 会自动补入 `project_id`）：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "X-Project-Id: cf-mem" -H "Content-Type: application/json" \
  https://<your-worker>/memory/index \
  -d '{"text":"hello world","metadata":{"session_id":"s1","tape":"t1","kind":"note"}}'
```

`items` 数组中任何一条格式不合法（`text` 非字符串、`id` 非字符串、`metadata` 非对象）都会
返回 `400` 并指出具体下标，例如 `items[2].text must be a string`。此前这类条目会被静默丢弃，
调用方会收到一个看起来成功、但少了几条的结果。

Search memory：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "X-Project-Id: cf-mem" -H "Content-Type: application/json" \
  https://<your-worker>/memory/search \
  -d '{"query":"hello","topK":5,"filter":{"session_id":"s1","tape":"t1"}}'
```

## Rerank（可选）

`/memory/search` 默认只按 Vectorize 的向量相似度排序。

如果你希望“召回 + 精排”，可以在请求体里打开 `rerank`，让 Worker 额外调用 Workers AI 的 reranker 模型对候选结果重排（会带来额外延迟与成本）：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "X-Project-Id: cf-mem" -H "Content-Type: application/json" \
  https://<your-worker>/memory/search \
  -d '{"query":"hello","topK":5,"filter":{"session_id":"s1","tape":"t1"},"rerank":{"enabled":true,"topN":20}}'
```

当 rerank 启用时，返回的 match 会额外包含：

- `vector_score`：向量相似度分数
- `rerank_score`：reranker 分数
- `score`：最终用于排序的分数（优先使用 `rerank_score`，否则回退到 `vector_score`）

## 持久记忆（Claims）

`memory_segments` 继续保存可追溯的原始证据。持久偏好、指令、决定、档案和任务状态保存在独立的
`memory_claims` 表，并用 `memory_evidence` 链接到其源 segment。

详细的数据模型、变更规则和后续阶段见
[`durable-memory-design.md`](durable-memory-design.md)。

`POST /memory/claims` 只接受受限操作：

- `create`：创建新 claim。`model_inferred` 来源会以 `proposed` 状态保存，不能成为注入上下文的长期记忆。
- `reinforce`：为现有 active claim 增加证据，并可提高置信度。
- `supersede`：创建替代 claim，将同一 canonical key 的旧 active claim 标记为 `superseded`。
- `retract`：将指定 active claim 标记为 `retracted`。

除上述身份键查重外，`create` 还会做一层语义去重：无身份匹配时，用新 claim 的
`canonical_text` 在 `cf-claims` 向量索引中使用 Vectorize 返回的相似度分数召回同 scope、同 category、同 type 的候选。
必须预先为 `status`、`scope_kind`、`scope_id`、`category`、`type`、`workspace_id` 建立 metadata index，
这样过滤会在 topK 截断前执行。相似度 ≥
`CLAIM_DEDUP_SAME_SCORE`（默认 `0.92`）视为同义事实，自动转为 reinforce；低于
`CLAIM_DEDUP_REVIEW_MIN_SCORE`（默认 `0.75`）视为新事实直接插入；之间的灰区交给配置的
LLM（提取器端点）三选一裁决：`same` 转 reinforce、`update` 按
`CLAIM_DEDUP_AUTO_REPLACE` 决定普通分类的 `update` 是否自动替换（默认关闭，报错提示改用 supersede）；
`rule` 与 `tool_insight` 的 `update` 或 `conflict` 按分类策略自动 supersede 旧版本，其他分类的 `conflict`
拒绝写入并提示走显式操作。LLM 不可用时灰区降级为直接插入，宁可暂存可能重复的 claim，也不静默合并。
`PROFILE_EXTRACTOR_PROTOCOL=responses` 时灰区裁决使用 Responses API；并发写入按 project/scope/type/workspace
加 D1 lease 锁，避免多个请求同时通过语义检查。Vectorize 写入存在延迟可见窗口时，Worker
会从同一语义 scope 的 D1 active claims 取回未出现在向量结果中的候选，重新嵌入后参与 cosine 比较。

显式用户来源的 claim 必须提供同项目中已有的 `evidence_segment_ids`。例如：

```json
{
  "operation": "create",
  "claim": {
    "scope_kind": "user",
    "scope_id": "user-123",
    "type": "preference",
    "subject": "response",
    "memory_key": "response.language",
    "value": "zh-CN",
    "canonical_text": "用户偏好使用中文回复。",
    "provenance": "user_explicit",
    "confidence": 0.98,
    "evidence_segment_ids": ["project:proj-a:seg_abc"]
  }
}
```

`GET /memory/context` 与 `POST /memory/context` 按用户、项目和会话 scope 返回当前有效的 active claims，并包含 source
segment ids。若传入 `query`，Worker 会把固定 scope 内存与专用 claim 向量索引的语义命中合并。
它用于 Agent 每轮开始前加载受限、结构化的记忆上下文：

可用 `categories` 选择路由：`rule` 返回全局及当前工作区规则，`tool_insight` 需要同时传入
工具名称 `scope_id`，`user_profile` 返回当前用户画像，
`domain_fact` 仅在 query 非空且非 trivial 时执行语义召回。未指定 `categories` 时保持旧版 scope + semantic 合并行为。

对 `domain_fact` 与 `user_profile` claim，响应还会返回 `active_score`。它按置信度、距最近使用的天数
和 `use_count` 计算，用于观察记忆活跃度；`rule` 与 `tool_insight` 返回 `null`，不参与时间衰减。

`task_state` 分类已退役（迁移 `0019`）。任何残留的历史行都不会进入上下文路由。

例如，SessionStart 可以只请求全局规则、当前工作区规则和用户画像：

```json
{
  "user_id": "user-123",
  "categories": ["rule", "user_profile"],
  "workspace_id": "ws_cf-mem_0123456789abcdef",
  "limit": 15
}
```

`POST /memory/search` 的 `categories` 支持逗号分隔字符串或数组；未指定时按
`domain_fact` 处理。原始 segment 没有分类元数据时按兼容规则视为 `domain_fact`，但内部
`profile_inbox` 证据始终排除，避免用户画像提炼的原始对话进入事实检索。

未指定 `categories` 的旧版 `/memory/context` 请求仍保留原有 scope 路由，但不会广播
`tool_insight`；工具经验必须通过显式的 `tool_insight` 分类和 `scope_id` 请求。

```json
{
  "user_id": "user-123",
  "session_id": "session-456",
  "query": "当前回复应该使用什么语言？",
  "types": ["preference", "instruction"],
  "limit": 20
}
```

`GET /memory/claims` 用于审计和管理当前提炼出的记忆。它仍受共享 token 与项目头保护，可按
`scope_kind`、`scope_id`、`status` 和 `limit` 过滤：

```text
GET /memory/claims?scope_kind=user&scope_id=user-123&status=active&limit=100
```

## 升级注意事项

如果你是从旧版 `cf-mem` 升级：

1. 先执行 `npx wrangler d1 migrations apply cf-text --remote`，把 `project_id` 列和索引补上
2. 再配置 `MEMORY_API_TOKEN`（迁移期间也可暂时确认 `API_TOKEN` 已配置）
3. 旧数据如果之前没有 `project_id` 或仍在 Vectorize 默认 namespace，需要按项目重新走一次 `/memory/index`，把向量写入新的 `project:<project_id>` namespace

也就是说，这次升级会把 memory 从“共享池”切到“项目级命名空间”；只有完成 reindex 的项目，才能在新隔离模型下被 `/memory/search` 查到。

迁移 `0009_segment_user_id_index.sql` 为 `POST /memory/forget` 的 user scope 删除补上了
metadata `user_id` 表达式索引。它是纯索引变更，不改数据，但在大项目上是该接口能否在超时前
完成的关键。索引表达式必须与查询里的 `CAST(json_extract(metadata_json, '$.user_id') AS TEXT)`
逐字一致，SQLite 才会命中它。这里的 `CAST` 不能省略：`json_extract` 返回 JSON 原生类型，而
`user_id` 按约定是 number，去掉 `CAST` 会让它与绑定的 TEXT 参数永远不相等，从而静默漏删。

迁移 `0010_profile_evidence_inbox.sql` 新增 evidence 攒批缓冲表。它只新增表，不改动既有数据。
应用后 `POST /memory/profile/ingest` 的响应从 `{ok, job_id}` 变为
`{ok, evidence_id, buffered, job_id: null}`——调用方若依赖 `job_id` 立即拿到 job，需要改为
通过 `GET /memory/claims` 观察最终结果。迁移前已排队的 `profile_extraction_jobs` 不受影响，
仍会被 Cron 正常消费。

迁移 `0017_memory_taxonomy_and_routing.sql` 为既有 Claim 默认补上 `domain_fact` 分类，并新增分类路由索引；
已有 Claim 的向量若尚未携带 `category` 元数据，查询时仍会通过 D1 兼容过滤，后续可按项目重新索引以获得完整的
Vectorize metadata filter 效果。
