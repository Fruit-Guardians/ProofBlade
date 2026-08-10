# 更新日志

> 此文件由 `project-status.json` 生成，请勿直接编辑。
> 状态更新时间：2026-08-10T14:08:00+08:00

## 索引

| 更新 | 时间 | 关联计划 | 分支 | 提交 |
| --- | --- | --- | --- | --- |
| UPDATE-20260810-003 | 2026-08-10T14:08:00+08:00 | PLAN-110, PLAN-120 | codex/fix-evidence-repeat-loop | 本条记录所在提交 |
| UPDATE-20260810-002 | 2026-08-10T11:17:00+08:00 | PLAN-110, PLAN-120, PLAN-200 | main | 本条记录所在提交 |
| UPDATE-20260810-001 | 2026-08-10T00:31:33+08:00 | PLAN-100 | codex/capability-backend-foundation | 本条记录所在提交 |
| UPDATE-20260809-030 | 2026-08-09T23:32:20+08:00 | PLAN-100 | codex/capability-backend-foundation | 本条记录所在提交 |
| UPDATE-20260809-029 | 2026-08-09T21:05:00+08:00 | PLAN-120 | codex/gui-polling-backpressure | 本条记录所在提交 |
| UPDATE-20260809-028 | 2026-08-09T20:45:00+08:00 | PLAN-120 | codex/gui-polling-backpressure | 本条记录所在提交 |
| UPDATE-20260809-027 | 2026-08-09T17:01:39+08:00 | PLAN-120 | codex/gui-polling-backpressure | 本条记录所在提交 |
| UPDATE-20260809-005 | 2026-08-09T16:18:52+08:00 | PLAN-110 | codex/evidence-curation-convergence | 本条记录所在提交 |
| UPDATE-20260809-004 | 2026-08-09T15:00:00+08:00 | PLAN-110 | codex/convergence-progress-guard | 本条记录所在提交 |
| UPDATE-20260809-003 | 2026-08-09T14:00:00+08:00 | PLAN-120 | codex/preserve-user-task-anchor | 本条记录所在提交 |
| UPDATE-20260809-002 | 2026-08-09T12:00:00+08:00 | PLAN-120 | codex/preserve-user-task-anchor | 本条记录所在提交 |
| UPDATE-20260809-001 | 2026-08-09T01:15:42.9850913+08:00 | PLAN-120 | codex/preserve-user-task-anchor | 本条记录所在提交 |
| UPDATE-20260808-006 | 2026-08-08T22:15:00+08:00 | PLAN-110 | codex/evidence-curation-breaker | 本条记录所在提交 |
| UPDATE-20260808-005 | 2026-08-08T15:15:00+08:00 | PLAN-110 | codex/evidence-curation-breaker | 本条记录所在提交 |
| UPDATE-20260808-004 | 2026-08-08T13:20:00+08:00 | PLAN-110 | codex/evidence-curation-breaker | 本条记录所在提交 |
| UPDATE-20260808-003 | 2026-08-08T10:33:24+08:00 | PLAN-001, PLAN-002 | main | 本条记录所在提交 |
| UPDATE-20260808-001 | 2026-08-08T02:47:55.5788475+08:00 | PLAN-120 | codex/context-length-recovery | 本条记录所在提交 |
| UPDATE-20260808-002 | 2026-08-08T02:02:26.8610595+08:00 | PLAN-120 | codex/provider-schema-compat | 本条记录所在提交 |
| UPDATE-20260807-007 | 2026-08-07T23:08:26.1335151+08:00 | PLAN-130 | codex/gui-shutdown-v2 | 本条记录所在提交 |
| UPDATE-20260807-006 | 2026-08-07T22:44:53.9883278+08:00 | PLAN-130 | codex/gui-shutdown-v2 | 本条记录所在提交 |
| UPDATE-20260807-005 | 2026-08-07T22:17:05.6261580+08:00 | PLAN-130 | codex/gui-shutdown-v2 | 本条记录所在提交 |
| UPDATE-20260807-004 | 2026-08-07T20:17:19+08:00 | PLAN-130 | codex/gui-shutdown-v2 | 本条记录所在提交 |
| UPDATE-20260807-003 | 2026-08-07T19:55:00+08:00 | PLAN-001 | codex/ci-regression-gates | 本条记录所在提交 |
| UPDATE-20260807-002 | 2026-08-07T18:37:33+08:00 | PLAN-002 | codex/component-audit-ledger | 本条记录所在提交 |
| UPDATE-20260807-001 | 2026-08-07T18:09:45+08:00 | PLAN-001 | codex/component-audit-ledger | a468b14 |

