# ProofBlade CTF Agent 架构规划（Web / Pwn 优先）

> 本文基于 ProofBlade 当前源码、最近比赛 Run 以及 PentAGI 的编排模式整理。
> 目标不是把 ProofBlade 改造成 PentAGI 的副本，而是保留 ProofBlade 已经具备的可审计控制平面，补齐 Web/Pwn 解题最缺的交互执行层和验证闭环。

## 结论先行

ProofBlade 现在最有价值的部分已经不是“再增加一个 Agent 角色”，而是：

- `Control Store + JSONL 事件 + Projection` 提供了比 PentAGI 更适合比赛提交的持久状态；
- `Effect Journal + Artifact/Evidence + Generation/Lease` 让工具结果可追溯、可恢复、可去重；
- Docker 运行时已经有按 Run 隔离的工作区、非 root 用户、资源上限和 target-only 出口网关；
- `CompetitionChallengeSolver` 已完成平台取题、附件解包、启动环境、提交和清理的主流程。

下面的 Web/Pwn 诊断是本计划早期基线，保留用于解释为什么需要这轮改造；截至 2026-08-25，原先的缺口已经由共享 `RunCoordinator`、`RunWorkScheduler` 和 verifier-first 收尾路径补齐。Competition、GUI、Fixture/Evaluation 现在都通过同一个 `RunCoordinator` 投影 `INTAKE → RECON → TARGET_MODEL → HYPOTHESIS → EXPERIMENT → REPRODUCE → REPORT → SUBMIT`，而不是维护独立的比赛 Solver lane。平台提交、动态 flag 和本地复现都必须产生 verifier-owned Effect/Evidence，终态还绑定 WorkItem 并可从 replay 重建。

最近 Run 可以直接验证这个问题：

| Run | 类别 | 观察 |
| --- | --- | --- |
| `CH-10662-1787139122214` | Pwn | 622 条事件、79 次 `bash` 调用，末尾仍没有 `effect_finished` 或提交事件；大量时间花在重复探测和脚本试错上。 |
| `CH-10680-1787124602204` | Web | 先后执行了 36 个工具调用，能收集 HTTP 证据并提出候选，但流程仍停在 `intake`，缺少 Web 专用的请求/浏览器状态模型。 |
| `CH-10664-1787103841107` | Web | 能走到 `verify_claim` 和 `submit_flag`，说明提交链路可用；但验证和提交仍由通用 Coding Lane 的模型行为触发，而不是由结构化阶段门保证。 |

因此建议的目标形态是：

```text
平台 API / 题目附件 / 连接信息
              |
       Competition Orchestrator
              |
  +-----------+-----------+
  |                       |
 Planner / Refiner    Unified Coding Lane
 (小而确定性)       +----+----------------+
                    |                     |
               Web tools             Pwn tools
             HTTP + Browser      ELF + PTY + GDB
                    |                     |
             Evidence / Artifact / Effect Journal
                    |
          Independent Reproducer / Verifier
                    |
              Host-only submit_flag
```

“多 Agent”只用于不同职责的上下文隔离和工具权限隔离，不要求每一步都启动一个独立进程或独立服务。一个 Run 由 Planner、统一 Coding Lane 和 Verifier 组成，共享同一 Control Store；Web/Pwn 通过能力和工具集合切换，不再复制一条 Solver Lane。

## 一、从 PentAGI 借什么，什么不要借

### 应该借用的机制

1. **Flow → Task → Subtask 的持久化拆解**

   PentAGI 把一次渗透任务拆成可恢复的 Flow、Task 和 Subtask。ProofBlade 可对应为 `Run → DomainTask → Experiment`：每个 Experiment 有前置条件、预算、预期 Evidence、重复键和失败分类。模型被中断后，不需要从整段对话猜“现在做到哪一步”。

2. **角色分工，但角色只是一组 Lane + Tool Scope**

   PentAGI 的 Generator、Primary、Searcher、Pentester、Coder、Refiner、Reporter 对应到 ProofBlade 后，建议只保留四种逻辑职责：`Planner`、`Domain Solver`、`Verifier`、`Reporter`。每个职责使用独立 system prompt、上下文视图和工具白名单，不要照搬十几个常驻 Agent。

