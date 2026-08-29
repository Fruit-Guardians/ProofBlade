# 基于《AI Agents in Depth》第5章的 ProofBlade 开发建议

> 参考文献：《AI Agents in Depth》（bojieli/ai-agent-book）第5章《Coding Agent 与通用 Agent》
> https://bojieli.github.io/ai-agent-book/book/chapter5/
>
> 本文基于对仓库 `packages/`（atoms / molecules / materials）与 `apps/`（cli / gui）源码的实际盘点，逐条对照第5章的核心论点，给出分级（P0 / P1 / P2）的开发建议。所有"现状"描述均以当前代码为准，标注了对应源码位置。

---

## 1. 文档目的与范围

第5章系统阐述了 Coding Agent 的设计原理：七核心工具、文件系统作为中枢、Harness 工程四组件、故障恢复全链路（检测→恢复→接管→终止）、细粒度上下文管理、搜索与编辑工具的工程选型、安全防御（致命三要素 + 沙盒 + 语义解析）、以及"代码作为元能力"的六个扩展方向。

ProofBlade 是证据驱动型 CTF Agent Harness，其定位（验收基线明确、验证自动化、可回滚）天然落在第5章"Harness 工程四象限"的最佳象限。本文回答两个问题：

1. **哪些第5章能力 ProofBlade 已经领先实现**（避免重复建设）；
2. **哪些是真实差距**（按 CTF 场景收益排序，给出可落地方案与验收标准）。

---

## 2. 第5章核心论点速览（映射到 ProofBlade 语境）

| 第5章论点 | ProofBlade 对应物 | 覆盖情况 |
|---|---|---|
| 七核心工具（Code Interpreter / Bash / Read / Write / Edit / Glob / Grep） | pi-agent-core 提供 bash/read/write/edit；自研 shell_background / shell_job | **缺 Glob/Grep**（见建议 1） |
| 验收基线 + 执行边界 + 反馈信号 + 回退手段 | 独立验证器 + 容器边界 + 证据系统 + 靶场代次/效果日志 | ✅ 领先 |
| 四层故障分类（API / 工具 / 上下文 / 控制流） | provider-scheduler、tool-repeat-breaker、context-length-recovery、run-recovery | ✅ 大部分覆盖，控制流层有缺口（见建议 8） |
| 行号标注读取 + 首尾截断 | read 支持 offset/limit，仅头部截断（truncateHead），无行号 | ❌ 部分缺失（见建议 2） |
| 动态环境信息注入（状态栏） | 无（solver 有 report_status 工具但需主动调用） | ❌ 缺失（见建议 3） |
| 写入后即时语法反馈 | write/edit 仅回显字节数 | ❌ 缺失（见建议 4） |
| 持久终端会话 | bash 每次调用独立进程；shell_background 是后台作业不是交互终端 | ❌ 缺失（见建议 5） |
| 持久记忆（MEMORY.md）+ 信任审查 | knowledge 模块是 Run 内证据图 + search_history | ❌ 缺跨 Run 教训沉淀（见建议 6） |
| 命令语义解析（非关键字黑名单） | ApprovalPolicy 为操作员 allow/deny 账本 | ❌ 缺语义层（见建议 7） |
| 每条恢复路径独立熔断 / 死亡螺旋防护 / 看门狗 | provider-scheduler 退避重试 + tool-repeat-breaker 重复指纹 | ⚠️ 需核对（见建议 8） |
| 中立轨迹格式 / 跨厂商接管 | JSONL Control Store + provider-prefix 指纹 | ⚠️ 基础在，缺导出格式（见建议 9） |
| 思考工具（符号计算/约束求解） | run_background 可跑任意脚本；capabilities 有 binary/firmware/reverse/backend | ⚠️ 可低成本补（见建议 10） |
| Agent 自举 / doctor 自诊断 | 无 | ❌ 缺失（见建议 11） |
| 设计文档 → 自审工作流 | propose_intent / propose_hypothesis / submit_candidate | ⚠️ 有提案无强制计划/自审（见建议 12） |

---

## 3. ProofBlade 已领先的部分（不建议动）

