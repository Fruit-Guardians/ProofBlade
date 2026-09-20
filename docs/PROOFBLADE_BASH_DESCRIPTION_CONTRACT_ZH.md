# 工具调用级 `description` 参数契约（U1）

> 文档版本：1.1.0
> 编写日期：2026-09-19（迁移方案定为选项 B）
> 文档性质：**工具契约变更提案，尚未实施**
> 来源：从 `docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md` 拆出（原表项 U1）
> ProofBlade 基线：`5060321`
>
> **v1.1.0 变更**：§3.2 由「需在评审中选定」改为**已选定 B（先可选、后转必填）**，并补充两轮实施要求；§3.4 新增第一轮（可选参数）验收条件，§4 改为第二轮（转必填）验收条件。

## 1. 为什么单独成文

本文原为性能优化计划的一项（U1，标为 P0）。**拆出的理由是它不是性能优化，而是破坏性工具契约变更**：

1. 它给 `bash` 和 `shell_background` 增加**必填**参数，改变模型的调用面；
2. 它改变工具参数校验的失败语义和错误返回结构；
3. 它需要独立的重放兼容性与迁移方案，而性能计划不具备评审这些内容的上下文；
4. 把它混在性能计划里，会让「性能回退如何回滚」与「契约变更如何回滚」两种完全不同的回滚粒度纠缠在一起。

因此本文独立评审、独立排期。**未获批准前，性能优化计划不得实施本项。**

## 2. 变更内容

### 2.1 新增参数

| 工具 | 参数 | 约束 | 用途 |
|---|---|---|---|
| `bash` | `description: string` | **必填**，1–160 字符，建议主动语态 5–10 词 | UI 标题、Artifact 摘要、错误上下文 |
| `shell_background` | `description: string` | **必填**，1–160 字符，建议主动语态 5–10 词 | Job 列表、轮询提示、日志标题 |

**明确不增加**：`read`、`glob`、`grep`、`edit`、`write`、`shell_job`。这些工具的现有参数（路径、操作、查询）已足以生成稳定展示；只有在无法从既有参数可靠派生标题时，才单独评估同类参数。**不新增工具，也不增加描述代理层。**

### 2.2 结构化参数错误反馈

调用级参数错误必须返回可修复反馈，而不是裸的 `schema mismatch`：

```json
{
  "isError": true,
  "details": {
    "schemaVersion": 1,
    "tool": "bash",
    "code": "BAD_TOOL_ARGS",
    "phase": "validate",
    "retryable": true,
    "receivedFields": ["command"],
    "missingFields": ["description"],
    "allowedFields": ["command", "description", "timeout"],
    "nextAction": "补充主动语态的 5-10 词描述后重试；不要重复发送相同参数。",
    "example": { "command": "npm test", "description": "Run the focused unit tests" }
  }
}
```

规则：

- 参数错误阶段**不启动命令、不写 Artifact、不写 Experiment**；
- 字段集合稳定排序；
- `nextAction` 必须可执行；
- 错误消息需要脱敏和长度上限。

## 3. 兼容性与迁移（本节是拆出的主要原因）

### 3.1 为什么这是破坏性变更

把参数改为必填后，**模型在收到新 Schema 前的所有历史调用形态都会失败**。需要区分两种「历史」：

| 场景 | 影响 | 处置 |
|---|---|---|
| 历史 Session 的重放（replay） | 旧事件里没有 `description` 字段 | 重放读取的是**已记录**的参数，不重新校验，因此**不受影响** |
| 已在运行、仍持有旧工具 Schema 的会话 | 模型按旧 Schema 生成调用，缺 `description` | 会被校验拒绝 |
| 新会话 | 模型看到新 Schema | 正常 |

**关键判断**：`description` 只影响展示，**不参与 command hash、Effect 幂等键、repeat key 或 Provider cache prefix**。因此历史 Effect 的幂等性不受影响，重放语义不变。

### 3.2 迁移选项

| 选项 | 行为 | 代价 |
|---|---|---|
| A. 直接改必填 | 旧 Schema 会话立即失败并得到 `BAD_TOOL_ARGS` | 最干净，但运行中会话会经历一次可修复失败 |
| **B. 先可选，后转必填** | **先以可选参数发布，模型逐步采纳；下一版本再改为必填** | **两轮发布，但运行中会话无感** |
| C. 可选 + 推导兜底 | 参数永远可选；缺失时从 `command` 首行推导标题 | 无破坏性，但拿不到「主动语态 5–10 词」的展示质量 |