3. **动态重规划和 Reflector**

   当一次实验失败，Refiner 不应只返回“继续”，而应生成：已证实事实、被否决假设、失败签名、禁止重复操作、下一步最多三项动作。ProofBlade 已有 `HandoffRecord`，应把它从 Fixture 评测路径提升为比赛路径的正式协议。

4. **工具调用屏障**

   PentAGI 会在达到迭代上限、需要压缩、遇到重复工具调用时插入屏障。ProofBlade 应将屏障绑定到领域不变量：

   - Web：没有 Baseline Request 和路由地图，不得进入漏洞利用；
   - Pwn：没有 `file/checksec` 和协议 Transcript，不得写最终 Exploit；
   - Pwn：没有 Leak 或稳定地址来源，不得宣称 ROP 已完成；
   - 两类：没有清洁会话/新进程中的成功复现，不得调用提交工具。

5. **迭代、重试、重复检测和优雅停止**

   Performer 的上限、工具失败重试、重复调用检测、接近上限时的总结，都应保留。但“重复”必须由领域归一化参数决定，而不是只比较原始 JSON 字符串。

### 不建议照搬的部分

- 不要把每个工具都包装成新的 Agent；Web/Pwn 的瓶颈是状态化交互和验证，不是角色数量。
- 不要把 Report 当作成功条件。CTF 成功条件是平台接受的 flag，Write-up 只能是后置产物。
- 不要引入未必需要的消息队列和分布式 Worker。ProofBlade 当前单进程 Control Store 已有单写者和恢复语义；先把领域闭环做对，再评估跨进程扩展。
- 不要让模型直接决定 `finish/SUCCEEDED`。PentAGI 的 Reporter 只能汇总，ProofBlade 的 `Verifier` 才能改变最终状态。

## 二、目标运行模型

### 2.1 统一阶段机

保留现有 `intake / reconnaissance / hypothesis / experiment / verification / report`，但给比赛 Run 增加领域门禁和更明确的终态：

```text
INTAKE
  -> RECON
  -> TARGET_MODEL
  -> HYPOTHESIS
  -> EXPERIMENT (可回到 HYPOTHESIS)
  -> REPRODUCE (可回到 EXPERIMENT)
  -> SUBMIT
  -> ACCEPTED | REJECTED_REPLAN | EXHAUSTED | NEED_HUMAN
```

现有 `Phase` 可以兼容这一设计：`TARGET_MODEL` 可先映射到 `hypothesis`，`REPRODUCE/SUBMIT` 映射到 `verification/report`，但快照里必须保存 `domainPhase`，避免所有比赛 Run 永远显示 `intake`。

每个阶段都由确定性 Gate 检查，而不是让模型在文本里声称“已经完成”：

| 阶段 | 必须存在的持久事实 | 退出条件 |
| --- | --- | --- |
| Intake | 题目类型、附件哈希、目标 Host/Port 或 URL | 运行环境和工作区健康 |
| Recon | 基线响应/Transcript、文件清单、工具链信息 | 至少一个可操作的目标模型 |
| Target Model | 结构化假设、支持它的 Evidence、反例/风险 | 选择一个有前置条件的 Experiment |
| Experiment | Effect、原始 Artifact、结果分类 | 获得新 Evidence 或明确否决假设 |
| Reproduce | 独立进程/清洁 Session 的复现 Artifact | Candidate 从当前代次结果中提取 |
| Submit | candidate hash、提交次数、平台 verdict | 接受则终态；拒绝则回到 hypothesis |

### 2.2 领域无关的 `ExperimentRecord`

建议在 `packages/materials/src/domain/types.ts` 增加类似结构：

```ts
interface ExperimentRecord {
  id: string;
  domain: "web" | "pwn";
  phase: "recon" | "hypothesis" | "experiment" | "reproduce";
  hypothesisId?: string;
  action: string;
  normalizedInput: Record<string, unknown>;
  repeatKey: string;
  preconditions: string[];
  expectedEvidence: string[];
  effectId?: string;
  artifactIds: string[];
  outcome: "new_evidence" | "no_signal" | "negative" | "tool_failure" | "timeout" | "unknown";
  failureSignature?: string;
  generation: number;
  createdSeq: number;
}
```

