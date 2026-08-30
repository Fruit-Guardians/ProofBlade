# 基于《AI Agents in Depth》第6章的 ProofBlade 开发建议

> 参考文献：《AI Agents in Depth》（bojieli/ai-agent-book）第6章《交互：观察与动作空间的扩展》
> https://bojieli.github.io/ai-agent-book/book/chapter6/
>
> 本文延续 `CODING_AGENT_CHAPTER5_DEV_SUGGESTIONS_ZH.md` 的方法：逐条对照第6章核心论点与 ProofBlade 当前源码，区分"已领先 / 已具备 / 真实差距"，给出分级（P0 / P1 / P2）建议。所有现状描述均标注源码位置。

---

## 1. 文档目的与范围

第6章挑战了前五章的一个隐含前提——"Agent 思考时世界静止"。核心论断：**在底层模型固定时，提升 Agent 表现最主要的系统工程手段，是扩展观察空间与动作空间**，各有两个方向：

- **模态**：观察与动作的*形式*（文本 → 截图/语音/结构化事件流）；
- **时机**：观察与动作的*触发*（Agent 主动拉取 → 世界主动推送/事件驱动）。

第6章内容横跨事件驱动架构、语音交互、Computer Use（GUI 自动化）与机器人操作。对 ProofBlade（文本主导、轮次制、单 Run 闭环的 CTF Harness）而言，**并非全部适用**：语音与机器人章节几乎无关；但**事件驱动（时机轴）与观察接口设计（模态轴）对 CTF 场景有直接且可落地的映射**——后台爆破作业的唤醒、验证器完成的通知、操作员中途干预、Web 题目的浏览器观察接口。本文聚焦这些真实收益点，并在第 6 节明确列出"不建议投入"的方向。

---

## 2. 第6章核心论点速览（映射到 ProofBlade）

| 第6章论点 | ProofBlade 对应物 | 覆盖情况 |
|---|---|---|
| 结构化事件（来源/通道/内容/上下文四要素）+ 事件队列 + 事件循环 | JSONL Control Store（append-only 事件日志，`dispatch(session_opened)` 等） | ⚠️ 内部事件已有，模型可见的"观察队列"缺失（见建议 2） |
| monitor_shell：关键字/进程退出触发唤醒，避免轮询 | `jobs/background-runner.ts`（206 行）：只有 start/read(tail)/stop，**无触发等待** | ❌ 缺失（见建议 1，P0） |
| 紧急度动态处理：取消式 / 排队 / 并行三类 | 并行工具调用已支持（pi-agent-core agent-loop）；排队/取消式处理缺失 | ⚠️ 部分（见建议 3） |
| 打断同步模型：占位工具结果五规则 | `competition/loop.ts` 有 abort wiring / deadline / stopReason，占位结果语义未定义 | ⚠️ 部分（见建议 3） |
| 异步工具接口：initiate 与 complete 解耦 | shell_background/shell_job 已是此模式（发起/轮询分离） | ✅ 已具备，缺"完成事件主动可达" |
| 批量事件的注意力分散防护（`[未处理事件 N/M]` 标记） | 证据 curation gate 会积累 30+ 待审制品；无队列标记注入 | ❌ 缺失（见建议 2） |
| 轻量 LLM 作为事件路由器 | 无；curation 全靠主模型消化 | ❌ 缺失（见建议 4） |
| 虚拟身份 + 隔离执行环境（每会话一容器） | 每题目独立容器 + target-only 网络策略 | ✅ 已领先 |
| 用户沟通工具：多渠道通知/召回 | 无（held_for_approval 只落库，无推送） | ❌ 缺失（见建议 5） |
| AOI 三原则（关键帧观察、音量门控、文字描述压缩原图） | artifact + summary 模式（制品入库存、摘要留上下文） | ✅ 思想一致，浏览器观察层未落地（见建议 6） |
| Grounding：DOM/无障碍树索引、SoM 编号 | `web/browser-session.ts` 为有界会话封装，无元素索引 | ❌ 缺失（见建议 6） |
| 快慢思考分离 | 单一 solver 主模型，无轻量通道 | ❌（见建议 4，与建议 4 合并） |
| 世界模型 / 推测执行 | 容器快照 diff（docs/P0_5_CONTAINER_DIFF）有基础 | ⚠️ 按需深化（见建议 8） |
| 语音级联/Omni/全双工、Computer Use 通用 GUI、机器人 VLA | — | ➖ 不适用（见第 6 节） |

