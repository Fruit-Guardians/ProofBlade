# ProofBlade 交接路线落地记录

本文记录 `DEVELOPMENT_ROADMAP_ZH.md` 第 0-4、6 节的代码落地。原文第 5 节工作流约定未沿用。

## P1 收尾

- Competition Pwn E2E：增加等价本地端到端测试，覆盖 pwn profile 容器创建、`executionEnv` 传递、持久 tube、shell barrier、flag 读取、平台提交、session 事件和容器销毁。
- `inspect_elf`：`proofblade.binary` 新增聚合能力，一次返回 ELF identity、checksec 信号、sections 和 symbols。
- `gdb_batch`：新增有界非交互 GDB 能力，禁止 shell/source/python 等逃逸命令，限制命令数、长度与超时。
- `LeakRecord`：泄漏和 base 公式可写入 evidence graph，并可被 search、handoff 和 replan 引用。
- 方向预检：平台折叠为 `misc` 的题目会结合 target/objective 重新识别 `forensics`、`malware`、`osint` 等专用 profile，避免误用通用工具集。

## P0 收敛

- `domainPhase`：快照持久化 `INTAKE -> RECON -> TARGET_MODEL -> HYPOTHESIS -> EXPERIMENT -> REPRODUCE -> REPORT -> SUBMIT`，competition loop 每轮推进并写事件。
- `ExperimentRecord`：记录 generation、hypothesis、repeatKey、输入哈希、动作、结果；展示字段不参与 repeatKey；第三次相同失败动作机械拒绝。
- 前台交互护栏：`bash` 启动前检测 pwntools recv/interactive、nc/ncat/socat 等模式，直接引导到 pwn tube 或 background job。
- 遥测：增加 domainPhase、实验数、失败实验数、重复失败动作、前台 bash 超时和 first candidate 指标。
- 评测：RealModelEvaluation 增加 first evidence、重复实验、提交次数、上下文 token 指标，并提供匿名历史 Run replay 投影。

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

现有 per-run 容器、target-only egress、stale reaper、`pwn-kernel` profile、session orphan supersede、lane dispose 和 `CompetitionEnvironmentJanitor` 继续作为无人值守 Fleet 基础；janitor 对环境容量、`expiresAt` sweep、重启恢复和清理失败重试提供持久账本，本轮新增测试覆盖容器和持久会话在 competition 路径的组合。

## 测试矩阵

- `binary-core.test.ts`：ELF 聚合检查、GDB batch 输入边界。
- `competition-pwn-e2e.test.ts`：等价 Pwn competition 全链路。
- `competition-convergence.test.ts`：domainPhase 回放、ExperimentRecord、第三次重复拒绝、UI 字段剔除。
- `web-session.test.ts`：Cookie/CSRF、跨 Run 隔离、干净复现、Browser storageState。
- `handoff.test.ts`：Refiner delta、旧 Handoff supersede、禁止重复动作。
- `coding-resources.test.ts`：交互 bash 启动前护栏。
- `pwn-layer.test.ts`：LeakRecord、base 公式、证据图搜索和冲突保护。
- `environment-janitor.test.ts`：环境账本重启恢复、容量 reservation、过期回收和失败重试。

## 验证结果

- `npm run build`：通过（TypeScript 增量构建和 GUI Vite 构建）。
- `npm run check:components`：通过。
- `npm run check:change-contracts`：通过。
- `npm run check:project-reports`：通过。
- `npm run test:ci-gates`：10/10 通过。
- roadmap 相关定向回归：42/42 通过。
- `npm test`：561/561 通过；本次完整运行未出现既有 `coding-resources` 时序或目录锁定失败。

## 最新审计（2026-08-27）

- `npm run api:index:test` 与 `npm run api:index:check`：atoms、molecules、materials 全部通过，生成物跨工作区路径可重复。
- `npm run typecheck`：atoms、molecules、materials、CLI、GUI 全部通过。
- `npm run check:components`：26 个组件、8 个受影响组件通过。
- `npm run check:change-contracts`：8 个契约、65 个变更文件通过。
- `npm run check:project-reports`：4 份项目报告完整。
- 本地 27 案例多方向 holdout 通过（Web 12、Pwn 12、Reverse/Crypto/Forensics 各 1），且无 Provider 请求；这验证的是 Run/Verifier/replay 管道，不代表真实模型解题率。
- 严格 `eval-real` 已增加至少 20 个 corpus case、每个 Variant 必须产生 Provider telemetry 的门禁；provider-free holdout 明确关闭这两个条件。
- 真实 Provider 评测仍待配置可用的 Provider 和两组显式 token pricing；本机 `127.0.0.1:1234` 当前不可用。
- Windows 同路径并发原子替换的 `EPERM` 已在 `packages/atoms/src/storage/atomic.ts` 内按目标路径串行化，并补充 64 路并发回归；完整 `npm run test:staged` 已通过 fast 648/648、slow 20/20、integration 70/70，共 738/738。

## P0/P1/P2 执行记录（2026-08-22）

### P0

- 新增 `.github/test-matrix.json` 与 `scripts/check-changed-tests.mjs`，源码变更若没有对应测试映射会直接失败；本轮 gate 输出 11 个 targeted commands。
- `CompetitionEnvironmentJanitor` 使用 schema v2、原子写入和跨进程 lock；reservation 在 `startEnvironment` 前落盘，旧 schema 可迁移，过期 reservation/ACTIVE 记录可在重启后 sweep。