对照第5章，以下能力已经超出书中基线，属于差异化优势，后续开发应**保持并加固**而非重做：

1. **验收基线与验证自动化（第5章四象限最佳区的核心）**
   `materials/src/verification/`（verifier、claim-verification、pwn-reproducer、web-reproducer）实现了"只允许独立验证器判定任务完成"，这正是第5章强调的"验收基线必须独立于 Agent 自身"。CTF 的 flag 判定天然可自动化，ProofBlade 把这一优势制度化到了 Control Store 与 Run/Phase 状态机中。

2. **回退手段**
   靶场代次、原子化持久投影、崩溃可恢复的效果日志，对应第5章"可靠的回退手段"。比书中示例（git 回滚）更严格。

3. **不可信观察边界**
   第5章用大量篇幅讲"外部内容不可直接进上下文"。ProofBlade 的不可信观察边界 + 输出改写账本（output-rewrite + snipText + OutputRewriteTicket）已经是系统化实现。

4. **上下文工程的确定性**
   六层上下文编译器 + 前缀缓存指纹（L0/L1 可复用与 L2-L5 动态分离）直接对应第5章"细粒度上下文管理"的工程化方向，且加了确定性要求（同输入同输出），这是书中没有展开的部分。

5. **并行工具调用**
   pi-agent-core 的 agent-loop 已支持并行工具调用（`Promise.all(finalizedCalls)`）。第5章的"并行+流式执行+级联中止"中，并行这一环已具备。

6. **网络出口控制**
   `container/contracts.ts` 的 `networkPolicy`（target-only 网关模式）正对应第5章"默认断网、按需白名单放行"的推荐——CTF 靶场网络天然是 target-only，这一设计选型正确。

---

## 4. 差距分析与开发建议

### 建议 1（P0）：补齐 Glob / Grep 结构化搜索工具

**第5章依据**：Glob 与 Grep 是七核心工具中的两个；书中明确趋势是"agentic 搜索（grep+glob 让模型自己组合迭代）优于预建嵌入索引"，并列出四种搜索路线（正则 / 文件名 glob / 语义 / 符号级），前两种是地基。

**现状证据**：`node_modules/@earendil-works/pi-agent-core/dist/harness/tools/` 只有 bash / read / write / edit / image；`materials/src/runtime/coding-resources.ts` 与 `coding-lane.ts` 也未封装搜索工具。模型目前只能通过 bash 执行 `grep` / `find`：

- 输出无结构（无独立"文件:行号:内容"字段），易被整体截断；
- 模式串要经过 shell 引号转义，复杂正则（CTF 逆向中常见的 `\x` 序列、`{n,m}`）经常因转义错误静默失败；
- 跨宿主（Windows bash / 容器 Linux）grep/find 行为不一致。

**方案**：

1. 在 `materials/src/tools/` 或 coding-resources 中新增两个原子工具：
   - `search_files`（glob）：参数 `pattern`、`path`、`maxResults`；返回结构化文件列表。
   - `search_text`（grep）：参数 `pattern`（原生正则，不经 shell）、`path`、`include`（glob 过滤）、`contextLines`、`maxResults`；返回 `{file, line, text}` 数组，走 `snipText` 截断与 OutputRewritePort 账本。
2. 实现直接用 Node API（`fast-glob` / `picomatch` + 自研行扫描或 `vscode-ripgrep` 内嵌 rg 二进制），**不经过 shell**，消除转义层。
3. 匹配结果的行号与建议 2 的 read 行号对齐，形成"搜索定位 → read 精确续读"闭环。

**验收标准**：baseline-v2 中"在仓库中定位校验函数/字符串"类任务的工具轮次与 token 消耗下降；含特殊字符的正则不再产生 shell 转义错误。

**工作量**：约 2-4 人日（含测试与 COMPONENT.md 登记）。

---

### 建议 2（P0）：read 输出行号标注 + 首尾截断

**第5章依据**：行号标注让模型能精确引用位置（配合编辑工具与后续讨论）；大输出截断应"保留首尾、折叠中部"——头部给结构、尾部给结论，并提示续读方式。