---

## 3. ProofBlade 已领先 / 已具备的部分

1. **内部事件溯源已经是事件驱动架构的地基**。Control Store 是 append-only JSONL 事件日志，所有副作用（会话开启、工具效果、验证结论）都以结构化事件落盘。第6章事件系统的四要素（来源/通道/内容/上下文）在事件 schema 中已具雏形——缺的只是"把这些事件作为**模型可消费的观察队列**"这一层投影（建议 2 补的就是这层）。

2. **异步工具接口（initiate/complete 解耦）已经实现**。shell_background / shell_job 正是第6章说的"发起与完成分离"：启动后台作业不阻塞轮次，读输出按需增量拉取。多数 Coding Agent 框架反而没有这个。

3. **虚拟身份与隔离执行环境已领先**。第6章强调 OpenClaw 每个会话用独立容器承载身份与状态；ProofBlade 每道题目天然就是独立容器 + target-only 网络 + 靶场代次，隔离边界比通用助理场景严格得多。

4. **AOI 的"文字描述压缩"思想已在证据系统中制度化**。第6章 AOI 三原则之一是"用文字描述画面，让原图被清出上下文后描述仍保留"——ProofBlade 的 artifact（原文入制品库）+ summary（摘要留上下文）+ curation gate 正是同一模式的严格版。建议 6 只需把它推广到浏览器观察层。

5. **Run 级取消/终止已具备**。`competition/loop.ts` 的 stopReason 枚举（solved / held_for_approval / max_turns / deadline / aborted / provider_error / terminated）+ activeLane.abort 接线说明终止路径是完备的——比第6章多数示例框架完整。

---

## 4. 差距分析与开发建议

### 建议 1（P0）：后台作业触发等待——把轮询变成事件

**第6章依据**：monitor_shell 模式——"监控新输出或关键字，出现时才唤醒 Agent"。书中算过账：让模型反复 `read` 轮询作业输出，每次都消耗一整轮 token 与延迟；正确做法是把"等待"下沉到 Harness，用触发条件换轮次。

**现状证据**：`packages/materials/src/jobs/background-runner.ts`（206 行）只提供 start / read（尾部增量）/ stop 三个操作；全文无 keyword / waitFor / pattern / trigger / notify 逻辑。当前系统提示甚至写着"Do not poll in a tight loop: start the job, do other analysis, and check back"——这等于把"何时回来看"的判断推给模型的直觉，而 CTF 场景里这个时机几乎总是可知的（作业完成、出现特征串、退出码非零）。

**CTF 典型受害者场景**：hashcat/john 跑字典（几十分钟）、fuzzer 长跑、后台 nc 监听等连接、`make` 大项目构建——模型只能盲轮询或干脆去做别的（然后忘了回来）。

**方案**：

1. `BackgroundJobStartInput` 增加可选 watch 规则集：
   - `matchOutput`：正则或哨兵串（如 `PB_DONE`、`cracked:`）；
   - `exitNonZero`：进程异常退出即触发；
   - `exitAny`：任意退出即触发；
   - `timeoutMs`：最长等待（与现有超时机制对齐）。
2. 新增或改造 read 语义为**等待式**：`wait_job`（或 read 加 `wait: true`）阻塞到触发条件满足或超时，返回触发原因 + 本次增量输出（增量计算复用现有 tail 逻辑）。
3. 触发事件（含原因、时间戳、增量摘要）作为结构化事件写入效果日志——保持确定性重放语义（重放时按记录的触发点恢复，不重新等待真实进程）。
4. 与建议 2 联动：触发后即使模型不在等待，也进入"待消费观察"队列。

**验收标准**：等待类任务（长跑作业）的工具调用次数从平均 N 次轮询降为 1 次（启动）+ 1 次（唤醒读取）；shell_job 读取的空轮询（无新输出）占比 <10%。

