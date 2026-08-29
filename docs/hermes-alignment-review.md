# cf-mem 对齐 Hermes Agent 记忆系统审查报告

本文档记录了 `cf-mem` 在借鉴 NousResearch Hermes Agent 记忆沉淀体系后的 5 项功能实现审查结果与修复建议。

---

## 一、审查背景与对齐目标

Hermes Agent 的记忆架构核心在于：
1. **定时批量提炼（Nudge / Review Fork）**：回合数/定时驱动的后台提炼，避免逐轮阻塞并保证跨多轮上下文提炼。
2. **零语义 Prompt 门控（Trivial Prompt Gate）**：快速正则短路，跳过对"好/ok/谢谢"等无信息量输入的语义向量检索。
3. **负向禁止清单（Negative Extraction Rules）**：明确禁止提取环境依赖性报错、负面工具断言、未解决的死路尝试与一次性任务叙事。
4. **Claims 生命周期与使用反馈（Usage Feedback & Retention）**：基于 `use_count` 和 `last_used_at` 识别冷记忆，自动清理过期未生效的 `proposed` claims。
5. **非阻塞写的可靠性与断路器（Reliability & Circuit Breaker）**：跨请求共享的熔断与冷却机制，避免上游 LLM 故障时无节制重试消耗配额与系统资源。

---

## 二、审查发现与问题分类

### 1. 严重缺陷 (P0 / Critical)

#### 1.1 `CLAIM_COLUMNS` 遗漏使用统自动段导致读取永远为 0
- **文件位置**：`src/db/d1.ts`
- **问题描述**：
  在数据库迁移 `0016_claim_usage_tracking.sql` 中新增了 `use_count` 与 `last_used_at` 两个字段，并在 `recordClaimUsage` 中通过 `UPDATE memory_claims SET use_count = use_count + 1, last_used_at = ?` 进行写入。
  但 `src/db/d1.ts` 中的常量 `CLAIM_COLUMNS` **未包含这两个字段**：
  ```ts
  // 缺陷代码：
  const CLAIM_COLUMNS =
    "id, project_id, scope_kind, scope_id, type, subject, memory_key, value_json, canonical_text, status, provenance, confidence, valid_from, valid_until, superseded_by, applicability, workspace_id, created_at, updated_at";
  ```
- **影响**：
  所有通过 `CLAIM_COLUMNS` 查询出来的 `StoredClaimRow`（包括 `fetchClaimById`、`fetchClaimsByIds`、`fetchContextClaims`、`listClaims` 等），其 `use_count` 和 `last_used_at` 字段在 JavaScript 对象中均为 `undefined`。
  经过 `toClaimResponse` 格式化后，API 与 Admin 后台（`GET /memory/claims`）**永远只能读出 `use_count: 0, last_used_at: null`**。
- **修复方案**：
  在 `src/db/d1.ts` 的 `CLAIM_COLUMNS` 中加入 `use_count, last_used_at`。

---

#### 1.2 断路器熔断期间会导致正常 Job 与 Segment 被批量判定为永久失败
- **文件位置**：`src/memory/profile.ts`、`src/memory/llm-breaker.ts`
- **问题描述**：
  当外部 LLM 服务（OpenRouter / Profile Extractor）故障触发断路器开启（冷却 10 分钟）时，`withBreaker` 会抛出 `BreakerOpenError`。
  在 `src/memory/profile.ts` 的 `processProfileJob` 中，catch 块未区分 `BreakerOpenError` 与普通提取失败：
  ```ts
  } catch (error) {
    console.error(`[profile] job=${job.id} attempt=${job.attempt_count} failed: ${errorLabel(error)}`);
    const evidenceIds = jobEvidenceIds(job);
    for (const segmentId of evidenceIds) {
      await markSegmentExtractionFailed(env, segmentId).catch(() => {});
    }
    try {
      await failJob(env, job, error);
    } catch { ... }
  }
  ```
- **影响**：
  在熔断开启的 10 分钟内，后续 cron tick 会继续拾取处于 retry 状态的 Job。由于断路器处于 OPEN 状态，Job 每次都会立即抛出 `BreakerOpenError`，每次都累加 `job.attempt_count` 与 `extract_failed_count`。
  **仅需 3 次 cron tick，所有排队的合法 Job 都会被直接打上 `dead` 状态，所有待提炼段落也会因为 `extract_failed_count >= 3` 被永久丢弃**。
