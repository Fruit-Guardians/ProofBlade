# Evidence Record 最小契约与可恢复错误改造方案

状态：设计阶段，尚未修改运行时代码

## 1. 背景与问题定义

`CHAT-1789276128802` 在记录一条关于 PCAP 分析环境的证据时，连续调用了 `evidence` 的 `record` operation。Artifact `A-e2e12c44-180b-41b4-a007-53aeee8e1285` 是有效的；失败原因是请求同时携带了 `artifactId`、`query`、`treeId`、`relation`、`uri` 等属于其他 operation 的字段。

当前工具把 13 个 operation 的字段平铺在同一个 JSON Schema 中，所有字段都是可选的；运行时却按 operation 使用 `assertOnly()` 严格拒绝跨 operation 字段。模型看到的是“都可以填写”的 Schema，执行时遇到的是“只能填写本 operation 的字段”的隐藏条件。这是公开契约和运行时契约不一致，而不是模型、Artifact 或证据图数据本身损坏。

当前错误只列出不允许的字段：

```text
evidence record does not accept: artifactId, confidence, ...
```

它没有说明：

- 哪些字段是必填、哪些可选；
- 应删除还是替换字段；
- 可以直接重试的最小参数对象；
- 该 Artifact 已自动归档时是否真的还需要人工录入；
- 本次失败是否可以安全地由运行时纠正。

因此模型会试图以 `"unused"` 填满剩余字段，或只做局部删改，造成重复失败。

## 2. 目标与非目标

### 2.1 目标

1. 录入证据时，模型只需要提交必要事实，不需要理解或填写其他 operation 的字段。
2. 最小成功请求只要求 `artifactIds` 与 `summary`；`name` 可选，系统可从摘要确定性生成名称。
3. 对旧入口中“已知但与 record 无关”的多余字段，若核心 record 数据完整且合法，则一次调用成功，不让无害占位字段阻断任务。
4. 无法自动修复的错误必须返回可机器读取、可直接照抄重试的请求，而不是只给一串字段名。
5. 同一 operation 的参数变体反复得到同一类错误时，应在有限次数后停止重复调用，并把明确的恢复动作交给模型。
6. 保持现有 Evidence、Artifact、事件日志和旧会话重放的兼容性。

### 2.2 非目标

- 不改变 Evidence graph 的来源校验、去重、关联或持久化语义。
- 不自动把每个 bash 输出升级为用户声明的 Evidence；普通观测继续走自动归档链。
- 不把错误处理变成静默吞错：缺少必要字段、未知字段、错误 Artifact ID、类型错误和权限/状态错误仍必须失败。
- 不一次重构全部知识工具。先消除 `record` 的契约冲突，再按遥测决定是否拆分其他高频写操作。

## 3. 目标交互

### 3.1 判断是否需要录入

普通 Tool 输出已经自动保存为 Artifact 和 observation。只有某个结论会支撑后续决策、最终回答或可复现验证时，模型才调用证据录入。

模型可先调用 `evidence_curation_status`，但该检查不应成为所有操作的强制前置步骤。运行时在已有自动归档记录时应返回明确提示，例如：

```json
{
  "alreadyCaptured": true,
  "artifactId": "A-...",
  "guidance": "This artifact is already stored as a routine observation. Record evidence only for a new conclusion that will support a decision or final answer."
}
```

这是一条提示，不阻止模型为真正的结论建立 Evidence。

### 3.2 新的公开工具：`evidence_record`

面向 Provider 的工具不再携带 `operation`，也不展示查询、图边、树、URI 等无关字段。

```ts
type EvidenceRecordInput = {
  artifactIds: string[];       // 必填，1 至 16 个已有 A-* Artifact ID
  summary: string;             // 必填，陈述该 Artifact 支持的可核查结论
  name?: string;               // 可选；省略时由 summary 确定性生成
  tags?: string[];             // 可选
  claim?: string;              // 可选；仅在需要区分结论与摘要时提供
  dependsOn?: string[];        // 可选；仅在结论依赖已有 Evidence 时提供
};
```

最小调用：

```json
{
  "artifactIds": ["A-e2e12c44-180b-41b4-a007-53aeee8e1285"],
  "summary": "tshark 未安装，但 Python 可用。"
}
```

完整但仍简洁的调用：

```json
{
  "artifactIds": ["A-e2e12c44-180b-41b4-a007-53aeee8e1285"],
  "name": "初始 PCAP 分析环境",
  "summary": "tshark 未安装，但 Python 可用。",
  "tags": ["environment", "pcap"],
  "claim": "后续 PCAP 分析应使用 Python 库或先安装 tshark。"
}
```

