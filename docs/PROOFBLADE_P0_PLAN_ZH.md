# ProofBlade P0 开发计划

## 目标

把 ProofBlade 从“能驱动 Pi 完成一次工具循环”收敛成“一个有预算、可中止、可重放、能正确提交终态的 competition run actor”。Pi 负责模型适配、会话和工具循环；ProofBlade 负责 CTF 阶段、工具路由、证据、验证和平台终态。

## 分阶段路线

### P0.1 运行边界（当前切片）

- 单个 `prompt()` 继承 challenge deadline；到期由外层 timer 调用 `lane.abort()`，不能等当前 inner loop 自然结束。
- 在 Pi `tool_call`/`tool_result` hooks 上执行 `max_tool_calls`，达到上限后阻断并终止本轮。
- 终止原因进入事件与 `CompetitionLoopOutcome`，可区分 deadline、tool budget、provider error。

验收：fake lane 在一个永不返回的 prompt 中会被 deadline abort；工具调用达到预算后不会再执行下一次工具；现有 provider/turn guard 测试保持通过。

### P0.2 工具面与阶段路由

- 基础工具常驻：`read`、`bash`、`edit`、`write`、`evidence`、`load_skill`、`mcp_call`、后台作业和提交入口。
- first-class MCP 工具按 `target_kind` 和工具链选择，默认不把全部 IDA/JADX schema 注入上下文；延迟能力仍通过 `mcp_call`/`capability` 可用。
- 在 run event 中记录工具目录 hash 和 active tool names，便于评测上下文成本。

验收：reverse 只激活白名单反汇编工具；web/pwn/crypto 不再默认暴露两套 decompiler 全量工具；工具目录 hash 可复现。

### P0.3 终态与阶段一致性

- `domainPhase` 是 competition 的阶段事实，`phase` 仅作兼容投影；每个外层 turn 显式推进并持久化。
- 平台 accepted 后，在一个 `dispatchBatch` 中完成 `SUBMIT`、work item completed 和 verifier `finish`，避免“已接受但 run 仍 READY/intake”。
- 成功终态只允许 verifier lane 提交，并要求 accepted completion 覆盖全部 reproduction evidence。

验收：accepted run 的 projection status 为 `SUCCEEDED`、`domainPhase=SUBMIT`、work item 为 `DONE`，重放事件后结果不变。

### P0.4 自动观察与上下文维护

- bash/read/MCP 输出继续进入 ArtifactStore；由 harness 自动生成有限长度的 observation 摘要和 progress key。
- 只把新信息注入模型上下文；重复输出使用 artifact/evidence id 引用，超过预算时先压缩 ledger，再触发 Pi compact。
- curation gate 从“硬停探索”转为“自动标注 routine/debug + 要求模型记录关键发现”。

验收：连续 20 次重复读取不会线性膨胀上下文；每个长输出都有 artifact anchor；关键 accepted 路径有 reproduction evidence。

## P1/P2/P3

- P1：平台链接契约与运行期可观测性（不执行真实 DASCTF 登录、远程 tube 或 pwn 端到端）；`inspect_elf`/`gdb_batch`、LeakRecord 接入 evidence graph。
- P2：HTTP session/browser session 和 clean replay verifier（当前已完成离线契约闭环）。
- P3：Planner/Refiner 双 lane，仅在 20+ holdout 评测中成功率、成本或 p95 有稳定收益时合入。

## 统一评测指标

`solve_rate`、`verified_rate`、`first_evidence_ms`、`first_candidate_ms`、`tool_calls`、`model_requests`、`context_tokens`、`repeat_block_count`、`wrong_submission_count`、`deadline_abort_count`、`foreground_bash_timeout_count`。

## 当前切片状态（2026-08-21）

已实现并通过定向回归：P0.1、P0.2、P0.3，以及 P0.4 的 routine artifact 自动标注、统一 Observer、稳定 progress key、重复输出引用压缩、MCP journal/artifact 路由、coding-lane context checkpoint 和 RunTelemetry 自动观察指标；`npm run typecheck` 通过。完整 materials 测试在 Windows 并行启动时出现过两个 `spawn UNKNOWN`，将 `competition-control-plane.test.ts` 和 `provider-retry-harness.test.ts` 串行重跑后均通过。

平台链接能力已落地：`CompetitionApi` 五个操作、DASCTF 专用适配器、`X-Agent-AccessKey` 鉴权、附件下载、环境轮询、错旗 allowlist、限流/重试与 GUI 配置装配均由 fake HTTP/contract tests 覆盖；本项目不执行真实 DASCTF 登录、远程 tube 或 pwn 端到端验证。

Fleet → Run Actor → Observer → Verifier 的组合回放测试已完成：离线 fake API run 能重放出自动 Observation、Evidence、SUBMIT 阶段、work item 成功和 SUCCEEDED 终态，终态三事件由一次原子提交写入。Web session / clean replay 也已完成离线契约切片；下一切片转入运行期回放/恢复审计与评测，在此之前不引入 Planner/Refiner 双 lane。

Web P2 离线闭环也已完成：HTTP session 在同一 Run 内复用 Cookie/CSRF，按 host/port scope 拒绝越界；coding lane 的 `web_session_open/request/close` 保持探索状态 lane-owned，并在关闭时回收；每次请求生成脱敏的结构化 exchange Artifact 并自动生成 Observation/Evidence；clean replay 强制新建当前 generation 的 verifier session，拒绝复用旧 session 或把 flag 字面量放进请求；Browser context 同样记录 storage-state hash、响应 Artifact 和自动 Observation。下一切片转入运行期回放/恢复审计与评测，不连接真实 DASCTF。

## P0/P1/P2 本轮执行（2026-08-22）

- P0 已补齐变更—测试矩阵门禁和 Janitor v2 原子恢复；覆盖 schema 迁移、跨进程容量 reservation、崩溃后 reservation 过期和重启 sweep。
- P1 已补齐审批策略与 App Server 边界；`platform.submit`、`environment.start`、`network.request`、`session.open` 默认 fail-closed，审批记录只保存资源摘要哈希；`run/events` 支持游标分页与订阅恢复。
- P2 已补齐本地 Web/Pwn holdout：4 个 hash-bound fixture、2 个本地对照 variant、确定性 lane、零 Provider 请求指标和报告脱敏断言。

本轮不执行真实 DASCTF 登录、真实平台提交、远程 tube 或 pwn 端到端；平台接入能力继续由 fake HTTP/contract tests 验证。