## UPDATE-20260810-003

时间：2026-08-10T14:08:00+08:00

摘要：修复重复 Artifact、Evidence 整理及混合副作用批次导致的无进展终止错误。

### 变更

- Evidence 和 annotation 的持久进展身份改用 Artifact 内容 SHA-256，不再依赖临时 Artifact ID 或展示措辞
- 显式 durableProgress=false 的 Evidence 观察在进程型 bash 之间继续累计收敛计数
- platform 成功调用可撤销任一来源的 no_progress，未解析策略只撤销 read-window
- no_progress 终止记录 read 或 declared-no-progress 来源窗口，仅 read-window 允许普通 process 或未解析策略成功调用撤销
- declared-no-progress 终止保持优先级，后续 read-window 终止不能覆盖并为 process 打开撤销路径
- 增加重复 Artifact、副本 annotation、混合 bash/evidence 以及真实 Harness 对称副作用批次回归测试

### 验证

- [x] 162/162 repository tests passed
- [x] component, contract and project report gates passed
- [x] rollback copy restored to the original SHA-256

## UPDATE-20260810-002

时间：2026-08-10T11:17:00+08:00

摘要：把确定性评测从 18 次 Fixture 重复升级为 30 项求解与运行时双矩阵门禁。

### 变更

- 保留六个 Fixture 各三次的 18 个生产循环，并新增 12 个独立运行时场景
- 新增缓存用量与前缀漂移、上下文单调性与用户任务锚点评测
- 新增重复失败、无进展、失败风暴、Evidence 整理背压与并发去重评测
- 新增暂停重放、Verifier 权限和 Lease 所有权隔离评测
- baseline-v3 报告分列 fixtureTotal/scenarioTotal，并将两个 Catalog 与场景结果纳入稳定哈希

### 验证

- [x] 104/104 Materials tests passed
- [x] 153/153 repository tests passed
- [x] 30/30 deterministic evaluation cases passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities
- [x] runtime scenarios cover 5 categories

## UPDATE-20260810-001

时间：2026-08-10T00:31:33+08:00

摘要：修复 Capability Backend 复审发现的 MCP 故障转移、操作匹配、版本投影和新 Job 绑定约束。

### 变更

- MCP availability 按具体 server 状态判断，连接失败后 Resolver 可选择备用 Backend
- MCP Backend 只处理 describe/call，并用 catalogHash 统一状态与恢复绑定版本
- ControlStore 新 job_queued 命令在类型与运行时校验 backendId/backendVersion
- 增加 job_queued_legacy 兼容旧事件，并补齐真实 MCP 连接失败转移测试

### 验证

- [x] 99/99 Materials tests passed
- [x] 148/148 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260809-030

时间：2026-08-09T23:32:20+08:00

摘要：建立稳定逻辑 Capability 与可替换执行 Backend 的基础层，为 PE/ELF、固件和 Ghidra 能力接入保留模型自主规划空间。

### 变更