名称生成规则必须确定性，例如取 `summary` 的第一行、规范化空白、截断到 80 个 Unicode code point，并在空摘要时拒绝请求；不能调用模型生成名称。这样重放和去重不会因名称漂移而改变。

### 3.3 工具描述

`evidence_record` 的 description 应短且可执行：

```text
Record a durable conclusion supported by existing Artifacts. Required: artifactIds and summary. Optional: name, tags, claim, dependsOn. Omit every field that is not needed. Routine tool output is already captured; use this only for a conclusion that supports a decision or final answer.
```

关键用词是 `omit`，不是要求模型把未使用字段填为 `null`、空数组或 `"unused"`。

## 4. 运行时架构

### 4.1 新入口与内部共用实现

新增 `evidence_record` 工具，其 handler 直接调用一个私有的 `recordEvidence(input, context)` 函数。现有 `evidence` 的 `record` 分支在兼容期也调用该函数，避免两套校验、事件和 curation 行为分叉。

```text
Provider
  -> evidence_record (精确 Schema)
       -> normalizeRecordInput
       -> validateRecordInput
       -> recordEvidence
       -> CodingEvidenceGraph.recordEvidence

旧会话 / 旧 Provider 请求
  -> evidence { operation: "record" }
       -> normalizeLegacyRecordInput
       -> validateRecordInput
       -> recordEvidence
```

`CODING_PROXY_TOOL_NAMES`、Tool effect policy、可用工具列表、运行时文档和测试夹具必须一并更新。`evidence_record` 是写操作；只读的 `evidence` operation 仍维持现有 effect policy。

### 4.2 兼容期的规范化规则

旧 `evidence(record)` 请求按下列规则处理：

1. 提取 `artifactIds`、`summary`、`name`、`tags`、`claim`、`dependsOn`。
2. 当提取后的必填字段合法时，丢弃已知的其他 `evidence` operation 字段，例如 `query`、`treeId`、`relation`、`uri`、`confidence`。
3. 成功结果中带上 `normalization`，使 GUI、日志和模型可见该次调用被收敛：

```json
{
  "evidenceId": "EV-...",
  "normalization": {
    "legacyOperation": "record",
    "ignoredFields": ["query", "treeId"],
    "message": "Known fields for other evidence operations were ignored. Use evidence_record for future records."
  }
}
```

4. 对未知字段、同名字段的类型错误、无效 Artifact ID，以及缺少 `artifactIds` 或 `summary` 的请求不做猜测，返回结构化失败。
5. 不把 `artifactId` 自动改写为 `artifactIds`。这是字段语义变换而不是删除无害字段；错误应明确要求模型传入数组，避免把 annotate/read 请求错误地升级成 Evidence。

该策略让本次事故中已经携带有效 `artifactIds`、`name` 和 `summary` 的调用一次成功，同时保留对真正无效请求的可观察性。

### 4.3 迁移和下线

1. 先加入 `evidence_record` 与兼容规范化，并令新建会话仅暴露新工具。
2. `evidence` 保留 `record` 路由，仅用于旧 Session 重放和显式兼容；其 description 标记为 legacy，不向模型推荐。
3. 连续两个发布周期内记录 legacy 调用量、规范化次数与失败原因。
4. 当旧调用接近零且重放夹具完成迁移后，从新会话的 `evidence.operation` 枚举中移除 `record`；历史事件的执行结果不重写。

不应通过更长的 `evidence` description 来弥补平铺 schema。文本提示只能辅助；公开 schema 必须让正确形状成为唯一自然选择。

## 5. 可恢复错误契约

### 5.1 统一错误载荷

错误继续使用 Pi 的 `isError: true`，但 `details` 必须提供稳定结构，`content[0].text` 提供同样信息的简短文本版本。

```ts
type ActionableToolError = {
  code: string;
  tool: string;
  operation?: string;
  retryable: boolean;
  receivedFields?: string[];
  invalidFields?: Array<{ field: string; reason: string }>;
  missingFields?: string[];
  allowedFields?: string[];
  suggestedArguments?: Record<string, unknown>;
  nextAction: string;
};
```

`code` 必须稳定，供重复失败 breaker 和遥测使用；不得依赖自然语言错误文本匹配。

### 5.2 旧入口中包含无关字段