**工作量**：约 3-4 人日（runner 扩展 + 工具 schema + 效果日志事件 + 测试）。

---

### 建议 2（P0）：模型可见的观察队列 + 批次注意力标记

**第6章依据**：事件驱动的核心风险是**注意力分散**——事件批量到达时模型会漏看。书的解法：所有未处理事件按序排队，注入上下文时带 `[未处理事件 N/M]` 标记，把"还有什么没看"变成显式可见的状态；处理完成后标记消除。

**现状证据**：curation gate 在长 Run 中积累大量待审制品（本次会话实测 30+ 未审 artifacts），它们只在工具输出的提示行出现一次；后台作业完成、验证器出结论、审批状态变化等"世界侧进展"没有统一的待消费队列。模型对这些事件的感知依赖记忆与主动调用（report_status / curation_status），完全是被动的——这正是第6章批评的"拉模式"。

**方案**：

1. 定义统一的**观察队列投影**：从 Control Store 事件流过滤出"模型侧未消费的观察"（未读的作业触发、未读的验证结论、待审制品计数、审批等待），投影为有序列表。
2. 注入位置与第5章建议 3（状态栏）合并实现——状态栏的"未消费事件"区块即本建议的载体，格式采用第6章的计数标记（如 `待处理观察 3 项：[1/3] job#2 已触发(退出码1) [2/3] 验证器:候选未确认 …`），每项带一行摘要 + artifactId 引用。
3. 消费语义明确化：模型调用了相应工具（read_job_output / curation_status / read_artifact）即视为消费，投影中移除；连续 K 轮未消费的高优先级观察升级标记（防遗忘）。
4. 队列有界（如最多显示 8 项 + `…另有 N 项`），防止事件风暴挤爆上下文。

**验收标准**：长 Run 中"验证结论已出但模型未读取"的轮次延迟显著下降；后台作业触发后的首次响应延迟（触发→模型消费）可从状态栏日志度量。

**工作量**：约 4-6 人日（投影函数 + 注入层 + 消费标记追踪；与状态栏共享基建）。

---

### 建议 3（P1）：长工具打断的占位结果语义

**第6章依据**：打断同步模型的占位工具结果五规则——(1) 打断时工具结果模型不可见；(2) 占位消息说明被打断的原因；(3) 占位结果保持对话结构有效（可继续推理）；(4) 恢复时从中断点继续；(5) 处理路径中的错误须可恢复。

**现状证据**：`competition/loop.ts` 已有 deadline 强制 abort（`activeLane.abort("Challenge deadline exceeded")`）与 stopReason 记录，说明打断通道存在；但被打断的工具调用在轨迹中拿到什么结果、重放时如何处理、模型收到什么占位说明，没有统一规范。这对**确定性重放**（ProofBlade 的核心承诺）是隐患：一个被 abort 的 bash 调用若结果语义不固定，重放投影哈希就会漂移。

**方案**：

1. 定义 `interrupted` 工具结果类型：`{status: "interrupted", reason, partialOutputHash?, replay: "reexecute-from-start"}`——部分输出按现有 OutputRewrite 账本归档，占位结果本身进入效果日志。
2. 规则对齐第6章五条：占位消息明确写"因 X 被打断，输出已归档（artifactId）"，模型可基于它继续推理（如决定重启作业）。
3. 重放语义：interrupted 调用标记为"不重放执行、结果取自日志"，与现有原子投影机制兼容。
4. 覆盖三类打断源：deadline（已有）、操作员手动 abort（已有 stopReason="aborted"）、建议 1 的等待超时取消。

**验收标准**：构造"deadline 打断长 bash + 等待超时打断 wait_job"两类测试，打断后轨迹重放哈希一致；模型在被打断后下一轮能正确决策（重启/放弃）而非幻觉输出内容。

**工作量**：约 3-5 人日。

---

### 建议 4（P1）：快慢分离——轻量路由器消化事件分诊

**第6章依据**：事件驱动 Agent 的关键工程决策——**不要让主模型处理所有事件**。用轻量级模型（或规则）做事件路由器：分类、摘要、定优先级，主模型只消费路由结果。这是"快思考交互、慢思考回答"在文本 Agent 上的直接等价物。