- 新增统一 CapabilityBackend 与确定性 Resolver，支持 bundled、MCP、本地进程和 provider-native 实现类型
- 模型继续使用稳定 list_capabilities/invoke_capability 代理，不暴露重复的后端专用工具
- Effect 与 Artifact 保存 capability、manifest 和 backend 来源，后台 Job 固定 Backend ID 与版本
- 恢复时复用已绑定 Backend 并拒绝版本漂移；仅允许在执行开始前跳过不可用实现
- 增加 Backend 选择、显式绑定、重复 ID、版本漂移和后台恢复回归测试

### 验证

- [x] 98/98 Materials tests passed
- [x] 147/147 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260809-029

时间：2026-08-09T21:05:00+08:00

摘要：修复 RunDetail 字节估算边界和关闭期间的详情加载回填。

### 变更

- boundedJsonByteSize 补齐数组结束括号，并增加与 JSON.stringify 的嵌套数组字节对照测试
- GUI shutdown 清理详情 in-flight 表；关闭状态禁止旧加载写入 RunDetail 缓存
- 增加关闭竞态回归测试，确保 close 返回后迟到加载不会重新占用缓存

### 验证

- [x] 42/42 GUI tests passed
- [x] 143/143 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260809-028

时间：2026-08-09T20:45:00+08:00

摘要：修复 RunDetail 版本化并发加载、超限缓存残留和失败刷新丢失交互重试。

### 变更

- RunDetail in-flight key 绑定 events.jsonl 与 Pi Session 版本，避免新请求复用旧快照；旧版本加载完成后重新校验，禁止覆盖新缓存
- RunDetail 版本失配时先删除旧条目；加权 LRU 限制单项 8 MiB、总量 64 MiB，并使用有界大小估算，超限详情不缓存
- 轮询首轮失败后仍消费已排队的交互刷新，尾随成功时恢复请求流程
- 增加 Session 版本切换期间的 single-flight 回归测试和超限详情清除旧缓存回归测试

### 验证

- [x] 143/143 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260809-027

时间：2026-08-09T17:01:39+08:00

摘要：消除 GUI 跨 Run 重叠刷新、迟到响应覆盖、后台等待积压、过期详情缓存、缓存堆积和恢复后残留错误。

### 变更

- Run 切换、定时器、手动操作和对话完成刷新共用稳定单飞协调器；后台 tick 忙时立即返回且不积压等待 Promise，交互刷新合并一次最新请求
- 旧 Run 的迟到详情响应通过当前 Run 身份校验拒绝提交
- 未变化 Run 详情按 events.jsonl 与递归排序后的 Pi Session 文件状态命中容量 32 的 LRU
- Session 加载期间发生变化时重读一次，连续变化的混合快照不进入缓存；RunDetail 缓存增加单项 8 MiB、总量 64 MiB 的加权上限，同一 Run 并发 miss single-flight，服务关闭时清空缓存
- 后台与交互刷新模式贯穿单飞协调器；后台成功保留可见错误，Run 切换、手动刷新和对话完成等交互刷新成功后清除已恢复的请求错误
- 后台刷新失败后仍消费已排队的交互尾随刷新；增加跨 Run 轮询背压、后台忙调用立即完成、失败尾随重试、Session 单独变化失效、并发 miss、加权淘汰和关闭清理回归测试

### 验证

- [x] 143/143 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] 309 Runs 下详情冷请求 39 ms、缓存命中 6-8 ms
- [x] GUI 服务空闲 5 秒消耗 0.172 CPU 秒
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260809-005

时间：2026-08-09T16:18:52+08:00

摘要：修复 Evidence 整理半提交、并发重复整理假进展和多样错误循环，恢复真实逆向任务收敛。

### 变更

- Control Store 新增原子批量领域命令，任一校验失败时不追加部分事件
- Control Store 新增按 Run 串行事务，让快照读取、幂等判断、ID 生成和批量提交处于同一临界区
- Evidence record 与 annotate 改为有界、并发幂等写入并返回稳定进展键
- Evidence Tool 新增 curation_status，并明确 record/annotate 的单双数参数契约
- 增加 12 次多样 Tool 失败预算和 GUI 可恢复终止投影
- Windows Coding Prompt 明确使用 python/py 和工作区相对中间文件

