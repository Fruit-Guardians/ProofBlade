# 项目计划

> 此文件由 `project-status.json` 生成，请勿直接编辑。
> 状态更新时间：2026-08-29T10:24:52+08:00

## 概览

- 计划总数：10
- 进行中：6
- 待开始：1
- 受阻：1
- 已完成：2

## 当前计划

| ID | 优先级 | 里程碑 | 状态 | 进度 | 负责人 | 最近更新 |
| --- | --- | --- | --- | ---: | --- | --- |
| PLAN-100 | P0 | Milestone 4 | 进行中 | 42% | unassigned | 2026-08-10T19:42:54+08:00 |
| PLAN-110 | P0 | Milestone 2 debt | 进行中 | 35% | unassigned | 2026-08-09T15:15:00+08:00 |
| PLAN-120 | P0 | Milestone 4 | 进行中 | 35% | unassigned | 2026-08-12T16:30:00+08:00 |
| PLAN-220 | P0 | Milestone 2 / 5 | 进行中 | 45% | unassigned | 2026-08-20T12:15:00+08:00 |
| PLAN-130 | P0 | Milestone 1 debt | 待开始 | 0% | unassigned | 2026-08-07T18:37:33+08:00 |
| PLAN-200 | P1 | Milestone 6 | 进行中 | 45% | unassigned | 2026-08-25T13:05:00+08:00 |
| PLAN-230 | P1 | Milestone 6 | 进行中 | 35% | unassigned | 2026-08-29T08:44:14+08:00 |
| PLAN-210 | P3 | Milestone 5 | 受阻 | 15% | unassigned | 2026-08-24T22:00:00+08:00 |

## PLAN-100 二进制 Artifact 与 Reverse 能力包

目标：让 Solver 能对真实 ELF/PE 等二进制执行可审计、可复现的静态分析。

依赖：无

### 交付物

- 稳定逻辑 Capability 与可替换 Backend/Resolver 契约
- 二进制流与范围读取 Artifact API
- 格式、架构、区段、符号、字符串、反汇编和 XRef Capability
- Capability 输出到 Artifact、Evidence 和推理森林的确定性映射
- 至少三道真实二进制变体 Fixture

### 验收条件

- [ ] 核心 Tool Schema 保持稳定
- [ ] 所有完整原始输出均有内容哈希和可读取 Artifact
- [ ] 重置环境后分析结论可以独立复现

## PLAN-110 结构化 Phase Gate 与运行护栏

目标：阻止 Agent 在阶段产物不足、重复探索或缺少证据时提前得出确定结论。

依赖：无

### 交付物

- Model Target、Plan 和 Reproduce 阶段
- 每阶段结构化进入与退出门
- repeat breaker、no-progress、failure signature 和 phase deadline
- Intent 去重、环境漂移和无证据 claim 降级

### 验收条件

- [ ] 模型文本不能绕过阶段门
- [ ] 重复 Tool/参数/结果达到阈值后被机械短路
- [ ] 验证失败会携带原因返回可证伪假设阶段

## PLAN-120 统一预算与 Provider 调度器

目标：统一控制 Provider 并发、429 重试、Token、费用、阶段时间和提交次数。

依赖：无

### 交付物

- Provider/模型级并发槽和等待队列
- 带抖动的 Retry-After 退避与累计重试预算
- 请求前 Token、成本、Tool、阶段和提交预算检查
- GUI 与 telemetry 的等待、限流和预算状态

### 验收条件

- [ ] 同一 Provider 不超过配置的 pending 请求数
- [ ] 预算耗尽产生明确终态和失败分类
- [ ] 429 重试不会形成并发重试风暴

## PLAN-220 可重放 Work Graph 与 CTF 编排纵向切片

目标：把 Planner、Coding/Web/Pwn 执行和验证之间的工作边界落到现有 Control Store，使并行解题可认领、可阻塞、可重规划、可恢复且不重复跑偏。

依赖：PLAN-110, PLAN-120

### 交付物

- WorkItem 状态机、依赖校验和可重放租约事件
- Planner Handoff 携带 WorkItem，并将工作图纳入知识版本哈希
- Competition/Coding Loop 的 claim、replan block、complete/fail 生命周期
- RequestEpoch、领域阶段和 Web/Pwn 结构化工具的后续接入契约

### 验收条件

- [ ] 同一 Run 的 WorkItem 事件重放后 projection hash 稳定
- [ ] 活动租约阻止重复 claim，过期租约可被恢复流程重新认领
- [ ] 工作图变化会使旧 Handoff 失效并生成新的结构化动作
- [ ] Competition Loop 在成功、阻塞、Provider 失败和耗尽路径都留下明确 WorkItem 终态

## PLAN-130 真实 Sandbox 与清理生命周期

目标：隔离 Tool Runner、目标 Fixture、Verifier 与 Host，并保证 Run 收尾无孤儿资源。

依赖：无

### 交付物

- 容器或 Windows Job Object Sandbox adapter
- 工作区、网络、CPU、内存、进程和输出硬限制
- 进程组终止、Fixture destroy 和后台 janitor
- Solver 与 Verifier 的独立可写目录

### 验收条件