**现状证据**：curation gate 的提示（"Curate: A-xxx …; viewed=33; reviewed=0; promoted=7"）直接注入主模型上下文，30+ 待审制品的名称+摘要全部要主模型过目。这些大多是程序性噪音（重复的 grep 输出、失败命令记录），真正需要判断的（flag 候选、关键反证）埋在里面。注意力成本与第6章描述的"事件风暴"完全同构。

**方案**：

1. 引入**侧通道分类器**（第一版可以是纯规则，不必上 LLM）：
   - 输入：待审 artifact 的元数据（命令类型、退出码、大小、是否含 flag 形态值、是否 failure-signature）；
   - 输出：`noise / candidate / urgent` 三级 + 一句话摘要。
   - 现有 failure-signature / flag-shaped-value 的自动检测逻辑已经在产生这些信号，只差一个把它们变成分诊决策的层。
2. 主模型上下文中的 curation 提示降维：只列 `urgent`（全摘要）+ `candidate`（名称+一行摘要）+ `noise`（仅计数）。noise 仍可通过 curation_status 全量访问，只是不默认注入。
3. provider-scheduler 已支持多 provider——路由任务可路由到最便宜的可用模型，天然利用现有调度设施。
4. **信任边界不变**：分诊结果只影响"注入什么摘要"，不改变证据晋升权限（gate 仍需主模型/人工）。

**验收标准**：curation 提示的平均 token 占用下降 50% 以上；flag 形态值候选的"出现→被 record"延迟不劣化（分诊不吞 urgent）。

**工作量**：规则版约 3 人日；LLM 路由版另加 2-3 人日（含 prompt 与回退到规则的降级路径）。

---

### 建议 5（P1）：操作员通知与召回通道

**第6章依据**：用户沟通工具——多渠道通知（重要事件主动推送而非等用户来看）与召回（发现已发消息有误时撤回/更正）。事件驱动 Agent 的价值一半在 Agent 侧，一半在人侧：人也是事件源和事件目标。

**现状证据**：`held_for_approval` 只作为 stopReason 落库；操作员若不盯着 CLI/GUI 就不知道 Run 停了。competition fleet 多靶并行场景下（fleet.ts 管理多 Run），人工巡检成本线性增长。

**方案**：

1. 定义操作员事件通知集：Run 终止（各 stopReason 分级）、flag 提交、验证失败、审批请求、预算阈值（>80%）。
2. 通道按优先级分：CLI 进程内通知（已完成时输出）→ 桌面通知（Windows toast）→ webhook（飞书/钉钉/Slack/自定义 URL，POST JSON：run id、题目、事件、摘要、深链）。webhook 走 GUI/CLI 配置文件。
3. **召回/更正**：GUI 中对已推送通知支持"状态更新"消息（flag 提交后又验证失败 → 推送更正），对应第6章的召回语义。
4. 通知内容走 Control Store 投影生成（不含靶机原始输出），保持不可信观察边界。

**验收标准**：多靶并行演练中，`held_for_approval` 从发生到操作员响应的平均时间从"下一轮人工巡检"降到分钟级。

**工作量**：CLI/GUI 内通知约 2 人日；webhook 通道约 3 人日。

---

### 建议 6（P1）：Web 题目的浏览器观察接口（AOI 模式落地）

**第6章依据**：Computer Use 的两个工程要点—— 接地：DOM/无障碍树索引（给可交互元素编号）比纯坐标预测可靠得多，这是动作空间的 grounding 基础； **AOI 三原则**：关键帧观察（只在有意义变化时取观察）、音量门控（噪音不进上下文）、文字描述压缩（描述留上下文、原始截图清出）。

**现状证据**：`web/browser-session.ts` 是有界会话封装（interactionCount 计数、ControlStore dispatch session_opened、制品归档集成），验证器侧有 web-reproducer；但观察层没有元素索引——模型看页面只能靠原始 HTML/文本 dump，交互动作也缺少元素定位原语。需要交互的 Web 题（bot 挑战、需要登录/点击流的 XSS、CSRF 链）目前在动作空间上是瘸的。

**方案**（按 CTF 收益排序，明确不做通用 Computer Use）：

