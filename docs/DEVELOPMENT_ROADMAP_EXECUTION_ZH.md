# ProofBlade 交接路线落地记录

本文记录 `DEVELOPMENT_ROADMAP_ZH.md` 第 0-4、6 节的代码落地。原文第 5 节工作流约定未沿用。

## P1 收尾

- Competition Pwn E2E：增加等价本地端到端测试，覆盖 pwn profile 容器创建、`executionEnv` 传递、持久 tube、shell barrier、flag 读取、平台提交、session 事件和容器销毁。
- `inspect_elf`：`proofblade.binary` 新增聚合能力，一次返回 ELF identity、checksec 信号、sections 和 symbols。
- `gdb_batch`：新增有界非交互 GDB 能力，禁止 shell/source/python 等逃逸命令，限制命令数、长度与超时。
- `LeakRecord`：泄漏和 base 公式可写入 evidence graph，并可被 search、handoff 和 replan 引用。

## P0 收敛

- `domainPhase`：快照持久化 `INTAKE -> RECON -> TARGET_MODEL -> HYPOTHESIS -> EXPERIMENT -> REPRODUCE -> SUBMIT`，competition loop 每轮推进并写事件。
- `ExperimentRecord`：记录 generation、hypothesis、repeatKey、输入哈希、动作、结果；展示字段不参与 repeatKey；第三次相同失败动作机械拒绝。
- 前台交互护栏：`bash` 启动前检测 pwntools recv/interactive、nc/ncat/socat 等模式，直接引导到 pwn tube 或 background job。
- 遥测：增加 domainPhase、实验数、失败实验数、重复失败动作、前台 bash 超时和 first candidate 指标。

## P2 Web

- `HttpSessionBackend`：per-run Cookie jar、CSRF 复用、同源限制、响应 Artifact、state hash 和 session 事件。
- `BrowserContextBackend`：Playwright-compatible 持久上下文端口，记录 storageState hash 和响应 Artifact。
- `WebReproducer`：干净 HTTP session 重放步骤，flag 只从本轮最终响应提取；状态码、响应模式和正则均有边界。

## P3 Planner / Refiner

- Planner Handoff 纳入 `domainPhase` 与 Experiment knowledgeVersion。
- Refiner 以 `add/remove/modify/reorder + afterId` 增量修改 action，旧 Handoff 自动 supersede。
- Executor 仍通过 ControlStore 的 knowledgeVersion 校验接受 Handoff；失败动作写入 `prohibitedRepeats`。
- 独立验证失败后，SingleAgent loop 调用 Refiner 生成替代动作，而不是全量重写计划。

## P4 基础

现有 per-run 容器、target-only egress、stale reaper、`pwn-kernel` profile、session orphan supersede 和 lane dispose 继续作为无人值守 Fleet 基础；本轮新增测试覆盖容器和持久会话在 competition 路径的组合。

## 测试矩阵

- `binary-core.test.ts`：ELF 聚合检查、GDB batch 输入边界。
- `competition-pwn-e2e.test.ts`：等价 Pwn competition 全链路。
- `competition-convergence.test.ts`：domainPhase 回放、ExperimentRecord、第三次重复拒绝、UI 字段剔除。
- `web-session.test.ts`：Cookie/CSRF、跨 Run 隔离、干净复现、Browser storageState。
- `handoff.test.ts`：Refiner delta、旧 Handoff supersede、禁止重复动作。
- `coding-resources.test.ts`：交互 bash 启动前护栏。
- `pwn-layer.test.ts`：LeakRecord、base 公式、证据图搜索和冲突保护。

## 验证结果

- `npm run build`：通过（TypeScript 增量构建和 GUI Vite 构建）。
- `npm run check:components`：通过。
- `npm run check:change-contracts`：通过。
- `npm run check:project-reports`：通过。
- `npm run test:ci-gates`：8/8 通过。
- roadmap 相关定向回归：42/42 通过。
- `npm test`：业务测试通过；Windows 上已有的 `coding-resources` 两个时序/目录锁定用例仍存在环境抖动（`shell_background` 进程在轮询前结束、临时目录 `EBUSY`），隔离重跑可分别观察到同类现象，未涉及本轮新增代码路径。