`repeatKey = sha256(domain + generation + action + canonical(normalizedInput))`。同一目标代次、同一动作和同一输入再次出现时，路由器应返回上一次结果摘要；只有模型明确改变假设、范围或输入，才允许重试。

### 2.3 Context 视图

沿用 ProofBlade 的 L0-L5 Context，但把 L3 的领域账本结构化：

- Web：`baseUrl / hosts / endpoints / parameters / cookies / csrf / auth / sinks / findings / chains`；
- Pwn：`binary / arch / protections / libc / loader / protocol states / offsets / leaks / bases / primitives / exploit stages`；
- 两者共享：`confirmed facts / rejected hypotheses / experiments / artifacts / jobs / leases / submission ledger`。

完整 HTTP body、PCAP、GDB transcript、PTY 输出仍只放 Artifact；模型上下文只放有界摘要和 Artifact id。

## 三、Web Solver 设计

### 3.1 Web 的核心问题

Web 题失败通常不是“不会 SQLi”，而是 Cookie、CSRF、跳转、Host、浏览器状态和多步请求没有被持久化。当前通用 `bash + curl` 可以做单次探测，但模型必须自己维护 Session、解析页面、记忆 Token，并且无法稳定处理 admin bot、DOM XSS、上传预览和复杂前端。

### 3.2 Web 阶段流水线

1. **Baseline**

   规范化 URL、Host、Port、协议和重定向边界；保存一次完整的 request/response（状态码、headers、body hash、Set-Cookie、HTML/JSON 摘要）。

2. **Surface Map**

   从 HTML、JS bundle、source map、robots、sitemap、OpenAPI、错误页和常见隐藏路径生成 `EndpointRecord`。每个 Endpoint 包含方法、参数、认证要求、Content-Type、响应特征和来源 Artifact。

3. **Trust Boundary**

   明确用户输入进入哪里：SQL/NoSQL 查询、模板、文件路径、URL fetch、XML/反序列化、命令、浏览器 DOM、后台任务或管理员 Bot。

4. **Small Primitive**

   先验证一个最小原语（回显、布尔差异、文件读取、内网访问、Token 伪造、Bot 触发），再组合利用链。每个 Probe 都必须有“成功判据”和“失败判据”，不能把 500、空响应或连接关闭当成功。

5. **Chain + Clean Reproduce**

   以干净 HTTP Session 或干净浏览器 Profile 重放完整链路，保存 HAR、关键响应和 Flag 提取过程。只在 Reproduce 成功后产生 Candidate。

### 3.3 建议的 `ctf.web` 能力

先提供结构化能力，保留 `bash` 作为逃生舱：

| 操作 | 作用 | 必须持久化 |
| --- | --- | --- |
| `session_start/status/stop` | 创建隔离 requests/Playwright Session | session id、Cookie/Storage hash、generation |
| `request` | 发送一次可审计 HTTP 请求 | 标准化请求、状态码、headers、body Artifact |
| `replay` | 按 request id 在干净/现有 Session 重放 | 对比差异、响应 Artifact |
| `route_map` | 解析 HTML/JS/robots/OpenAPI | Endpoint 列表与来源 |
| `browser_navigate/click/type/evaluate` | 处理 JS、Bot、DOM 和上传 | URL、DOM 摘要、截图、网络事件 |
| `network_list/get` | 读取浏览器请求链 | HAR/请求响应 Artifact |
| `cookies/storage` | 受控读取当前 Session 状态 | 脱敏摘要、Secret Artifact |
| `extract_candidate` | 从已验证响应提取 flag | 来源 response/artifact、candidate hash |

所有页面内容和响应都必须包装成不可信观察，不能修改 Tool Policy、目标范围或系统提示。`browser_evaluate` 应默认禁用跨域网络、文件系统和 Node API；需要攻击者回连时，必须显式申请 scope change。

### 3.4 Web 专用验证器

`WebReproducer` 不调用模型，只接受结构化 `ExploitChain`：步骤、请求模板、变量来源、预期断言、flag 提取表达式。它在新 Session/Profile 中执行，要求：