1. **观察**：browser-session 新增 `page_state` 观察原语——解析 DOM，输出**可交互元素索引清单**（编号、标签、角色、可见文本、属性摘要）：`[3] <input name=password> [4] <a href=/admin>后台</a>`。这正是第6章的 DOM 索引 grounding，同时是天然的"文字描述压缩"：原始 HTML 进制品库，索引清单留上下文。
2. **动作**：新增 `interact` 原语，参数用索引编号引用元素（`click [4]`、`type [3] "admin"`），配合已有的会话/代次事件入 Control Store。动作空间从"裸 HTTP"扩展到"元素级"。
3. **关键帧**：只在交互前后各取一次页面状态（而非轮询），页面无变化时明确输出 `state unchanged`——对应关键帧观察。
4. 截图作为兜底通道保留（视觉模型可选用），同样走 artifact+summary。
5. 明确不做的：跨站通用 GUI 自动化、移动端操作（见第 6 节）。

**验收标准**：需要交互流的 Web 题目（登录后访问、点击触发 XSS）在 baseline-v2 类评测中的完成率与轮次改善；元素索引清单的平均 token 远小于原始 HTML dump。

**工作量**：约 5-8 人日（DOM 解析与索引、interact 原语、事件接入、样例题目回归）。

---

### 建议 7（P2）：持续思考——作业运行期间推进其他假设

**第6章依据**：书中给出约 200 行的持续思考编排——让文本模型在工具执行期间继续推理，工具完成后再合并结论。本质是把"等待"从死时间变成思考时间。

**现状**：系统提示已建议"start the job, do other analysis, and check back"，依赖模型自觉；agent-loop 是否支持非阻塞工具调用 + 后续事件注入未核实（pi-agent-core 以轮次为单位的结构可能需要 upstream 配合）。

**建议**：先落地建议 1/2（触发等待 + 观察队列），它们已覆盖 90% 的收益（模型可以启动作业后去做别的分析，触发后回来）；真正的"思考与工具流水线并行"涉及 agent-loop 侵入式改造，等 P0/P1 落地后按实测的等待空转率再评估。

**工作量**：调研 2 人日起；实施视 pi-agent-core 支持度而定。

---

### 建议 8（P2）：世界模型用于推测执行——按需深化

**第6章依据**：Computer Use Agent 用世界模型做推测执行——预测动作后果，与实际观察对比，不一致时回滚或重规划。

**现状**：ProofBlade 已有相邻基础——容器快照 diff（docs/P0_5_CONTAINER_DIFF_ZH.md）、pwn-reproducer 的可复现性要求。CTF 场景的"推测执行"等价物是：**破坏性动作前预测状态变化**（这条命令会写哪些文件、容器状态怎么变），与第5章建议 7（命令语义解析的写目标集合）是同一枚硬币的两面。

**建议**：不单独立项。命令语义解析落地时，其产出的"预测写目标集合"与执行后的容器 diff 对比，天然构成"预测 vs 实际"的校验环——顺手记录偏差率即可，将来若做回滚决策再升级为完整世界模型。

---

## 5. 落地路线图

### 近期（1-2 周，P0）
| 项 | 内容 | 预期收益 |
|---|---|---|
| 建议 1 | 后台作业触发等待（monitor 模式） | 长作业轮询轮次从 N 降到 2；空轮询消除 |
| 建议 2 | 观察队列投影 + `[未处理 N/M]` 标记 | 验证结论/作业触发的消费延迟显著下降 |

两项都在 jobs/runtime 层，不触碰 agent-loop；建议 2 的注入层与第5章建议 3（状态栏）共享基建，建议合并实现。

### 中期（1-2 月，P1）
| 项 | 内容 | 依赖 |
|---|---|---|
| 建议 3 | interrupted 工具结果语义 | 效果日志 |
| 建议 4 | 规则版事件分诊（快慢分离第一步） | curation 信号已有 |
| 建议 5 | 操作员通知通道（CLI/GUI → webhook） | 事件集定义 |
| 建议 6 | 浏览器元素索引观察 + interact 动作 | browser-session |