当必填字段齐全时，该情形已由兼容规范化成功，不产生错误。若后续移除兼容层或收到不能安全忽略的字段，返回：

```json
{
  "code": "EVIDENCE_RECORD_UNSUPPORTED_FIELDS",
  "tool": "evidence_record",
  "operation": "record",
  "retryable": true,
  "invalidFields": [
    { "field": "treeId", "reason": "treeId is used only by evidence tree operations" },
    { "field": "query", "reason": "query is used only by evidence search operations" }
  ],
  "allowedFields": ["artifactIds", "summary", "name", "tags", "claim", "dependsOn"],
  "suggestedArguments": {
    "artifactIds": ["A-e2e12c44-180b-41b4-a007-53aeee8e1285"],
    "summary": "tshark 未安装，但 Python 可用。",
    "name": "初始 PCAP 分析环境"
  },
  "nextAction": "Retry once with suggestedArguments exactly. Omit unsupported fields; do not replace them with placeholders."
}
```

文本摘要应为：

```text
evidence_record can be retried. Remove treeId and query; do not use placeholders. Required fields are artifactIds and summary. Retry exactly with details.suggestedArguments.
```

### 5.3 缺少必填字段

```json
{
  "code": "EVIDENCE_RECORD_MISSING_REQUIRED_FIELDS",
  "tool": "evidence_record",
  "retryable": true,
  "missingFields": ["artifactIds"],
  "allowedFields": ["artifactIds", "summary", "name", "tags", "claim", "dependsOn"],
  "suggestedArguments": {
    "artifactIds": ["A-<existing-artifact-id>"],
    "summary": "<supported conclusion>"
  },
  "nextAction": "Use an existing A-* Artifact ID returned by a tool result or evidence search; do not use artifactId (singular)."
}
```

`suggestedArguments` 只能回显已验证安全的原输入，或使用显式占位符；绝不能伪造 Artifact ID、Evidence ID 或结论。

### 5.4 不可重试错误

不存在的 Artifact、无权限 Artifact、Artifact 所属 Run 不匹配、摘要超出限制和 curation 状态不允许时，`retryable` 必须为 `false` 或给出先决动作。例如：

```json
{
  "code": "EVIDENCE_RECORD_ARTIFACT_NOT_FOUND",
  "tool": "evidence_record",
  "retryable": false,
  "invalidFields": [{ "field": "artifactIds[0]", "reason": "Artifact A-... does not exist in this Run" }],
  "nextAction": "Read the latest tool result or call evidence_search to obtain an existing Artifact ID. Do not retry this ID."
}
```

模型不应在 `retryable: false` 时原样重发同一请求。

## 6. 重复失败保护

当前 `RepeatedToolFailureBreaker` 用完整输入和错误文本共同生成 key。模型只要改变一个无关占位字段，连续次数就被重置。改造后按错误类别建立更稳定的 failure signature：

```ts
{
  toolName,
  operation: input.operation ?? undefined,
  errorCode: actionableError.code,
  requiredFieldState: actionableError.missingFields ?? [],
  invalidFieldNames: actionableError.invalidFields?.map(({ field }) => field).sort() ?? []
}
```

规则如下：

- 对同一 `tool + operation + errorCode` 的可重试参数错误，连续两次后注入一次强制恢复提示；第三次停止该工具序列。
- 对 `retryable: false` 的错误，立即禁止相同 failure signature 的重试，并提示模型转向 `nextAction`。
- 只有成功调用或不同的 operation 才重置该 operation 的失败计数；改变 `unused`、`null`、字段顺序或其他无关值不得重置。
- `continuousRecovery` 可以继续保留，但不得把明确的参数错误无限转换成建议。达到阈值时应禁止同类 Tool call，允许模型采用替代动作或结束当前结论。

## 7. 实施步骤

### 阶段 A：契约和适配层

1. 将 record 公共参数提取为 `EvidenceRecordInput` 与独立 TypeBox schema。
2. 新增 `evidence_record`，只公开上述六个字段，且 `artifactIds`、`summary` 为 required，`additionalProperties: false`。
3. 提取共享的 `recordEvidence`、名称生成和 `validateRecordInput` 实现。
4. 将旧 `evidence(record)` 改为兼容规范化，记录 `normalization`，不要先调用全局 `assertOnly()`。
5. 调整工具注册、effect policy、可用工具白名单和系统提示，使新会话选择 `evidence_record`。

### 阶段 B：错误与 Guard