- 目标 Host/Port 仍属于当前 Scope；
- 每一步响应满足预期断言；
- Flag 来自本轮响应/Artifact，而不是 prompt 或脚本中的字面量；
- 至少一次全链路成功，必要时按题目策略重复第二次。

平台错误或错误 flag 必须形成 `platform_rejection` Evidence，并自动回到 `hypothesis`，而不是让模型继续修改 flag 字符串盲试。

## 四、Pwn Solver 设计

### 4.1 Pwn 的核心问题

Pwn 是有状态的字节协议和进程控制问题。一个连接关闭不等于拿到 Shell；一次 gdb 成功不等于远程地址相同；菜单提示的编码、缓冲区刷新、fork 行为、ASLR、libc 和输入约束都决定 Exploit 是否可复现。当前 `bash` 能调用 pwntools，但没有结构化 PTY、协议 Transcript、Leak/地址账本和本地/远程切换接口，模型容易把“脚本退出”误判为成功。

### 4.2 Pwn 阶段流水线

1. **Asset / Protections**

   `file`、架构、位数、RELRO、Canary、NX、PIE、FORTIFY、解释器、依赖和符号一次性记录；本地附件不可用时明确进入 remote-only 模式。

2. **Protocol Model**

   通过独立连接捕获原始 banner 和菜单 Transcript，保存 bytes、编码判断、状态名、稳定 Prompt Anchor、输入长度和超时。不能让模型手抄中文提示字节。

3. **Primitive Hypothesis**

   将问题归到 stack overflow、format string、UAF、heap metadata、integer/OOB、race、seccomp/kernel 等 primitive，并绑定验证动作。没有 primitive 的假设只能保持 OPEN，不能进入最终 payload。

4. **Leak / Base**

   把每个泄露字段建成 `LeakRecord`：来源字节范围、解析格式、地址类型、基址公式、置信度和清洁连接复现状态。ROP/FSOP/heap payload 只能引用已记录地址公式，不要把绝对地址硬编码进上下文。

5. **Exploit Stages**

   Exploit 是可执行 DAG：`sync -> setup -> trigger -> leak -> derive -> overwrite -> control -> shell_probe -> read_flag`。每一阶段有成功 Marker 或可检查的内存/寄存器断言；失败时只重跑当前阶段，不重写整个脚本。

6. **Local → Remote → Clean Reproduce**

   本地有 binary/libc 时先用同一 Exploit 模板切换 local/remote；远程成功必须使用全新连接，并看到唯一 Marker（例如 `PB_READY_<nonce>`）和 flag 读取结果。EOF、RST、SIGSEGV、进程退出都只能作为失败 Evidence。

### 4.3 建议的 `ctf.pwn` 能力

| 操作 | 作用 | 必须持久化 |
| --- | --- | --- |
| `inspect_elf` | file/arch/interpreter/deps/symbols/checksec | 结构化 `BinaryProfile` + 原始 Artifact |
| `find_gadgets` | ROPgadget/ropper/one_gadget | 工具版本、约束、候选 gadget Artifact |
| `identify_libc` | 根据已确认泄露匹配 libc | leak 输入、候选集合、选择依据 |
| `patch_loader` | local libc/loader 组合 | image/digest、loader、libc 路径 |
| `gdb_batch` | 无交互断点、寄存器/栈/内存断言 | GDB transcript、exit code、断言结果 |
| `process_start/read/send/stop` | 本地 PTY/管道会话 | session id、stdin/stdout bytes、状态、退出码 |
| `remote_start/read/send/stop` | 远程 pwntools tube 会话 | 目标、连接代次、Transcript、超时 |
| `shell_probe` | 发送唯一 marker 并验证回显 | marker、匹配字节、会话状态 |
| `qemu_run/debug` | 非本机架构或 kernel 题 | 架构、QEMU 参数、退出结果 |

`process_*` 和 `remote_*` 必须是持久 Job/Session，而不是一次性 `bash`。工具返回 `sessionId`，后续调用显式带上它；Run 结束或取消时由 Orchestrator 统一 stop/reap。Pwn image 里的 `pwntools/gdb/qemu` 继续保留，结构化能力只是给模型稳定边界和可验证结果。