**已选定：B（先可选，后转必填）。**

实施要求：

1. **第一轮**：`description` 为**可选**参数。Schema 中声明为可选并给出「建议主动语态 5–10 词」的描述；缺失时走 §3.3 的 GUI 兜底（命令首行），**不返回错误**。这一轮不得把缺失 `description` 当作参数错误。
2. **第二轮**：待采纳率数据证明可选阶段已稳定后，再把 `description` 改为必填，并启用 §4 的 `BAD_TOOL_ARGS` 校验与结构化反馈。
3. **两轮之间的观测**：用 `toolArgRepairHintRate`（收到提示后成功修复的比例）与 `description` 提供率判断何时可以转必填。**不要**在没有采纳率数据的情况下直接转必填。
4. 第二轮转必填时，必须重新评审 §3.1 的兼容性影响——那一轮才真正引入破坏性。

选 B 而不选 A：仓库既有的契约变更习惯是显式化 + 分轮发布；A 会在一轮内在运行中会话上制造可修复失败，收益仅是少一轮发布。选 B 而不选 C：C 永远拿不到稳定展示质量，而 GUI 标题质量正是本项主要收益。

**建议 B**：与仓库既有的「契约变更显式化」习惯一致，且避免在运行中打断会话。若采纳 A，必须在发布说明中明确「首次调用会失败一次，按 `nextAction` 补参数即可」。

### 3.3 GUI 侧兜底

无论选哪个选项，GUI 都必须保留兜底：**旧 Session 缺失 `description` 时回退到命令首行**，而不是显示空白标题。

### 3.4 第一轮（可选参数）的验收条件

第一轮**不启用** `BAD_TOOL_ARGS`，因此 §4 中依赖必填的条目不适用于第一轮。第一轮验收：

- [ ] `description` 声明为可选，缺失时命令正常执行、不返回参数错误。
- [ ] 缺失 `description` 时 GUI 回退到命令首行标题。
- [ ] 提供 `description` 时 GUI/Artifact 标题采用该描述。
- [ ] `description` **不改变** command hash、Effect 幂等键、repeat key、Provider cache prefix（逐项断言）。
- [ ] 记录 `description` 提供率，作为是否进入第二轮的判据。
- [ ] `read`、`glob`、`grep`、`edit`、`write`、`shell_job` 的参数集**未变**（回归断言）。

## 4. 第二轮的验收条件（转必填后）

- [ ] 缺失 `description` 时返回 `BAD_TOOL_ARGS`，且**底层命令未启动**（可用副作用探针断言）。
- [ ] 返回体包含 `receivedFields`、`missingFields`、`allowedFields`、`nextAction` 和最小 `example`。
- [ ] `description` 超长（>160）或空白时同样返回 `BAD_TOOL_ARGS`，不是通用 schema 错误。
- [ ] `description` **不改变** command hash、Effect 幂等键、repeat key、Provider cache prefix（逐项断言）。
- [ ] 历史 Session 重放结果与变更前逐字节一致。
- [ ] GUI 对缺失 `description` 的旧 Session 回退到命令首行。
- [ ] `read`、`glob`、`grep`、`edit`、`write`、`shell_job` 的参数集**未变**（回归断言）。

## 5. 关联指标

原性能计划 §7.3 的两项计数器随本文一并迁移：

- `toolArgValidationErrors`：参数校验失败次数；
- `toolArgRepairHintRate`：在收到 `BAD_TOOL_ARGS` 后成功修复并重试的比例。

`toolArgRepairHintRate` 是判断 §3.2 选型是否成功的主要依据：若长期偏低，说明 `nextAction` 文案不够可执行，或应改用选项 C。

## 6. 参考

- `docs/PROOFBLADE_GUI_PERFORMANCE_OPTIMIZATION_PLAN_ZH.md` §3.7（原文）、§4.1（测试与回滚）
- `docs/tool-contract.md`：工具契约、效果、重放和制品规则
- `docs/extensions.md`：ProofBlade 扩展机制与分层判断