**现状证据**：`pi-agent-core/dist/harness/tools/read.js` 使用 `truncateHead`（只保留头部），输出无行号。对 CTF 的典型大文件（日志、dump、反汇编清单）来说，尾部往往是结论所在（如最后一条崩溃记录、最后一个段），纯头部截断会丢关键信息。

**方案**：

1. 在 coding lane 包装 read 工具：每行前缀右对齐行号 + 分隔符（如 `  42│ `）；`offset` 参数语义改为"起始行号"，与 grep 结果（建议 1）互相引用。
2. 截断策略改为 head + tail：如 `前 200 行 + …[省略 N 行，用 offset=X 续读]… + 后 50 行`，折叠提示本身可操作。
3. **兼容性注意**：行号前缀会进入上下文与前缀缓存指纹。六层编译器要求确定性输出，行号方案是纯函数（同文件同内容同行号），不影响确定性；但需确认 prompt-cache 指纹计算把 read 结果归入 L2-L5 动态层而非 L0/L1 稳定层。
4. 二进制 / 图片路径保持现状（read 已有 hexdump / base64 分支）。

**验收标准**：截断输出的续读成功率上升（模型能一次给出正确 offset）；edit 的 oldText 定位错误率下降。

**工作量**：约 1-2 人日。

---

### 建议 3（P1）：环境状态栏——Run/Phase/靶场/预算动态注入

**第5章依据**：Coding Agent 应把"环境状态"（cwd、git 分支、最近提交、未提交改动）以状态栏形式动态注入系统提示尾部，让模型持续感知环境漂移，而不是靠记忆或主动查询。

**现状证据**：无状态栏机制。`solver-tools.ts` 有 `report_status` 工具，但需要模型主动调用且消耗一轮工具调用；长 Run 中后期模型容易"忘记"当前 phase 与剩余预算。

**CTF 语境的等价状态集合**（比书中 git 状态栏更关键）：

- 当前 Run / Phase / 已用轮次；
- 靶场代次与容器健康状态；
- 活跃租约（谁持有、何时过期）；
- 时间与 token 预算余额（剩余百分比）；
- 未消费的验证结论（最近一次 submit_candidate 的验证结果摘要）；
- 当前活跃假设数量与最高置信假设。

**方案**：

1. 在六层上下文编译器的动态层新增一个 `status block`，由 Control Store 投影**确定性生成**（纯函数：投影状态 → 固定格式文本），每轮自动附加，无需模型调用。
2. 严格走不可信观察边界：状态栏只放控制存储内的可信投影数据，**绝不放靶机输出**（否则成为注入通道）。
3. 与 `report_status` 工具并存（工具保留完整版，状态栏只放摘要）。

**验收标准**：长 Run 中 `report_status` 调用频次显著下降；预算耗尽前模型主动收敛（提前提交候选而非被硬截断）。

**工作量**：约 3-5 人日（含投影函数与缓存指纹回归）。

---

### 建议 4（P1）：write/edit 后即时语法反馈

**第5章依据**：写入文件后立即运行轻量语法检查，把错误作为工具结果的一部分返回——"把错误消灭在产生它的那一轮"，省掉一整轮"运行→报错→修复"。

**现状证据**：coding-resources 的 write/edit 包装器成功后仅回显字节数/哈希；语法错误要等到下一次 bash 执行（`node exp.js` 报 SyntaxError）才暴露，CTF 场景每一轮都是真金白银的预算。

**方案**：

1. write/edit 落盘后**异步**运行轻量校验（不阻塞成功返回）：
   - `.py` → `py_compile` 等价检查或 AST parse；
   - `.js` / `.mjs` / `.cjs` → `node --check`；
   - `.ts` → esbuild/swc 仅 parse（不做类型检查，保持 <300ms）；
   - `.json` → `JSON.parse`。
2. 校验结果以**非阻塞附注**并入工具结果（"写入成功；附带检查发现：第 12 行意外缩进"）；超时 500ms 直接放弃附注，绝不影响主路径延迟。
3. 失败不影响写入本身（半成品脚本是合法的中间态），只提供信号。

