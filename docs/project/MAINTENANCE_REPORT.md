# 维护报告

> 此文件由 `project-status.json` 生成，请勿直接编辑。
> 状态更新时间：2026-08-10T19:42:54+08:00

## 组件维护状态

- 已登记组件：25
- 当前审计通过：25
- 存在未解决发现：0

| 组件 | 版本 | BUG 检查次数 | 安全检查次数 | 最近检查 | 结果 | 源码指纹 |
| --- | --- | ---: | ---: | --- | --- | --- |
| atoms | 0.1.1 | 1 | 1 | 2026-08-07T17:39:20+08:00 | 通过 | `0e9076d0f255` |
| cli | 0.2.2 | 2 | 2 | 2026-08-11T14:56:16.000Z | 通过 | `cfaf3b4c8fa1` |
| gui | 0.7.10 | 10 | 10 | 2026-08-11T02:30:00.000Z | 通过 | `39a1c965bd67` |
| materials | 0.12.19 | 15 | 15 | 2026-08-11T10:58:11.000Z | 通过 | `0ef544b0b2f7` |
| materials-app | 0.1.1 | 1 | 1 | 2026-08-07T17:39:20+08:00 | 通过 | `4dadfbc60856` |
| materials-capabilities | 0.2.6 | 4 | 4 | 2026-08-10T09:59:52.000Z | 通过 | `6761fe8ffa10` |
| materials-cli | 0.1.1 | 1 | 1 | 2026-08-07T17:39:20+08:00 | 通过 | `e3b0c44298fc` |
| materials-context | 0.4.4 | 3 | 3 | 2026-08-09T04:00:00.000Z | 通过 | `169c106d3946` |
| materials-control | 0.3.4 | 4 | 4 | 2026-08-09T16:31:33.000Z | 通过 | `867c38c5f8b1` |
| materials-domain | 0.3.5 | 4 | 4 | 2026-08-11T11:32:51.204Z | 通过 | `4f34482a1496` |
| materials-effects | 0.2.2 | 1 | 1 | 2026-08-07T17:39:20+08:00 | 通过 | `d39c55335693` |
| materials-evaluation | 0.2.6 | 4 | 4 | 2026-08-11T14:56:16.000Z | 通过 | `a9827e9db3ca` |
| materials-jobs | 0.2.3 | 2 | 2 | 2026-08-09T15:32:20.000Z | 通过 | `47b16225d5c8` |
| materials-knowledge | 0.6.4 | 4 | 4 | 2026-08-10T05:35:35.169Z | 通过 | `43da254dff53` |
| materials-mcp | 0.2.6 | 4 | 4 | 2026-08-11T10:58:11.000Z | 通过 | `483131e03b81` |
| materials-observability | 0.1.1 | 1 | 1 | 2026-08-07T17:39:20+08:00 | 通过 | `ea7d0b8a8bc0` |
| materials-orchestration | 0.1.6 | 6 | 6 | 2026-08-11T11:32:51.204Z | 通过 | `34814af5ad77` |
| materials-recovery | 0.1.1 | 1 | 1 | 2026-08-07T17:39:20+08:00 | 通过 | `ee7b9cfae03f` |
| materials-runtime | 0.10.12 | 10 | 10 | 2026-08-11T14:56:16.000Z | 通过 | `fd4ffc42958e` |
| materials-sandbox | 0.1.2 | 2 | 2 | 2026-08-07T20:17:19.5056968+08:00 | 通过 | `115ef660ac09` |
| materials-skills | 0.1.1 | 1 | 1 | 2026-08-07T17:39:20+08:00 | 通过 | `27123936e75c` |
| materials-storage | 0.1.1 | 1 | 1 | 2026-08-07T17:39:20+08:00 | 通过 | `71901f72eb87` |
| materials-tools | 0.2.4 | 4 | 4 | 2026-08-10T09:59:52.000Z | 通过 | `8ff11c5b8526` |
| materials-verification | 0.4.2 | 2 | 2 | 2026-08-07T22:20:18.1243188+08:00 | 通过 | `2f9990a5bf7d` |
| molecules | 0.2.1 | 1 | 1 | 2026-08-07T17:39:20+08:00 | 通过 | `a4df8d8f8228` |

## 维护记录

### MAINT-20260810-001

时间：2026-08-10T11:17:00+08:00

状态：通过

范围：确定性评测协议、缓存与上下文可观测性、收敛护栏、Evidence 整理和运行状态持久化

执行内容：

- 拆分 Fixture 求解矩阵与 Runtime Scenario 矩阵
- 把仅存在于单元测试的关键跨模块不变量提升为发布评测
- 执行 104 个 Materials 测试和 30 项 baseline-v3 评测

发现与处置：

- 旧 18 项评测只能证明六类静态题型可被确定性求解，不能发现缓存、上下文和运行时状态回归
- 缓存命中 Token 与 Provider 前缀稳定性需要独立评测，固定值不能代表真实前缀命中
- 跨模块场景应隔离失败并保留分类、目录哈希和稳定结果哈希

验证：

- [x] 104/104 Materials tests passed
- [x] 153/153 repository tests passed
- [x] 18/18 fixture solve cases passed
- [x] 12/12 runtime scenario cases passed
- [x] npm audit: 0 vulnerabilities

下次检查触发条件：新增跨题运行时能力、改变缓存前缀、上下文裁剪、证据整理、暂停恢复、Verifier 或 Lease 契约

### MAINT-20260807-002

时间：2026-08-07T19:55:00+08:00

状态：通过

范围：组件审计差异、GUI 关闭、Solver 中止、Sandbox 清理和 CI 工作流

执行内容：

- 复盘 PR #20 的关闭错误路径、中止竞态、重复 Abort 和虚假组件审计计数
- 增加组件审计转换不变量和跨平台文本哈希
- 增加高风险源码触发器与必需故障场景测试契约
- 执行门禁负向 Fixture、完整构建、测试、评测和依赖审计

发现与处置：

- 已加门禁：源码未变化时 qualityAudit 不得变化
- 已加门禁：受影响组件的 BUG 与安全审计次数必须各增加一次
- 已加门禁：关闭、中止和 Sandbox 生命周期改动缺少故障场景测试时阻止合并

验证：

- [x] 5/5 CI gate tests passed
- [x] Component documentation check passed
- [x] Full repository verification passed

下次检查触发条件：修改 change-contracts、组件哈希算法、关闭协调器、AbortSignal 边界或 SandboxPort 生命周期

### MAINT-20260807-001

时间：2026-08-07T18:09:45+08:00

状态：通过

范围：完整仓库、25 个组件、依赖、构建、测试和确定性评测

执行内容：

- 执行 npm ci 和 npm run verify
- 检查依赖漏斗、组件文档和源码审计指纹
- 执行 87 个测试和 18 次 Fixture 评测
- 修复 Fixture 求解立即暂停竞态和资源清理边界

发现与处置：

- 已修复：startSolve 返回时 durable Run 尚未创建
- 已修复：Auto Loop 会把 PAUSED 改写为 EXHAUSTED
- 已修复：批量组件审计失败可能产生部分更新

验证：

- [x] 87/87 tests passed
- [x] 18/18 fixture evaluations passed
- [x] 0 dependency vulnerabilities

下次检查触发条件：任一组件 sourceHash、依赖锁文件、运行时版本或评测协议发生变化