### P1

- `ApprovalPolicy` 将平台提交、环境启动、网络请求和 session 打开列为受保护副作用；资源明文不落盘，未批准路径不会触碰平台。
- `ProofBladeAppServer` 只暴露 `run/read`、`run/events`、`run/approvals`、`run/approve` 和订阅；GUI 通过 `/api/v2` 接入。

### P2

- `fixtures/holdout/manifest.json` 绑定 12 个 Web 和 12 个 Pwn 本地 transcript 的 SHA-256；`LocalHoldoutEvaluationRunner` 复用生产 evaluator 的证据、重放、成本和 baseline 对照协议，确定性 lane 不创建 Provider 请求。
- local holdout 测试验证 27/27 case、2 个 variant 成功率 1、Provider 请求 0、报告不含期望答案。

本轮验收只使用本地 fixture/fake API；真实 DASCTF、远程 tube、远程 pwn E2E 明确不在范围内。

## PR #69 复审修复

- ExperimentGate 已通过 `dispatchTransaction` 原子接入 coding lane 的 Bash、capability、Pwn tube、HTTP/Browser session 入口；并发失败实验最多只允许两次持久记录。
- WebReproducer 不再接受调用方 `flagPattern`，只读取 `TaskContract.verification.web.flag_pattern`；拒绝 `.*`、`^.*$` 等无约束模式，并注册 `web_reproduce` active tool（仅 immutable web policy 存在时启用）。
- 新增并发 Gate、wildcard policy、Web tool 路径回归测试。
- 复审回归：`npm run build`、定向 13/13、competition/capability 23/23、`check:change-contracts` 均通过。

## 当前交付审计（2026-08-27）

- 统一 Run/Verifier/Control Store 路径继续保持单一 coding lane；Browser verifier 的可选 Playwright runtime、Pwn 四类阶段契约矩阵和 GUI control-view 已接入，缺 runtime 时保持 fail-closed。
- 平台接入增加只读 `npm run platform:selfcheck`：只检查 DASCTF 题目列表与详情/附件，不创建环境、不恢复环境、不提交 flag；缺少 AccessKey 返回非零状态，URL userinfo 被拒绝并且输出脱敏。
- 当前验证基线：session wire/service 定向、`npm run test:integration` 79/79、DASCTF adapter targeted 33/33、offline eval 30/30、API index check、组件/变更契约/changed-tests/CI-gates 全部通过；Windows projection 原子 rename `EPERM` 已通过按目标路径串行化 `atomicWriteFile`、短暂错误有界退避和 64 路并发回归修复，最新已记录的 staged 三阶段分别执行为 fast 663/663、slow 22/22、integration 79/79（764/764）；本轮 `EXTERNAL_CONFIRMED` 协调器状态的定向恢复组合为 44/44、绑定事务为 12/12。P0 新增多命令批次原子替换、`reconcileProjection()` 恢复测试和跨进程 Run 锁/双进程序号回归，P1 新增 PROPOSED Effect 安全重试、结果 Artifact 无外部重跑接管、Pwn 终态 stage summary 重建、STARTED/UNKNOWN 显式 reconcile 拒绝、终态 Verifier 重试、可信结果批次幂等、稳定 `VerificationRequest` 重启回归、verifier-owned Effect 恢复诊断和 `RECOVERY_REQUIRED` 持久化标记，以及有界 Context `control_view` 恢复/WorkItem 约束摘要；本轮又完成 Claim final `VerifierOutcomeEnvelope` 和外部资源 registry 第一垂直切片，收紧 Browser broker 响应字段白名单，接入可复用的 Node HTTP transport handler，冻结 Browser action/context proxy 的有界动作协议及 resolver-owned action service，并增加幂等 Browser create/open wire、client factory、持久化 Durable Browser Runtime Service、health/capability probe、heartbeat wire 和可注入 Playwright host 模块；HTTP session 新增 broker 句柄回滚与 Control Store 绑定失败恢复回归；新增 Pwn/HTTP `DurableSessionRuntimeService`、create/open/health wire、跨重启 STARTING 对账和动作 kind 门禁；Coding lane 已增加并发 broker health/capability preflight，配置失败时按 kind fail-closed，不再静默回退本地实现。
- 2026-08-27 continuation：Pwn supervisor 适配器契约新增并发 create、STARTING 对账不盲建、release 失败重试三条故障回归（7/7），并落地 detached-worker 过程级重启接管与 HTTP 服务边界回归（4/4、3/3）；API index 重新生成并通过；随后修复了 host 对账期间已被并发 release 的 STARTING reservation 被旧查询结果复活的竞态，并增加跨窗口回归测试；补上 `SingleAgentLoop` 到默认 lane 的 session broker/required handoff，避免入口丢失已配置的 Pwn/HTTP runtime；本轮又加入 detached worker 重放拒绝、release 失败/恢复重试和 token 私有文件传递回归；最新 `npm run verify` 的 staged fast/slow/integration 为 678/678、22/22、80/80（780/780）。该矩阵仍是注入式 supervisor 证据，不等同于真实 DASCTF tube 或 Docker supervisor 的跨环境证明。
- 未纳入自动化的边界保持不变：真实 Provider 评测需要私有 corpus 和显式 `--allow-live`；真实 DASCTF 运行、远程 tube 和 Docker Pwn smoke 只作为用户授权后的独立运维/发布动作。