### 4.4 Pwn 专用验证器

`PwnReproducer` 接受 Exploit Recipe 和运行配置，不接受自然语言“应该成功”：

- 新建进程或新建远程连接；
- 执行所有阶段并校验每个 Marker/Leak/地址公式；
- 发送唯一 shell marker 并读取精确回显；
- 从同一会话读取 `/flag`、`flag` 或题目定义的目标数据；
- 将 stdout/stderr/退出码/Transcript 写入 Artifact；
- 只有 `shell_marker + flag_extraction` 同时成功时才产生 Candidate。

这一步是 PentAGI ReAct 循环在 CTF 中最应该补上的“Barrier Tool”：模型可以提出 Recipe，但不能自称已获得 Shell。

## 五、控制平面和工具平面的改造边界

### 保留并复用

- `ControlStore / reducer / projection hash`：继续作为唯一状态真相；
- `EffectJournal`：所有网络、进程、浏览器和提交动作都走统一 Effect；
- `ArtifactStore`：原始输出只保存一次，模型只看有界摘要；
- `EvidenceGraph`：将观察、假设、反例、复现和候选串成推理树；
- `RunRecoveryService`：恢复 Session、Job、Container 和代次；
- `DockerContainerRuntime`：当前 target-only 网关和资源限制作为默认基线；
- `CompetitionApi`：平台 API 只在 Host 侧可用，凭据永不进入容器。

### 需要新增或替换

1. `packages/materials/src/domain/types.ts`

   增加 `DomainPhase`、`ExperimentRecord`、`WebState`、`PwnState`、`SessionRecord`、`CandidateRecipe` 和对应事件。

2. `packages/materials/src/capabilities/catalog.ts` / `backend.ts`

   增加 `ctf.web`、`ctf.pwn` manifest。Capability Backend 需要注入 `ContainerRuntimePort`、`JobRunner` 和 `ArtifactStore`，不能继续只把能力映射成 Fixture cwd 下的一次性命令。

3. `packages/materials/src/container/`

   新增结构化 PTY/管道会话、浏览器 daemon/Profile、HAR/截图/网络事件采集、Session reconcile 和 cleanup。浏览器和 PTY 的控制 socket 只在容器内部暴露。

4. `packages/materials/src/competition/loop.ts`

   将当前“每轮调用 Coding Lane 的短 nudge”改为 `CompetitionOrchestrator`：读取 Gate、生成/接受 Handoff、执行 Domain Solver、调用 Reproducer、处理平台 verdict。通用 Coding Lane 作为 fallback 和人工 Assist 工具，不再是 Web/Pwn Auto 的唯一执行入口。

5. `packages/materials/src/verification/`

   新增 `WebReproducer`、`PwnReproducer` 和统一 `CandidateVerifier`。`submit_flag` 继续只暴露给 Host-side submitter；模型只能提交 Candidate Proposal。

6. `packages/materials/src/runtime/`

   把通用 CTF prompt 保留为安全兜底；Web/Pwn 细节移入各自 Lane 的短 system prompt 和按需 Skill。不要把整个 exploit 手册永久塞进上下文。

## 六、分阶段交付顺序

### P0：先修“可观测但不可收敛”

- 比赛 Run 持久化 `domainPhase`，不再全部停留 `intake`；
- 启用 `HandoffRecord` 和 `ExperimentRecord`，把每次 bash/Capability 绑定到 hypothesis/repeatKey；
- `Competition Loop` 每轮先检查 Gate，再给模型下一动作；
- 将 `submit_flag` 改为 `candidate proposal → independent verifier → platform submit` 的统一链路；
- 记录每道题：首个 Evidence 时间、首次有效 Primitive、重复动作数、验证耗时、错误提交数和终止原因。

验收：同一失败动作第三次出现时被机械拒绝；重启后能恢复当前阶段和下一动作；所有 live Run 的阶段在事件与 projection 中一致。

### P1：Pwn 先行（建议下一步）