- [ ] 目标进程无法读取 Host 配置和 Provider Key
- [ ] 超时会终止完整进程组
- [ ] Run 结束后不存在非保留 Job、Lease、进程或容器

## PLAN-200 Protocol Replay、Tool Replay 与 Shadow 评测

目标：把真实 Provider 和 Tool 轨迹转为可比较、可旁路验证的回归数据。

依赖：PLAN-100, PLAN-110, PLAN-120, PLAN-130

### 交付物

- Protocol Replay
- Tool Replay
- Shadow 路由和上下文策略
- 20 道以上变体与 holdout Fixture

### 验收条件

- [ ] 同一录制轨迹重放产生相同 projection hash
- [ ] Shadow 计算不影响主 Run
- [ ] 策略比较报告包含成功率、成本、缓存和错误提交率

## PLAN-230 统一事件驱动、上下文维护与 Agent 持续演化建议

目标：基于第 6、7、9、10 章，把普通 Chat、CTF、Fixture 和 Competition 的长运行事件、工具监控、上下文压缩、证据整理、评估、多 Agent 协作和持续演化收敛到同一个可恢复系统。

依赖：PLAN-110, PLAN-120, PLAN-200, PLAN-220

### 交付物

- 统一 RunEventEnvelope、事件优先级、安全点消费和 generation fencing
- Provider/Tool/Job 的进度、卡住、重试、unknown 和 reconcile 可见事件
- 可重建 RequestEpoch、实际请求 hash、模型视图来源和敏感字段脱敏
- 统一 Definition/Provider/Consumer、Disposable Scope、Provider binding identity 和依赖变化生命周期
- canonical Tool value、model presentation、Artifact/Spill 三态输出和孤儿操作恢复
- ContextBlock、L3A/L3B、K0-K2、动态尾部和用户可控的单一压缩策略
- Evidence consolidate 的幂等 WorkItem、L0/L1/L2 投影和原始 Artifact 保留
- 带触发集、保留集、迁移集、激活率、遵循率和回滚的持续更新评测

### 验收条件

- [ ] 可恢复的上下文压力、Provider/Tool 暂停、重复失败和证据缺口不会静默强停 Run
- [ ] 所有事件从 ControlStore 重放后产生稳定 projection hash，内存队列不成为第二份状态真相
- [ ] 每个实际 Provider 请求都有可重建 RequestEpoch，恢复请求与原请求规范 JSON 一致且不包含密钥
- [ ] 动态注册具有幂等 dispose，Consumer teardown 完成前旧 Provider binding 保持可读，依赖变化产生可重放生命周期事件
- [ ] 动态尾部内部排序只影响本地投影和压缩优先级，不被报告为 Provider KV Cache 命中提升
- [ ] 普通 Chat、CTF、Fixture 和 Competition 共享同一事件、Tool、Evidence、Completion 和恢复契约
- [ ] Tool 的 canonical/presentation/durable 三态可追溯，Spill 或维护失败不伪造完整结果和可信 Evidence
- [ ] 原始 Tool/Provider 输出始终可通过 Artifact 或 Session 有界读取，整理失败不会产生半提交
- [ ] Compaction、Curation、Effect、Sandbox、MCP reconnect 和 Subagent 孤儿操作可被扫描并进入恢复路径
- [ ] 更新提案改善触发失败集且保留集不退化，发布失败可以按版本 hash 回滚
- [ ] 评估任务具备 Dataset、Environment State、Tools、Rubric 和 Interaction Protocol 五元组，并同时报告 Pass@k、Pass^k、FAIL_TO_PASS、PASS_TO_PASS 和 flaky 检查
- [ ] 生产失败可以定位首错并生成端到端与 trajectory-prefix 回归，Trace/Span、Artifact 和 Evidence 引用可重建归因
- [ ] 多 Agent 只作为同一 Work Graph 的策略层，winner 结算、优雅取消 ACK、级联回收、预算和 handoff cycle detection 不产生第二套状态真相

## PLAN-210 单 coding lane 上的 Planner/Refiner 策略层

目标：在单一 coding lane 的结构化 Handoff 边界上完善确定性 Planner/Refiner，并用评测证明是否值得增加可选 Planner 模型调用；不创建第二条解题 lane。

依赖：PLAN-100, PLAN-110, PLAN-120, PLAN-130, PLAN-200

### 交付物

- Planner/Refiner 的结构化 Handoff 与 knowledgeVersion 校验
- add/remove/modify/reorder + afterId 的增量重规划
- 重复 Intent 和并行浪费指标

### 验收条件

- [ ] 至少 20 道题每题三次与单 Agent 配对比较
- [ ] 成功率、成本或 p95 延迟至少一项稳定改善
- [ ] 其他指标不突破预算
- [ ] Planner/Refiner 只作为策略层，不新增第二条解题 lane 或独立 solver transcript

## 已完成计划

| ID | 计划 | 完成度 | 最近更新 |
| --- | --- | ---: | --- |
| PLAN-001 | 组件质量审计台账 | 100% | 2026-08-07T19:55:00+08:00 |
| PLAN-002 | 项目计划与维护报表 | 100% | 2026-08-07T18:37:33+08:00 |