1. 新增 `ActionableToolError` 构造器，统一 `content`、`details` 与稳定 `code`。
2. 把 record 的缺字段、类型、Artifact 解析和来源错误映射到该结构。
3. 调整 `RepeatedToolFailureBreaker` 使用 failure signature，而不是完整原始 JSON。
4. 在 model context / GUI Tool 卡片展示 `nextAction` 与 `suggestedArguments`，将其作为一等恢复信息而不是仅显示错误字符串。

### 阶段 C：迁移与观测

1. 为 legacy `evidence(record)` 增加 deprecation telemetry，不向新模型 context 暴露。
2. 观察两个发布周期，再决定是否拆分 `annotate`、`link` 和 tree 写操作。
3. 在发布说明中写明：`evidence_record` 只需 Artifact 与摘要；其他字段全部可省略。

## 8. 测试与验收

### 8.1 单元测试

- `evidence_record` 的 provider schema 仅包含 `artifactIds`、`summary`、`name`、`tags`、`claim`、`dependsOn`。
- 仅有 `artifactIds + summary` 即可创建 Evidence，并生成稳定名称。
- 有效的可选字段能正确传入 graph。
- 缺少 `artifactIds` 或 `summary` 返回对应稳定 error code 和完整 `suggestedArguments`。
- 无效 ID、类型错误和跨 Run Artifact 不被兼容层吞掉。
- legacy 请求中带有本次事故的全部无关字段时，创建一次 Evidence，并报告被忽略字段。
- legacy 请求仅有 `artifactId` 而没有 `artifactIds` 时失败，且提示使用复数数组。

### 8.2 Guard 测试

- 相同 `record` 参数错误三次后停止。
- 每次只更换 `"unused"`、空值、字段顺序或无关字段，仍计入同一错误序列。
- 修正为最小 `evidence_record` 请求后，计数清零并成功。
- `retryable: false` 的 Artifact 不存在错误不允许重复调用。
- 在 `continuousRecovery` 下，达到阈值后仍能继续模型文本或其他工具，但不能再次执行同类失败调用。

### 8.3 会话回归

为 `CHAT-1789276128802` 建立脱敏 fixture：第一次调用采用原始的平铺参数。验收标准：

1. 兼容路径在一次调用内成功，或新工具路径在首个模型调用就生成最小对象；
2. 不出现第二次相同的 record 参数错误；
3. Artifact、Evidence、normalization 和 Tool result 在 JSONL 重放后保持一致；
4. 不影响现有 `coding-resources`、evidence graph、curation gate 和 replay 测试。

### 8.4 发布指标

发布后记录并按版本比较：

- `evidence_record` 首次成功率；
- 每个会话的 record 参数错误次数；
- legacy 规范化次数及被忽略字段分布；
- `EVIDENCE_RECORD_*` error code 分布；
- 因重复 Tool failure breaker 中止的次数；
- Provider Tool schema 的字符数与固定上下文 token 增量。

验收阈值：复现 fixture 的 `record` 参数错误从至少 5 次降至 0 次；在新会话中，`evidence_record` 的首次调用成功率不低于当前其他简单写工具的首次成功率；不产生自动修复后错误关联到错误 Artifact 的事件。

## 9. 风险与决策

| 风险 | 处理 |
| --- | --- |
| 新增工具增加 Tool 列表长度 | 只先拆分高频、写入且字段最多的 `record`；用固定 schema token 指标验证成本。 |
| 忽略字段掩盖模型错误 | 仅 legacy `record` 且必填字段完整时忽略已知跨 operation 字段；结果明确记录 normalization；未知字段和关键字段错误仍失败。 |
| 自动生成名称降低可读性 | 使用确定性、可预测的名称；调用方需要特定名称时仍可传 `name`。 |
| 错误详情引入虚假建议 | 只回显已验证值或明确占位符；不凭空生成 ID、结论或状态。 |
| 旧会话重放受影响 | 保留旧路由和共享内部实现；增加历史 payload 回归夹具。 |

## 10. 完成定义

满足以下条件才视为完成：

- 新会话中可见的证据录入工具只要求最小、相关的字段；
- `artifactIds + summary` 可完成一次合法证据录入；
- 原始事故的平铺请求不会再导致连续错误；
- 无法自动修复的错误提供稳定 code、字段级原因、最小重试参数和明确下一动作；
- 无关占位字段变化不能绕过重复失败保护；
- 单元、集成、会话重放和既有测试套件全部通过；
- 兼容层的使用情况可观测，并有明确下线路径。