### 验证

- [x] 132/132 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260809-004

时间：2026-08-09T15:00:00+08:00

摘要：增加基于 Tool Contract 的有界无进展守卫并刷新推理森林，阻止 Coding Agent 重复探索。

### 变更

- 在单个用户回合的滚动窗口内只统计 Tool Contract 明确标记为只读且无副作用的重复观察，第三次无新信息时机械终止
- 任意 Bash、未知插件、持久写入和副作用 MCP 调用均重置进展窗口，混合工具批次中的真实进展不会被误停
- GUI 将 no_progress 投影为可见、可恢复的正常 Assistant 回复，并通过 Pi Entry ID 精确关联历史消息
- 每个外部用户回合刷新推理森林，注入有界 orphan 摘要，并按 Artifact 内容哈希去重整理积压

### 验证

- [x] npm run verify
- [x] 124/124 automated tests passed, including durable Bash writes and side-effecting MCP/plugin reset contracts
- [x] 18/18 deterministic fixture evaluations passed
- [x] real DeepSeek reverse-engineering smoke run advanced to a new PE section and .rdata analysis path
- [x] paused smoke run aborted its in-flight Provider request without later tool calls

## UPDATE-20260809-003

时间：2026-08-09T14:00:00+08:00

摘要：收紧自动上下文恢复消息识别，避免误伤引用恢复标记的正常用户任务。

### 变更

- 以完整固定恢复提示执行精确匹配，不再对用户正文使用 includes 标记过滤
- 上下文恢复发送路径复用同一固定提示常量
- 增加用户正文引用恢复标记仍被识别为真实任务的回归测试

### 验证

- [x] 117/117 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260809-002

时间：2026-08-09T12:00:00+08:00

摘要：修复连续上下文溢出时内部恢复提示冒充用户任务的问题。

### 变更

- 新增共享的外部用户任务锚点判定，排除自动上下文恢复提示
- Coding Lane、Agent Pruner 和 Durable Compaction 共用任务锚点逻辑
- 恢复提示在二次压缩时可被裁剪，原始用户任务继续进入摘要和 retained tail
- 增加连续两次 length 恢复顺序回归测试

### 验证

- [x] 116/116 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260809-001

时间：2026-08-09T01:15:42.9850913+08:00

摘要：修复长工具回合与持久压缩丢失最新用户任务的问题。

### 变更

- 紧急 Provider 视图裁剪永久保留最新 User Message
- Pi retained tail 缺失用户消息时从持久化 Session 分支补回
- 机械 Compaction 摘要显式记录当前用户请求，不再只依赖通用 Run objective
- 增加长工具链裁剪与持久压缩任务锚点回归测试

### 验证

- [x] 115/115 repository tests passed
- [x] latest-user-task-anchor and compaction-task-anchor contracts passed
- [x] component audit limited to materials, materials-context and materials-runtime

## UPDATE-20260808-006

时间：2026-08-08T22:15:00+08:00

摘要：使用稳定 Pi Entry ID 关联断路器事件与历史 Assistant 消息。

### 变更

- Coding Lane 将当前回合最终 Pi Assistant Entry ID 持久化到 assistant_message 事件
- GUI 只按完全匹配的 piEntryId 投影断路器恢复提示，不再查找最新空错误消息
- 缺少稳定 ID 的旧事件不执行模糊回填，避免污染后续真实 Provider 错误
- 增加断路器后再次发生 Provider 错误的历史重建回归测试

### 验证

- [x] 113/113 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260808-005

时间：2026-08-08T15:15:00+08:00

摘要：修复断路器终止结果在 GUI 中被错误显示为 Provider 失败。

### 变更

- AgentOutcome 增加结构化 repeated_tool_failure 终止原因
- 已确认的断路器终止规范化为非错误 stop 结果并保留底层 Provider 原因
- GUI 流式通道发送 done 而不是 error，并修正刷新后的持久化会话投影
- 增加 GUI 流式和持久化回归测试