**验收标准**：exp 脚本类任务的"语法错误修复"平均轮次下降 1 轮以上。

**工作量**：约 2-3 人日。

---

### 建议 5（P1）：会话级 shell 状态（轻量持久终端）

**第5章依据**：持久终端会话保持 `cd` / 环境变量 / 激活的 venv / 后台进程，避免每条命令重复设置上下文。

**现状证据**：bash 每次调用独立进程；`shell_background` / `shell_job` 解决的是长任务而非会话状态。CTF 解题中常见模式是：下载工具 → 进目录 → 配置 → 反复运行，每次重复 `cd` 与 `export` 既费 token 又易错。

**注意**：ProofBlade 已有专门的 pwn 交互协议纪律与 pwn-reproducer，**交互式靶机协议不需要持久终端来解决**（那是 reproducer 的职责）；这里只补"会话级工作目录与环境变量"。

**方案（按成本递增，推荐先做 A）**：

- **方案 A（低成本）**：bash 包装器维护会话级 `cwd` 与 `env` 增量：工具结果中允许模型声明"切换到 X 目录"或由包装器跟踪 `cd` 命令，后续调用自动前缀 `cd <session-cwd> &&`。会话状态写入效果日志以保证可重放。
- **方案 B（完整）**：新增 `terminal` 工具（会话 id + send + expect 超时语义），复用 shell_background 的作业管理基础设施。**风险**：交互式状态使确定性重放复杂化，必须把会话快照纳入 Control Store。

**验收标准**：方案 A 即可——连续 bash 调用不再重复 `cd` / `export` 前缀，命令平均长度下降。

**工作量**：方案 A 约 2-3 人日；方案 B 约 5-8 人日（重放语义是主要成本）。

---

### 建议 6（P1）：跨 Run 经验记忆（教训库）+ 入库信任审查

**第5章依据**：MEMORY.md 式持久记忆让 Agent 跨会话积累经验；但书中把"持久记忆"列为致命三要素之外的第四个放大器——**写入长期记忆的内容必须经过与外部内容同等的信任审查**，否则恶意指令会潜伏在记忆中长期生效。

**现状证据**：`knowledge/` 模块（evidence-graph、curation-gate、observer）是 Run 内证据治理；`search_history` 工具能检索历史观察，但检索是无结构全文式的，没有沉淀为"教训"：什么方法在什么类型靶机上失败过、哪个 capability 组合对哪类固件有效、哪类题目超时的根因。

**方案**：

1. 新增 `lessons` 投影（Control Store 内）：Run 终止时由复盘步骤从已晋升证据中提炼候选教训，结构为 `{类别, 适用条件, 教训正文, 来源证据id, 置信度}`。
2. **入库必须走 curation gate**（复用现有证据治理门），禁止 Agent 单方面写教训库——这同时满足第5章的信任审查要求与 ProofBlade 的证据驱动原则。
3. 注入规则：下个 Run 的 L1/L2 层按题目类别/能力路由匹配注入，最多 N 条（防记忆膨胀挤占预算）。
4. 教训正文在注入时按**不可信内容**处理（标注来源、不允许包含指令性语句），防注入潜伏。

**验收标准**：同类题目的重复失败模式（如对同一类固件重复尝试无效方法）在第二个 Run 中减少；教训库规模有界。

**工作量**：约 5-8 人日（含 gate 集成与注入层改造）。

---

### 建议 7（P1）：shell 命令语义解析（写目标集合评估）

**第5章依据**：Shell 命令的组合爆炸（base64 解码、`$IFS`、子 shell、变量拼接）使关键字黑名单形同虚设；必须在**语义层**理解命令的真实效果——重点是命令会**写哪里、删哪里、联网去哪**。

**现状证据**：`security/approval-policy.ts` 的 ApprovalPolicy 是操作员驱动的 allow/deny 账本（审批粒度），没有命令效果解析。CTF 场景的特殊性在于**大部分命令必须放行**（逆向、调试、网络探测都是常态），真正要拦的是窄集合：破坏工作区、污染控制存储、删除制品、误伤宿主。