- 完成 `ctf.pwn` 的 `inspect_elf / checksec / process / remote / gdb_batch / shell_probe`；
- 在 Pwn image 中固定 pwntools、gdb、qemu、libc catalog 的版本和 digest；
- 首批回归题覆盖 ret2win、format string leak、ret2libc/PIE leak、菜单 heap/UAF；
- 一个 Exploit Recipe 必须能 local/remote 切换，并在新连接中取得 Marker；
- 将协议 Transcript 和 LeakRecord 注入 Context，而不是把上百次原始 bash 输出全部注入。

验收：4 类回归题各重复 3 次，`shell_probe` 成功率、远程 flag 提取率和错误提交数可统计；连接关闭不会被判定为成功。

### P2：Web 浏览器和请求状态

- 完成 `ctf.web` 的 Session、request/replay、route_map、browser、network/HAR；
- 首批回归题覆盖 SQLi、SSRF、上传/路径穿越、XSS/admin-bot；
- 支持 HTTP-only 与 Browser-required 两个执行分支；
- 用干净 Session/Profile 复现整条利用链，再产生 Candidate。

验收：Cookie/CSRF 在同一 Run 内可复用、不同 Run 互不可见；每条链至少有一份 HAR/响应 Artifact；重放结果具有明确断言。

### P3：Planner/Refiner 策略层（不新增解题 Lane）

- Planner 只输出结构化 Handoff，不直接操作目标；
- Solver 始终是唯一的 Unified Coding Lane，WorkItem 是唯一执行状态；
- 失败时由 Refiner 生成替代假设和禁止重复列表，但不创建第二条 Solver lane；
- 用 20 道以上 Web/Pwn holdout 评估策略层，只有成功率、成本或 p95 稳定改善才启用模型化 Planner/Refiner。

### P4：无人值守 Fleet 和高级题型

- 容器/PTY/浏览器恢复和 stale reaper；
- 更严格的 egress scope-change 审批；
- pwn-kernel 独立 QEMU profile；
- Web3、JSVMP、复杂浏览器逆向等作为后续能力，不阻塞基础 Web/Pwn。

## 七、评测指标和实验集

不要只看“最终是否提交正确 flag”。至少建立以下指标：

- `solve_rate`：平台接受率；
- `verified_rate`：独立复现成功率；
- `first_evidence_ms`、`first_primitive_ms`、`first_candidate_ms`；
- `tool_calls`、`experiment_count`、`repeat_block_count`；
- `wrong_submission_count`、`duplicate_submission_count`；
- Pwn：协议同步失败率、Leak 解析成功率、Shell Marker 成功率、local→remote 漂移率；
- Web：Baseline 成功率、Endpoint 覆盖数、Session 重放成功率、Browser 网络事件完整率；
- Provider：输入/输出/cache token、每题成本、p95 延迟和 context recovery 次数。

测试集至少包含三层：

1. **契约测试**：Gate、repeatKey、代次、Session 隔离、提交去重、恢复；
2. **合成靶场**：可控的 ret2win/format/heap 和 SQLi/SSRF/upload/XSS；
3. **真实 Holdout**：隐藏题目和真实平台 API，只在 `--allow-live` 下执行，记录稳定哈希和完整 Artifact。

## 八、最终建议

你的项目不需要重新做一个 PentAGI。最合理的路线是：

1. 保留 ProofBlade 的事件溯源、证据图、恢复、容器和平台 API；
2. 把当前通用 Coding Lane 降为 fallback/Assist；
3. 先实现 Pwn 的结构化 PTY + Exploit Recipe + Shell Marker 验证；
4. 再实现 Web 的持久 Session + Browser/Network Artifact + Clean Replay；
5. 最后用 PentAGI 风格的 Planner/Refiner Handoff 做有限度的动态重规划；
6. 用真实题目评测证明每一个额外 Agent 或额外模型确实提高 solve rate，而不是只增加 token 和复杂度。

当前最值得立即做的单个切片是：

```text
Pwn：inspect_elf → protocol_capture → pty/remote session
    → exploit_recipe → shell_probe → flag_extract
    → independent_reproduce → submit_flag
```

这个切片一旦跑通，Web 可以复用同一套 `Session / Artifact / Reproducer / Candidate` 抽象，只把底层交互换成 HTTP/Playwright。