### 验证

- [x] 112/112 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component, contract and project report gates passed
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260808-004

时间：2026-08-08T13:20:00+08:00

摘要：修复 Evidence Curation 阶段重复工具调用导致的 Agent 无限循环。

### 变更

- 让 evidence inspect_forest 运行时契约接受 maxChars，并限制模型可见输出
- 通过 Pi tool_result 钩子追踪工具、规范化参数和错误签名
- 同一工具失败连续三次后终止当前 Agent 回合并返回恢复提示
- 混合工具批次继续运行时，在下一次 Provider 请求前强制停止
- 增加重复失败、混合批次、参数契约和变更契约回归测试

### 验证

- [x] 110/110 repository tests passed
- [x] npm run check:components
- [x] npm run check:change-contracts
- [x] npm run build

## UPDATE-20260808-003

时间：2026-08-08T10:33:24+08:00

摘要：修复组件审计基线在多 PR 合并后的过期指纹误判，并完善 CI 审计时间自动推断。

### 变更

- 允许源码未变化但基线审计指纹过期时进行一次精确源码哈希修复
- 要求修复同时满足当前源码哈希、单次 BUG/安全审计递增和审计时间递增
- 为 stale-audit-repair 增加 CI 回归契约测试和文档说明
- 保留显式、环境、PR 事件、Git 提交和当前时间的审计时间回退链

### 验证

- [x] npm run test:ci-gates
- [x] npm run check:components -- --base 9022dd9b0479832f3aba45613add2699b8997671
- [x] npm run check:change-contracts -- --base 9022dd9b0479832f3aba45613add2699b8997671
- [x] npm run check:project-reports -- --base 9022dd9b0479832f3aba45613add2699b8997671

## UPDATE-20260808-001

时间：2026-08-08T02:47:55.5788475+08:00

摘要：修复长工具回合压缩无效和 length 空回复，建立有界上下文恢复。

### 变更

- 按模型窗口扣除输出、System/Tool 和 Provider 安全预算，不硬编码全局 16K 上限
- prune 阶段将消息降到恢复目标，并对 Pi retainedTail 执行二次有界裁剪
- Coding length 自动压缩续跑最多两次，Solver length 进入既有上下文恢复状态机
- GUI 隐藏内部续跑提示，原始调试轨迹和恢复计数保持可审计

### 验证

- [x] 104/104 repository tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] component documentation check passed: 25 components, 5 affected
- [x] npm audit: 0 vulnerabilities

## UPDATE-20260808-002

时间：2026-08-08T02:02:26.8610595+08:00

摘要：修复严格 OpenAI-compatible Provider 拒绝 Coding Tool Schema 的问题。

### 变更

- 将 evidence 的根级判别联合改为 type object 和 operation 字符串枚举
- 将 Coding Tool 内部离散选项改为直接字符串 enum，消除 Provider 可见 anyOf
- 把 operation 的必需字段和互斥字段约束保留在确定性运行时校验中
- 增加全部 Coding Provider Tool 根 Schema 兼容性与跨操作字段拒绝测试

### 验证

- [x] coding provider schema compatibility contract
- [x] npm run test --workspace=@proofblade/materials
- [x] npm run verify

## UPDATE-20260807-007

时间：2026-08-07T23:08:26.1335151+08:00

摘要：统一暂停状态到所有 Run 终态的原子转换策略。

### 变更

- ControlStore 统一拒绝 PAUSED 状态下的 finish、fail 和 exhaust
- Reducer 拒绝所有 PAUSED 到终态的事件重放
- Loop 在迟到的 exhaust 被拒绝后重新读取并返回 PAUSED
- 新增 contract:pause-before-exhaust 和暂停终态策略测试

### 验证

- [x] contract:pause-before-exhaust
- [x] paused runs reject every terminal command until explicitly resumed
- [x] npm run check:change-contracts
- [x] npm run verify