**方案**：

1. bash 工具执行前加一层命令分析器：用 shell AST 解析器（如 tree-sitter-bash 的 WASM 绑定）解析命令，提取**写目标集合**（重定向目标、`rm/mv` 参数、`tee` 输出）与**网络出口**（curl/wget/nc 目标）。
2. 规则采用**白名单语义**而非黑名单关键字：
   - 允许写：`work/`、`tmp/`、靶场容器内任意路径；
   - 禁止写：Control Store 路径、制品目录（artifact-store 管辖范围）、`.git/`、`package.json` 等仓库关键文件；
   - 网络目标超出靶场白名单 → 转 ApprovalPolicy 人工审批。
3. 解析失败（混淆/非常规语法）本身就是一个信号：降级为要求审批，而非放行。
4. 输出结构化拒绝理由（"该命令试图写入 control store：…"），让模型能改写命令而非盲试。

**验收标准**：对常见混淆写法的攻击样例（编码拼接、变量间接、子 shell）在测试集上拦截率显著高于字符串黑名单基线；正常解题命令误拦率 <1%。

**工作量**：约 5-8 人日（AST 解析集成 + 规则集 + 测试集）。

---

### 建议 8（P1）：故障恢复链路补强——控制流层检测与死亡螺旋防护

**第5章依据**：完整链路是"检测（分类后计数、重复调用指纹、连续失败计数、活性看门狗）→ 恢复（静默重试/降级续行/暴露给用户）→ 接管（跨厂商）→ 终止（**每条恢复路径独立熔断上限**、死亡螺旋防护、全局终止条件）"。特别强调：恢复动作本身也可能失败，二次恢复必须有上限，否则陷入"用失败修复失败"的死亡螺旋。

**现状证据**：已有相当扎实的部分——`provider-scheduler.ts`（重试分类 + `retryBaseDelayMs` 指数退避）、`tool-repeat-breaker.ts`（420 行，重复调用指纹检测）、`run-recovery.ts`、`context-length-recovery.ts`。API 层与工具层故障覆盖较好。需要核对/补强的：

1. **控制流层"无进展"检测**：Run 层面缺少"连续 N 轮无新事实/新证据/新制品增量"的死循环判据。CTF 中典型症状是模型在两个假设间来回摇摆。
   - 方案：在 Control Store 上加"进展指纹"投影（本轮新增的已晋升事实数、证据数、制品数、假设状态变化数）；连续 K 轮增量为零 → 触发降级（注入收敛提示）→ 仍无进展 → 终止并交由操作员。
2. **每条恢复路径独立熔断**：核对 scheduler / repeat-breaker / context-recovery 的重试预算是否独立计数，避免 A 路径的重试消耗掉 B 路径的预算（共享计数器是死亡螺旋的常见成因）。
3. **活性看门狗**：无工具调用的纯思考轮次超时（模型卡在长推理或流式中断）。
4. **二次恢复上限**：恢复动作（如上下文压缩）本身失败后的再恢复次数上限，超限直接升级为 Run 终止。

**验收标准**：构造"假设摇摆"与"恢复动作失败"两类故障注入测试，Run 能在预算内确定性地终止并输出结构化诊断（失败在哪一层、走了哪条恢复路径、为何熔断）。

**工作量**：约 4-6 人日（进展投影 + 各恢复路径预算核对 + 故障注入测试）。

---

### 建议 9（P2）：中立轨迹格式与跨厂商接管演练

**第5章依据**：跨厂商接管要求"thoughts 是可移植文本、credentials 不可移植"，需要中立轨迹格式让另一家厂商的模型从断点续跑。

**现状证据**：JSONL Control Store + provider-prefix 缓存指纹已经具备中立基础（事件不绑定厂商）；provider-scheduler 支持多 provider 调度。

**建议**：定义厂商中立 trajectory 导出/导入（剥离 provider 专有 reasoning 字段、保留工具调用与结果），并在演练环境做一次"provider A 中途故障 → provider B 接管续跑"的端到端验证。优先级低（单厂商运行时无感），但该格式同时是复盘与人审的基础设施。