- **修复方案**：
  在 `processProfileJob` 的 catch 中判断 `isBreakerOpenError(error)`：
  1. 不递增 `job.attempt_count`；
  2. 不递增 segment 的 `extract_failed_count`；
  3. 将 job 的 `next_attempt_at` 延后到 `error.openUntilAt`（即冷却结束之后）。
  4. 在 cron 调度入口处，若 breaker 为 OPEN 则直接跳过提取任务处理。

---

#### 1.3 Nudge 扫描出的原生 Segment 因缺少 `[user]` 标记被 Extractor 过滤为空
- **文件位置**：`src/memory/profile.ts` (`boundedEvidenceText` 与 `userOriginatedText`)
- **问题描述**：
  `nudge.ts` 扫描 `memory_segments` 表中未提取的原始段落并创建 extraction job。
  但在 `processProfileJob` 处理时，`boundedEvidenceText` 会使用 `userOriginatedText` 提取用户文本：
  ```ts
  function userOriginatedText(text: string): string {
    const matches = [...text.matchAll(/(?:^|\n)\[user\]\s*([\s\S]*?)(?=\n\[[^\]]+\]\s|$)/gi)];
    return matches.map((match) => match[1].trim()).filter(Boolean).join("\n");
  }
  ```
  通过 `POST /memory/index` 普通接口写入的段落正文是纯文本，不包含 `[user]` 前缀。
- **影响**：
  `userOriginatedText` 对非 `[user]` 前缀文本返回空字符串 `""`，导致 `boundedEvidenceText` 返回 `[]`。
  LLM Extractor 接收到的证据文本为空，**Nudge 扫描出来的原生文本永远无法提炼出任何 Claim**。
- **修复方案**：
  在 `userOriginatedText` 中增加降级逻辑：若文本中未包含任何 `[role]` 格式的标记，则直接回退使用全文 `text.trim()`。

---

### 2. 重要逻辑与体验缺陷 (P1 / High & Medium)