## UPDATE-20260807-006

时间：2026-08-07T22:44:53.9883278+08:00

摘要：原子阻止暂停状态被最终成功提交覆盖。

### 变更

- ControlStore 在单写者命令校验内拒绝 PAUSED 状态的成功 finish
- Reducer 重放拒绝 PAUSED 到 SUCCEEDED 的非法状态转换
- 新增 contract:pause-before-finish 精确竞态回归测试

### 验证

- [x] contract:pause-before-finish
- [x] npm run check:change-contracts
- [x] npm run verify

## UPDATE-20260807-005

时间：2026-08-07T22:17:05.6261580+08:00

摘要：修复 Verifier 执行期间暂停后仍完成成功的问题。

### 变更

- Verifier 将 AbortSignal 传递到每次 fixture_score Effect，并在 Effect 和结果提交边界检查运行状态
- 验证返回、report 和 finish 前增加 fail-closed 检查，暂停运行保持 PAUSED
- phase_started 事件不再隐式恢复 PAUSED，新增暂停阶段转换回归测试

### 验证

- [x] contract:pause-during-verifier
- [x] phase transitions do not implicitly resume a paused run
- [x] npm run typecheck --workspace=@proofblade/gui
- [x] npm run typecheck --workspace=@proofblade/materials

## UPDATE-20260807-004

时间：2026-08-07T20:17:19+08:00

摘要：修复 GUI 关闭故障路径、Solver 单次中止和模型调用边界竞态。

### 变更

- 服务清理失败时仍关闭 HTTP Server 和 Vite，并统一汇总关闭错误
- Planner 返回、模型返回和验证入口重新检查 AbortSignal
- Chat Lane 直接中止，Solver Lane 统一只通过对应 AbortController 中止
- 恢复未受影响组件审计台账，只对真实受影响组件递增一次

### 验证

- [x] GUI shutdown failure and Solver abort contract tests
- [x] npm run check:components -- --base e2d2164
- [x] npm run check:change-contracts -- --base e2d2164
- [x] npm run verify

## UPDATE-20260807-003

时间：2026-08-07T19:55:00+08:00

摘要：把 PR 审查发现的虚假审计计数和生命周期竞态转为 CI 差异门禁。

### 变更

- 禁止源码未变化时修改 qualityAudit，并限制受影响组件每个 PR 只增加一次审计计数
- 组件文本哈希统一 LF，同时保持二进制内容逐字节哈希
- 增加 GUI Shutdown、Solver Abort、Sandbox Cleanup 和审计脚本的高风险变更契约
- 增加五个 CI 门禁自测并接入 npm run verify 与 GitHub Actions

### 验证

- [x] npm run test:ci-gates
- [x] npm run check:change-contracts
- [x] npm run verify

## UPDATE-20260807-002

时间：2026-08-07T18:37:33+08:00

摘要：增加统一的项目计划、更新日志、完成报告和维护报告。

### 变更

- 增加 project-status.json 单一数据源
- 增加四份确定性生成的中文项目报表
- 维护报告自动读取全部 COMPONENT.md 审计元数据
- 增加报表一致性、引用完整性和变更日志 CI 门禁

### 验证

- [x] npm run reports:project
- [x] npm run check:project-reports
- [x] npm run verify

## UPDATE-20260807-001

时间：2026-08-07T18:09:45+08:00

摘要：增加组件质量审计台账并修复 Fixture 求解立即暂停竞态。

### 变更

- 为 25 个组件增加 BUG、安全审计次数、时间、结果和源码指纹
- 增加审计记录器、重复检查跳过和批量原子写入
- 修复 startSolve 返回前 Run 未持久化的问题
- 修复暂停运行被改写为 EXHAUSTED 和暂停期间重复启动的问题

### 验证

- [x] npm run verify
- [x] 87 tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] npm audit: 0 vulnerabilities