**工作量**：约 3-4 人日（格式定义 + 导出 CLI + 一次演练）。

---

### 建议 10（P2）：思考工具——把符号计算/约束求解做成一等能力

**第5章依据**："思考工具"让模型把数学推理外包给代码（符号计算、约束求解器）；并提醒权衡——模型越强脚手架越薄，但对密码学、格论这类精确推理，求解器仍是降维打击。

**CTF 收益**：密码题（RSA 参数恢复、Coppersmith、z3 约束求解）、逆向中的约束化简（符号执行）都是典型场景。

**方案**：不需要新工具——`run_background` 已能跑任意脚本。建议把 `z3-solver` / `sympy` /（可选）`sage` 注册为 `capabilities/catalog.ts` 中的标准能力（与 binary/firmware/reverse/backend 并列的 `math` 类别），配技能文档（skills）说明典型密码题模板。能力路由按题目类别自动推荐。

**验收标准**：密码类题目用例上，从"读题"到"列出方程"再到"调用求解器"的轮次缩短。

**工作量**：约 2-3 人日（能力注册 + 技能文档 + 样例）。

---

### 建议 11（P2）：`proofblade doctor` 自举自诊断

**第5章依据**：OpenClaw 的 `doctor` 命令自动检测配置异常、依赖缺失、环境问题——Agent 自举的前提是自我修复，自我修复的前提是自我诊断。

**现状证据**：CLI 无自诊断。ProofBlade 的运行时依赖面很宽（node 版本、pi 0.83.0 pin、docker daemon、容器镜像、MCP registry（ida/jadx 等）、skills 目录、control store 完整性），任何一环坏了都会在 Run 中段以神秘错误暴露。

**方案**：`apps/cli` 新增 `doctor` 子命令，逐项检查并输出结构化报告（`{检查项, 状态, 修复建议}`）：

- node 版本与 engines 约束、pi-agent-core/pi-ai 是否仍是 0.83.0；
- docker daemon 可达、所需镜像存在、磁盘余量；
- MCP registry 中注册服务器的连通性（轻探活，不启动重分析）;
- 最近 Control Store 的投影哈希重放一致性；
- skills / capabilities 目录结构与 `check:components` 校验（可整合现有 `scripts/check-component-docs.mjs`）。

**验收标准**：新环境部署时间从"跑到一半报错再排查"缩短为"doctor 一次性列出全部问题"。

**工作量**：约 3-5 人日。

---

### 建议 12（P2）：解题计划文档与提交前自审清单

**第5章依据**：Coding Agent 工程化流程是"项目文档化 → 需求澄清 → 设计文档 → 实现与测试 → 自审 → 文档同步交付"。对解题任务，设计文档对应"解题计划"，自审对应"提交前清单"。

**现状证据**：solver 已有 `propose_intent` / `propose_hypothesis` / `submit_candidate`（带 evidenceIds 参数）——提案与证据绑定已经很好，缺的是两个轻量环节：

1. **计划环节**：Phase 状态机可选 `plan` 阶段，产出结构化解题计划（攻击面假设、步骤、每步验证方式、预算分配、放弃条件），计划作为可引用制品入库。
2. **自审环节**：`submit_candidate` 前强制 checklist：flag 格式与任务声明一致、证据引用完整且已晋升、reproducer 就绪、未消费的反证假设已处理。清单结果随提交记录，验证器判定之外的"过程质量"可追溯。

**注意**：保持可选与轻量——简单题目强制计划是官僚化（第5章也强调约束要优先于指导、且按任务复杂度适配）；复杂题目（多阶段 pwn、固件全链路）收益明显。

**工作量**：约 3-4 人日（phase 扩展 + 清单校验器）。

---

## 5. 落地路线图

### 近期（1-2 周，P0）
| 项 | 内容 | 预期收益 |
|---|---|---|
| 建议 1 | Glob/Grep 结构化搜索工具 | 消除 shell 转义错误，搜索轮次下降 |
| 建议 2 | read 行号 + 首尾截断 | 大文件定位效率、edit 精度提升 |