#### 2.1 中文高频 Trivial Prompt 漏判
- **文件位置**：`src/memory/claims.ts` (`TRIVIAL_PROMPT_RE`)
- **问题描述**：
  当前正则表达式为：
  ```ts
  const TRIVIAL_PROMPT_RE = new RegExp(
    "^(是|对|好|嗯|哦|行|可以|不用|没有|谢谢|多谢|辛苦|继续|"
    + "yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|"
    + "continue|go ahead|proceed|do it|got it|cool|nice|great|done|next|lgtm|k)"
    + "[\\s!?.:;,，。！？、'\"~（）()\\[\\]{}<>*&^%$#@!+=`\\u00a0]*$",
    "i",
  );
  ```
  中文日常交互中最常见的确认词如 **“好的”、“收到”、“明白”、“知道了”、“没问题”、“可以的”、“行的”、“好嘞”、“好哒”** 均带有后续汉字，不属于标点符号类，因此**全部无法匹配该正则**。
- **影响**：
  绝大多数中文肯定与简短应答依然会触发完整的 Vectorize 向量召回和 Workers AI Embedding 调用，未达到节约延迟和成本的目标。
- **修复方案**：
  扩充中文常见简短确认短语及英文缩写（如 `thx`, `ty`, `np`, `pls` 等）。

---

#### 2.2 段落提取状态 `extracted_at` 的标记不一致
- **文件位置**：`src/memory/nudge.ts`、`src/memory/profile.ts`
- **问题描述**：
  `0014_segment_extraction_tracking.sql` 新增了 `extracted_at` 字段，用于标记该段落已被消费。
  但目前整个代码库中，只有 `nudge.ts` 在创建任务后更新了 `extracted_at`；而通过正常渠道 `/memory/profile/ingest` -> `flushReadyEvidenceGroups` 处理的段落，**从来没有更新过 `extracted_at`**。
- **修复方案**：
  在 `flushEvidenceGroup` 将 inbox 数据转为 job 时，或在 job 提取成功时，同步批量将相关 segment 的 `extracted_at` 更新为当前时间戳。

---

### 3. 次要容错与边界问题 (P2 / Low)

#### 3.1 `claim-dedup.ts` 中的 LLM 裁决绕过了 Circuit Breaker
- **文件位置**：`src/memory/claim-dedup.ts` (`judgeClaimPair`)
- **问题描述**：
  `llm-breaker.ts` 的头部注释写明断路器应覆盖 claim-dedup judging，但 `judgeClaimPair` 内部仍是直接 `fetch()`。在上游 LLM 服务宕机时，灰区 Claim 去重裁决每次都会卡满 15 秒超时。
- **修复方案**：
  将 `judgeClaimPair` 的底层 LLM 请求通过 `withBreaker` 进行包装。

#### 3.2 `llm-breaker.ts` 读取 D1 未做 Fail-open 容错
- **文件位置**：`src/memory/llm-breaker.ts` (`readBreakerState`)
- **问题描述**：
  `readBreakerState` 未包裹 `try/catch`。如果数据库在初始化阶段尚未完成 migration 0015，或 D1 出现瞬时连接错误，`withBreaker` 会直接抛出 D1 异常导致业务中断。
- **修复方案**：
  在 `readBreakerState` 中捕获异常并返回默认的 Closed 状态（Fail-open）。

#### 3.3 Nudge 中 Session ID 切割边界问题
- **文件位置**：`src/memory/nudge.ts` 第 127 行
- **问题描述**：
  `key.sessionId.slice(key.sourceApp.length + 1)` 假定了 `sessionId` 严格以 `${sourceApp}:` 开头。如果 `sessionId` 为 `"chat:1234"` 但 `sourceApp` 为 `"web"`，会导致切出 `":1234"`。
- **修复方案**：
  改用 `const colonIndex = key.sessionId.indexOf(":")` 进行定位切割。

---

## 三、修复代码参考

### 1. 补齐 `CLAIM_COLUMNS` (`src/db/d1.ts`)
```diff
- const CLAIM_COLUMNS =
-   "id, project_id, scope_kind, scope_id, type, subject, memory_key, value_json, canonical_text, status, provenance, confidence, valid_from, valid_until, superseded_by, applicability, workspace_id, created_at, updated_at";
+ const CLAIM_COLUMNS =
+   "id, project_id, scope_kind, scope_id, type, subject, memory_key, value_json, canonical_text, status, provenance, confidence, valid_from, valid_until, superseded_by, applicability, workspace_id, use_count, last_used_at, created_at, updated_at";
```

### 2. 修正 `processProfileJob` 熔断错误处理 (`src/memory/profile.ts`)
```diff
+ import { isBreakerOpenError } from "./llm-breaker";

  } catch (error) {
+   if (isBreakerOpenError(error)) {
+     console.warn(`[profile] job=${job.id} postponed: circuit breaker open until ${error.openUntilAt}`);
+     await env.DB.prepare(
+       "UPDATE profile_extraction_jobs SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?",
+     ).bind(error.openUntilAt, Date.now(), job.id).run();
+     return;
+   }
    console.error(`[profile] job=${job.id} attempt=${job.attempt_count} failed: ${errorLabel(error)}`);
    const evidenceIds = jobEvidenceIds(job);
    for (const segmentId of evidenceIds) {
      await markSegmentExtractionFailed(env, segmentId).catch(() => {});
    }
    // ... failJob ...
```

### 3. 修正 `userOriginatedText` 纯文本兜底 (`src/memory/profile.ts`)
```diff
  function userOriginatedText(text: string): string {
    const matches = [...text.matchAll(/(?:^|\n)\[user\]\s*([\s\S]*?)(?=\n\[[^\]]+\]\s|$)/gi)];
-   return matches.map((match) => match[1].trim()).filter(Boolean).join("\n");
+   if (matches.length > 0) {
+     return matches.map((match) => match[1].trim()).filter(Boolean).join("\n");
+   }
+   // 若不存在 [role] 格式分段，说明是 POST /memory/index 写入的原始段落，直接返回全文
+   if (!/\[(user|assistant|system|tool)\]/i.test(text)) {
+     return text.trim();
+   }
+   return "";
  }
```

### 4. 扩充 `TRIVIAL_PROMPT_RE` (`src/memory/claims.ts`)
```diff
  const TRIVIAL_PROMPT_RE = new RegExp(
-   "^(是|对|好|嗯|哦|行|可以|不用|没有|谢谢|多谢|辛苦|继续|"
+   "^(是|对|好|好的|好哒|好嘞|嗯|嗯嗯|哦|行|行的|可以|可以的|不用|没有|谢谢|多谢|辛苦|继续|收到|明白|知道了|没问题|成|"
-   + "yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|"
+   + "yes|no|ok|okay|sure|thanks|thank you|thx|ty|pls|np|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|"
    + "continue|go ahead|proceed|do it|got it|cool|nice|great|done|next|lgtm|k)"
    + "[\\s!?.:;,，。！？、'\"~（）()\\[\\]{}<>*&^%$#@!+=`\\u00a0]*$",
    "i",
  );
```