建议 4 与第5章建议 3/8 同周期推进（都涉及投影与注入层），注意回归前缀缓存指纹。

### 远期（P2）
建议 7（持续思考，视 pi-agent-core 支持度）、建议 8（世界模型校验环，挂在命令语义解析上）。

---

## 6. 明确不建议投入的方向（第6章启发）

第6章大量篇幅在语音与机器人，对 ProofBlade 是**负收益区**，明确排除：

1. **语音交互**（级联/Omni/全双工/快慢分离的语音版）：CTF Harness 无语音 I/O 场景；快慢分离的*文本版*收益已由建议 4 承接。
2. **通用 Computer Use / GUI 自动化**（跨应用鼠标键盘操作、截图坐标 grounding）：与 CTF 无交集；Web 题目所需的能力已由建议 6 以更可靠的 DOM 索引方式覆盖。
3. **机器人 / VLA / 移动端生态**：无关。
4. **全双工式"随时打断主模型"**：单题目单 Run 的 CTF 工作流下，打断收益集中在 deadline 与操作员 abort——已被建议 3 覆盖，不需要流式打断基础设施。
5. **为"世界主动找上门"引入任意外部事件源**（定时器、外部 webhook 触发 Run）：靶机不会主动说话；事件源应限定在内部（作业、验证器、审批、操作员），扩大事件源只会放大注入面与重放复杂度。

---

## 7. 风险与注意事项

1. **确定性重放是第一约束**：建议 1 的触发等待涉及真实进程与时间——重放绝不能重新等待，必须按效果日志中记录的触发点恢复；建议 3 的 interrupted 结果同理。所有新增事件类型都要过"投影哈希重放一致"测试。
2. **观察队列是新的注入面**：建议 2 的队列内容来自 Control Store 投影（可信），但**绝不能**把靶机输出原文放进队列标记（只能放摘要 + artifactId 引用）；建议 5 的通知内容同理。队列注入属于动态层，注意前缀缓存指纹。
3. **分诊不能吞 urgent**：建议 4 的规则版以高召回优先——宁可多标 candidate，不可漏 flag 形态值；规则版上线稳定后再考虑 LLM 路由，且 LLM 路由必须带规则回退。
4. **浏览器元素索引的 XSS 面**：建议 6 解析的是靶机 HTML——解析器本身要按不可信输入处理（禁外部资源加载、限制 DOM 大小），索引生成是纯函数投影，防止恶意超大 DOM 变成新的 DoS/注入通道。
5. **与第5章文档的建议去重**：本文建议 2 与第5章建议 3（状态栏）实为同一注入层的两个区块，建议合并实现与验收；两文工作量估计按合并后口径复核。
6. **pi-agent-core 升级耦合**：建议 1/3 若涉及工具结果类型扩展，优先在 ProofBlade 侧包装层实现（现有 catalog 注册机制支持），减少 upstream 绑定。

---

## 8. 附：本文结论的代码依据索引

| 结论 | 依据位置 |
|---|---|
| 后台作业无触发等待 | `packages/materials/src/jobs/background-runner.ts`（206 行；grep keyword/waitFor/trigger/notify 无命中） |
| Control Store 为事件日志 | `packages/materials/src/control/`（dispatch、session_opened 等事件类型，见 `web/browser-session.ts:63`） |
| Run 级 abort/deadline 已有 | `packages/materials/src/competition/loop.ts`（stopReason 枚举、`activeLane.abort`） |
| 异步工具接口已有 | `packages/materials/src/runtime/coding-resources.ts`（shell_background/shell_job）、`jobs/background-runner.ts` |
| 浏览器会话为有界封装、无元素索引 | `packages/materials/src/web/browser-session.ts`（Bounded response/state record、interactionCount） |
| 隔离执行环境 | `packages/materials/src/container/contracts.ts`（networkPolicy target-only）、靶场代次 |
| curation 信号已有（分诊原料） | 会话实测 curation 提示中的 failure-signature / flag-shaped-value 自动标注 |
| 容器 diff 基础 | `docs/P0_5_CONTAINER_DIFF_ZH.md` |
| 并行工具调用 | `pi-agent-core/dist/agent-loop.js`（`Promise.all(finalizedCalls)`） |