P0 两项都只动 coding lane 工具层，不触碰 Control Store 语义，风险低、收益立竿见影。

### 中期（1-2 月，P1）
| 项 | 内容 | 依赖 |
|---|---|---|
| 建议 3 | 状态栏动态注入 | 六层编译器动态层 |
| 建议 4 | 写后即时语法反馈 | 无 |
| 建议 5A | 会话级 cwd/env | 效果日志 |
| 建议 8 | 进展指纹 + 恢复预算核对 + 看门狗 | Control Store 投影 |
| 建议 7 | 命令语义解析 | tree-sitter 集成 |
| 建议 6 | 教训库 + gate 入库 | curation gate |

建议 3/4/5A 提升每轮效率，建议 8 提升可靠性，建议 6/7 是中期里偏治理的两项，可视人力拆到下个周期。

### 远期（P2）
建议 9（中立轨迹）、10（数学能力）、11（doctor）、12（计划/自审环节）。均无前置依赖，可按运营痛点插队。

---

## 6. 风险与注意事项

1. **前缀缓存兼容**：建议 2（行号）与建议 3（状态栏）都会改变进入上下文的文本。必须保持"纯函数生成"（同状态同输出），并把它们归入动态层参与指纹计算，避免污染 L0/L1 稳定前缀导致缓存失效率上升。落地前先跑 prompt-cache 指纹回归。
2. **确定性重放**：建议 5（会话 shell 状态）与建议 4（异步校验附注）都引入了新的副作用来源，全部必须入效果日志；异步附注若超时放弃，结果中要留确定性标记（如 `check: skipped`），保证重放一致。
3. **教训库的注入面**：建议 6 的教训正文是"曾经的模型输出"，按不可信内容处理；注入层禁止指令性语句，并在 curation gate 审核时人工过目。第5章把持久记忆列为注入放大器不是耸人听闻。
4. **语义解析的误拦成本**：建议 7 的规则要默认从紧（只拦明确写危险目标），误拦对 CTF 解题的杀伤比漏拦大；解析失败降级为审批而非直接拒绝，给模型改写命令的机会。
5. **不建议投入的方向**：语义嵌入搜索（第5章明确趋势是 agentic grep+glob，且 CTF 的异构内容——二进制、反汇编、混淆文本——嵌入索引价值低）；生成式 UI/A2UI（GUI 已有固定界面，CTF 场景无需求）；强制的重流程（计划/自审保持可选，避免官僚化拖慢简单题）。
6. **与 pi-agent-core 升级的耦合**：建议 1/2 若在 ProofBlade 侧包装实现，将来 pi 升级内置同类工具时会有冗余；建议包装层做成可替换（catalog 注册机制已支持按 entry 组装，切换成本低）。

---

## 7. 附：本文结论的代码依据索引

| 结论 | 依据位置 |
|---|---|
| 工具集为 bash/read/write/edit + shell_background/shell_job | `materials/src/runtime/coding-resources.ts`、`pi-agent-core/dist/harness/tools/` |
| read 无行号、仅头部截断 | `pi-agent-core/dist/harness/tools/read.js`（`truncateHead`） |
| 无 Glob/Grep 工具 | `pi-agent-core/dist/harness/tools/` 目录、coding-resources/coding-lane 检索 |
| 并行工具调用已支持 | `pi-agent-core/dist/agent-loop.js`（`Promise.all(finalizedCalls)`） |
| 退避重试已实现 | `materials/src/runtime/provider-scheduler.ts`（`retryBaseDelayMs`） |
| 重复调用指纹已实现 | `materials/src/runtime/tool-repeat-breaker.ts` |
| 审批为账本模式（非语义解析） | `materials/src/security/approval-policy.ts` |
| 网络出口 target-only | `materials/src/container/contracts.ts`（`networkPolicy`） |
| 输出改写与截断 | `molecules/src/text-window.ts`（snipText）、`materials/src/tools/output-rewrite.ts` |
| solver 工具清单（含 report_status/search_history/submit_candidate） | `materials/src/runtime/solver-tools.ts` |
