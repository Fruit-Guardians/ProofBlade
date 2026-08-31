# ProofBlade 消融闭环台账

状态：进行中。本文将 Chapter 7 的评测方法落实为每次真实实验必须交付的行为分析与修复闭环，而不是只汇报成功率。

相关设计依据：`docs/CHAPTER7_AGENT_EVALUATION_ABLATION_DEVELOPMENT_PLAN_ZH.md`、`docs/ABLATION_EVALUATION_DEVELOPMENT_PLAN_ZH.md`、`docs/PERSISTENT_CONTEXT_RAG_DEVELOPMENT_PLAN_ZH.md` 与 `docs/INFORMATION_THEORETIC_CONTEXT_RAG_RESEARCH_ZH.md`。

## 1. 结论使用规则

- 评估对象是“具体模型 + 固定 Harness + 固定安全边界”，不是模型名称本身。
- 每个普通消融一次只改变 `HarnessPolicy` 的一个主因素；模型、语料、预算、Verifier、权限、隔离和答案防泄漏必须保持不变。
- 任何结果都同时报告结果、过程、机制、护栏和首错。`Pass@k`、`Pass^k` 与单次成功不得混称为“成功率”。
- 一个或两个 toy fixture 只用于控制平面 smoke、Provider 连通性和回归，不用于宣称某项策略在真实 CTF 上有效。
- 发现失败时，先依据持久事件、Pi session、Artifact、Evidence 和 Provider telemetry 分类；修复必须有回归测试和同配置复测。成功也必须解释它为何更快、更少重复或更可靠。

## 2. 功能盘点与实验矩阵

`packages/materials/src/evaluation/ablation.ts` 中的可消融 Harness 因子如下。正式实验对照值为 `DEFAULT_HARNESS_POLICY`，执行时固定语料分层并交错配对。

| 因子 | 主要假设 | 适用任务 | 目标与机制指标 | 应观察的坏轨迹 | 失败后的修复方向 |
| --- | --- | --- | --- | --- | --- |
| `firstAction` | 首步门控减少无效首调用 | 全部，尤其短任务 | 首个有效动作时间、首步命中、成功率 | 强制错误工具或首步空转 | 降为软建议，按 target kind 配置 |
| `phaseRoute` | 阶段提示改善调查顺序 | 多步、状态型任务 | 首错阶段、回退数、总轮数 | 已有候选仍被迫走假设阶段 | 候选优先跳转到验证 |
| `actionBundle` | 有界工具包避免无关调用 | 工具密集任务 | 有效调用比、工具错误率 | 简单任务被阶段包拖慢 | 对确定性任务允许早验证 |
| `duplicateFailure` | 重复失败处理减少死循环 | 不稳定工具、失败恢复 | 重复签名、恢复率、成本 | 一次瞬时故障被当作永久失败 | 区分 Provider 瞬时错误与模型重复 |
| `circuitBreaker` | 熔断抑制无进展尾部成本 | 长任务、工具风暴 | 无进展轮、尾部成本、p95 | 提前切断可验证候选 | 验证路径优先于熔断 |
| `contextSelection` | 信息密度提升而不丢关键事实 | 长上下文、恢复 | 上下文 token、Recall 后采纳率、成功率 | 关键观察被裁掉或无关块占据上下文 | 调整 receipt、查询选择和前缀回放 |
| `recall` | 按需回忆减少重复读取 | 长任务、跨轮恢复 | Recall 命中/采纳、重复工具调用 | 路径存在但模型不读取，或过度自动召回 | 提供精确引用或改为建议模式 |
| `evidenceCuration` | 整理证据提升可验证成功 | 证据冲突、复现型任务 | 证据覆盖、验证成功、整理调用数 | 已有候选因手工整理而延迟或 schema 循环 | 证据改为可选，不阻塞 verifier-ready candidate |
| `informationValue` | 价值排序提高有效动作比 | 选择空间大、探索任务 | 有效调用比、信息增益、成本 | 估计器忽略确定性捷径 | 对可验证候选设置最高优先级 |
| `compression` | 压缩降低上下文成本且保留决策事实 | 长上下文、恢复 | token、事实保持率、重放一致性 | 摘要丢失复现命令或证据来源 | 固定关键字段并做 prefix replay |
| `stopSuggestion` | 充分证据后停止降低尾部成本 | 有明确 verifier 的任务 | 候选到验证时延、尾部轮数、成功率 | 停止建议早于独立验证 | 仅把停止视作建议，Completion gate 固定保留 |

以下不是普通消融开关：独立 Verifier 与 Completion gate、工作区/权限隔离、凭据脱敏、代次 fencing、事件持久化与重放、答案防泄漏、超时/取消和硬成本预算。若要研究它们的影响，必须建立独立 fault-injection 安全回归，不与能力增益混淆。

## 3. 每次实验的必填记录

1. **快照与假设**：Experiment ID、Git revision、模型/Provider/思考等级、模型和策略指纹、语料哈希、预算、唯一主因素、对照和预期副作用。
2. **结果与护栏**：每例 verified/evidence-backed success、replay parity、Pass@k/Pass^k（有足够重复时）、成本、延迟、泄漏和越权事件。
3. **行为链**：首个工具、首个观察、首个候选和首个验证的时间；按 phase 的 Provider 请求、工具调用、重复调用、熔断/阻断和 Evidence 变化。
4. **首错归因**：记录第一个不正确或被环境阻断的边。类别必须区分模型推理、Harness 策略、工具/Schema、Provider、环境、Verifier、预算或数据集。
5. **比较解释**：成功样本说明哪些无效路径减少、为何成功仍保持证据与复放；失败样本说明可达正确路径、阻断点和反事实修复。
6. **闭环**：修复假设、最小回归 fixture、单元/集成测试、同配置复测 ID、可接受与拒绝标准。

## 4. 已登记案例

### AB-TERRA-MAX-RESPONSES-027：过度证据整理与验证交接回归

- 配置：AIHub `gpt-5.6-terra`，`openai-responses`，`thinkingLevel=max`；2 个 base64 control-plane fixture，两个策略变体，`maxTurns=4`。
- 表面结果：baseline `0/2`、35 requests、487194 tokens、约 `$0.2875`；candidate `0/2`、27 requests、334772 tokens、约 `$0.2493`，均以 `budget_exhausted` 结束。
- 行为证据：模型读取输入、通过 `bash` 得到正确候选，并在首个 `verify_claim` 已提供候选和可复现命令。首错不是解题，而是后续把 Artifact ID 误作 Evidence ID，并在宽 `evidence` schema 中混入其它 operation 字段；失败后继续手工整理与重复验证。
- Harness 根因：`PiCodingLane` 同时设置 `deferClaimAcceptance` 与 `continuousRecovery`，旧逻辑在后者存在时不终止当前 lane。外层 `SingleAgentCtfLoop` 因而无法马上调用 hidden scorer，正确候选被拖入无效循环。
- 修复：`verify_claim` 的 deferred proposal 一律返回 `terminate`；supporting evidence 保持可选并明确不得为调用 verifier 额外做人工整理；外层提示改为候选就绪即验证。
- 回归：`coding-resources.test.ts` 覆盖恢复模式下的 deferred handoff；TypeScript 检查通过。该变更是闭环正确性修复，不是某个策略因果消融结论。

### AB-TERRA-MAX-RESPONSES-028：交接修复后的真实流量复测

- 配置同上；真实 Provider telemetry 已确认，API、模型身份和 reasoning 请求均正常。
- 汇总：baseline `1/2`、8 requests、44535 tokens、`$0.071671`；candidate `1/2`、9 requests、46622 tokens、`$0.094238`。两变体都有一个 verified/evidence-backed 成功，且无答案泄漏；gate 仅因 smoke 门槛而通过。
- 成功轨迹：一个正常响应后，模型读取或解码输入，调用 `verify_claim`，外层 hidden scorer 完成两次独立复现并结束 Run。相较 027，请求数从每变体 27--35 次降至 8--9 次，证据整理不再成为验证前置条件。
- 失败轨迹：两条失败的第一条 Provider 请求均为 AIHub `502`，随后模型正常完成 `bash` 解码；此时没有模型逻辑错误。预算层却以 Harness 的大默认 completion 对失败请求保留成本，后续 verifier-ready turn 在请求前即被拒绝，最终记为 `budget_exhausted`。其中 candidate 还尝试了一次无效 `evidence` 调用，但并非首错。
- 修复：在 Provider 适配层把所有 Pi 请求的 completion 上限截断为 profile 的 `maxTokens`，并且截断发生在预算器之前。这样 HTTP 请求与最坏成本预留用同一上限；保留失败请求的保守收费、独立评分、成本 cap 与 deadline。
- 复测准则：同一语料、模型、思考等级、预算和变体重跑；检查 502 后仍能执行 `verify_claim`，以及每条失败是否被归为 Provider 或模型真实首错，而不是由错误预留造成的预算耗尽。

### AB-TERRA-MAX-RESPONSES-029：预算上限对齐后的复测

- 同配置重跑结果：baseline `2/2`，8 requests，90473 request-token totals，`$0.057193`；candidate `2/2`，7 requests，79020 request-token totals，`$0.059052`。四例均 evidence-backed、replay parity 为真、无答案泄漏、无 failure category。
- 行为链：三例为 `read -> bash -> verify_claim`，一例 candidate 直接 `bash -> verify_claim`；所有轨迹均在 RECON 第一轮提交候选，hidden scorer 完成两次 fixture reproduction 后终止。未出现 502、`evidence` 整理调用、schema 拒绝、无进展轮或 budget guard 拒绝。
- 机制结论：输出上限被正确传递到 Provider 与预算器，`028` 中“Provider 瞬时错误后可解答案被预算拦截”的链条不再重现。模型本身在该控制题上一直具备解题和复现能力；修复的是 Harness 的成本边界一致性与验证交接，不是提高模型推理能力。
- 变体解释：candidate 少 1 次模型请求、p95 用时低 `7847ms`，但总成本高 `$0.001859`，首次证据平均更慢（`7942.5ms` 对 `7110.5ms`）。两题各一次、均为 misc/base64，差异受随机采样影响，不能归因给 `firstAction`，更不能作为正式策略上线依据。
- 后续：保留该 fixture 为 Provider budget/hidden-scorer handoff 回归；策略因果实验转入 20+ holdout、3--5 attempts、含 Web/Pwn 的分层语料。

### AB-TERRA-IDALIB-MAGIC-021：逆向调查配额过严（待复测的 Harness 修复）

- 旧结果：`magic` 的 baseline 与 candidate 均为 `0/1`，但不能作为模型或策略比较。baseline 首先完成 ELF 初检、MCP 工具发现和接口描述；下一批 `strings` 与 `objdump` 在实际运行前被 `Phase action budget exhausted: RECON` 拒绝。candidate 的首错是 Provider `503`，同样不能与 baseline 对比。
- 更正归因：此前若把这一失败写作“模型没有完成逆向调查”是不准确的。直接原因是 Harness 把 reverse 复用为通用 `recon-surface(maxCalls=3)`；三次合理的初检/工具发现已耗尽 RECON，尚未允许一次实际 IDALIB 或反汇编分析。这是任务契约过严，不是需要模型克制的无效探索。
- 修复假设：reverse 使用专属的 `reverse-static-and-decompiler` 合同。首步和 RECON 各允许 8 次有界调用，且 RECON 成功标准要求获取目标相关的静态/反编译路径，明确规定“工具发现本身不充分”。其余类别保持原配额，运行总工具数、只读 MCP、独立 hidden scorer、成本和期限限制不变。
- 回归与复测：profile 单测锁定该预算和成功条件；随后以同一 `magic`、AIHub Terra max、同一预算重跑为新的 Harness 回归实验。该复测首先验证修复能抵达真实代码分析，不把单例成功率写成策略效果结论。

### AB-TERRA-IDALIB-MAGIC-031：工具暴露与提示合同不一致（中止，不计入样本）

- 配置与连通性：AIHub `gpt-5.6-terra`、`openai-responses`、`thinking=max` 经 GUI 同一代理预检成功，Provider metadata `200`；IDALIB MCP 的 `initialize` 也返回真实 `ida-pro-mcp#idalib`。因此本条记录不是密钥、模型权限或 MCP 进程不可用。
- 观察到的行为：baseline 完成 ELF64/x86-64 初检后，连续请求 `mcp_call list/describe`，并多次尝试宽泛 `evidence record` 参数；它没有执行实际 IDALIB `get_metadata`、`decompile_function` 或反汇编。为避免将无效循环继续计费，运行在 candidate 开始前被主动停止，故**没有**成功率、成本比较或策略结论。
- 首错归因：Harness 的系统提示声称已暴露 `mcp__<server>__<tool>` 一等工具并要求直接调用；该 Run 的实际 Provider tool surface 只有 `mcp_call`，没有任何 `mcp__*`。模型只好重新发现代理接口，而代理目录中并不存在它猜测的 `list_tools` / `initialize` 工具。此前的 3-call RECON 限制确实过严，已被 8-call reverse 合同修复；但该修复暴露了更早的“提示合同与可调用工具不一致”问题，不能把后续循环归咎为模型无效探索。
- 下一步修复：先让 reverse Run 在启动时验证并发布 IDALIB 的一等 schema；若枚举失败，则提示中只暴露已验证的 `mcp_call` 调用格式和一个预绑定 `get_metadata` 路径，禁止宣称不存在的 `mcp__*`。完成此修复后再建立新的不可变实验快照并复跑；`031` 保留为中止的环境/Harness 诊断记录。
- 已完成的最小修复：本机 IDALIB schema 已验证可枚举；筛选表补入其实际只读分析工具名（`get_metadata`、`decompile_function`、`disassemble_function`、`list_functions` 等），并有单测防止这些名称再次被全部筛掉。下一次复测仍须确认 Provider surface 中确实出现 `mcp__idalib-mcp__*`，然后才解释模型轨迹。

## 5. 执行顺序

1. 将 AB-TERRA-MAX-RESPONSES-029 的 Provider budget/hidden-scorer handoff fixture 固化为回归控制用例，并在 Provider 502、缺失 usage 与恢复路径上补充故障注入。
2. 在不少于 20 个不泄漏 holdout 用例、每例 3--5 次尝试并覆盖 Web/Pwn 前，依次做 `firstAction`、`duplicateFailure`、`circuitBreaker`、`evidenceCuration`、`contextSelection`、`recall`、`compression` 与 `informationValue` 单因素实验。
3. 每项先做 mechanism smoke，再做配对、交错的真实实验；按任务种类、上下文长度、证据冲突和恢复需求分层报告。
4. 只有重复结果同时满足 verified success、证据/复放护栏、成本和 p95 延迟约束，才可作功能有效或上线建议。

## 6. Harness 设计原则与后续复测

- Harness 的职责是提供**眼睛**（目标相关的只读工具与可观察输出）、**纸笔**（Artifact、Evidence、草稿与可回放事件）、**记忆**（有出处的检索、压缩与恢复）和**手**（经 scope、权限与 effect journal 约束的行动能力），而不是把预先猜测的调查顺序变成锁链。
- 因此 `firstAction`、`phaseRoute`、`actionBundle`、证据整理及相邻的重复/无进展提醒，默认均为可记录、可比较的建议。动作包计数耗尽仍会出现在 phase telemetry 中，但不会拒绝一项合法、在 scope 内且仍有总预算的实验。
- 硬边界保持不变：工作区与网络 scope、凭据隔离、generation fence、effect journal、用户取消、总成本/工具/提交额度、deadline、隐藏评分与答案防泄漏。它们拒绝时必须返回可操作反馈：触发原因、未执行的动作、已保留的状态，以及允许的替代路径或所需授权；不得只给出抽象的拒绝码。
- `hard_gate` / `hard_stop` 不再代表默认能力配置，只作为明确标记的消融对照。它们的作用是量化“锁链”是否真的带来收益，而不是把失败归因给模型。

### AB-TERRA-IDALIB-MAGIC-037/038：函数地址投影与评测账本恢复

- 036 的首错复核：两个变体都取得了 `list_functions` / `get_entry_points` 的真实结果，却没有一次 `decompile_function` 或 `disassemble_function`。原始运行时把 journal 中的 MCP observation 再次 JSON 化，函数列表可读性差且可能在 `main` 前截断；提示又只说“选择地址”，没有给出已验证的参数名。这是 Harness 的观察/手柄表达问题，不是应以硬门控限制模型的原因。
- 修复：保留 `<untrusted-observation>` 边界，但在内部渲染 MCP payload；从 `structuredContent` 投影最多四个小的候选（优先 `main`），附带已核对的调用形状：`decompile_function {"address":"..."}` 和 `disassemble_function {"start_address":"..."}`。候选只作为建议，不选择函数、不拒绝其他 scope 内工具。单元测试同时锁定未二次转义、候选地址和两个 schema 参数。
- 037 的第一次调用窗口中断后留下非终态 Run；其后 RETRY1 的两条真实轨迹都完成，且均进入反编译，但旧 ablation CLI 在全部 Provider 流量结束后才 claim ledger，导致这些轨迹无法成为正式 pairing。该批次保留为机制诊断，不计入比较。
- 账本修复：CLI 现在在任何 live Provider 请求前 claim 全部 immutable pairing；中途退出保留 `running`，操作者必须显式 `ablation resume` 才能标为 `unknown`。它拒绝把已终态与未执行 pairing 混在一次新运行中，避免重复计费和伪比较。
- 038（快照 `9f68f3a0…`）是修复后的正式单题复测：AIHub `gpt-5.6-terra` / Responses / max、同一 IDALIB 与 `magic`、两个变体各一次。Provider 均为 200，两个 ledger pairing 均完整落账为 failed / `EXHAUSTED`，且没有 `verify_claim`，所以没有 hidden-scorer 成功。
- 归因更正：`advice-curation` 的 `decompile_function=4` 不代表得到代码观察。Artifact 显示 IDALIB 每次返回 `Can't import PySide6 ... Qt without GUI`，其 MCP 内层 `isError=true`，但旧 Harness 将外层 effect 的 0 exit code 误报为成功。这是 headless IDALIB 环境/错误投影缺陷；`manual-curation` 则以 `bash=20`、`read=5` 为主，未选择一等反编译工具。二者均不能用于 curation 因果结论。
- 修复与 039 准则：MCP 内层 `isError` 现在会成为真实工具错误；Qt/PySide6 失败明确说明“未获得代码事实”，并建议同地址 `disassemble_function` 或受限本地静态分析，直到安装 headless-capable IDALIB。它不拒绝合法探索。039 先验证该失败不再被记为进展、模型能收到替代路径；只有反编译或反汇编产生真实代码 observation 后，才讨论从代码提取可验证事实。

### AB-TERRA-IDALIB-MAGIC-032：一等 IDALIB 已可达，Evidence 联合 schema 仍构成摩擦（中止，不计入样本）

- 配置：与 031 相同的 AIHub Terra Responses max、GUI 代理、`magic` 语料和只读 IDALIB MCP。
- 已确认行为：Provider surface 已出现 `mcp__idalib-mcp__get_metadata`；Terra 实际调用它并获得 `magic` 的真实 IDA 元数据。此结果验证了 031 的 schema 暴露修复，也证明模型并非只能在 MCP 目录循环。
- 首错归因：模型在每条 observation 后提交宽 `evidence` 联合 schema，并携带其他 operation 的已知字段；旧 `assertOnly` 将其拒绝，导致没有继续到 `list_functions` / `decompile_function`。这不是未知参数越权、模型缺乏逆向能力或 IDALIB 不可用，而是工具 schema 对常见 OpenAI-compatible 填充行为过度严格。
- 修复：在按 operation 校验前移除“已知但与该 operation 无关”的字段；未知字段和必填字段仍由严格 schema 校验。该变更保留证据工具的权威边界，却不把表达上的联合 schema 噪声变成调查中断。
- 下一步：提交该回归后，在解除首步/阶段硬阻断的默认 Harness 上建立 `033` 不可变快照，验证 `get_metadata -> list_functions/decompile_function -> verify_claim` 是否可完整抵达。单题只记录机制证据，不报告策略成功率结论。

### AB-TERRA-IDALIB-MAGIC-033：首步门控未实际触发，自动归档被误解为整理流程（已完成，非因果结论）

- 固定条件：AIHub `gpt-5.6-terra`、Responses/max、GUI 同一代理、IDALIB MCP、`magic` 二进制、4 个外层模型回合、双变体各 `$0.20` 的实验预算。预检 Provider `/models` 为 `200`；语料、模型、策略和预算的不可变快照指纹为 `8c70d704…`。
- 结果：默认 `soft-first-action` 与显式 `hard-first-action` 都是 `0/1` verified，均以 `budget_exhausted` / `No verified completion after 4 model turns` 结束，未到 hidden scorer。硬门控为 18 个 Provider `200`、36 次工具调用、21 次 `evidence`、2 次 `get_metadata`、各 1 次 `list_functions` / `list_strings`，成本 `$0.157363`；软建议为 22 个 Provider `200`、23 次工具调用、9 次 `evidence`、8 次重复 `get_metadata`，成本 `$0.154012`。
- 首错与可识别性：两条轨迹的首个 `bash/read/mcp__*` 都属于 reverse profile 的允许首步集合，因此硬门控**从未拒绝实际选择**。不能把两者的工具数或成本差异归因给 `firstAction`；差异更可能来自采样轨迹。该实验仍证实 032 的一等 MCP/schema 修复有效，因为两变体都实际调用了 IDALIB；但没有抵达 `decompile_function`。
- 机制归因：提示把“持久化 observation”写成了几乎逐步的流程要求，同时 evidence 工具描述过度强调其图整理能力。模型将自动归档误当作每步后需要调用 `evidence` 的手续。软建议样本减少了 Evidence 调用，却改为重复相同参数的 `get_metadata`；这说明缺口不是“缺少更多门控”，而是工具结果没有提供足够明确的、非阻断的下一步方向。
- 修复：prepared CTF 文案改为“自动归档，只有改变假设/解决冲突/支持验证时才提升为 Evidence”；reverse profile 明确建议 metadata 后转向函数列表、反编译或反汇编；同参数 IDALIB `get_metadata` 第二次及以后仍允许执行，但返回下一步建议和已有结果可复用提示。没有改变 workspace/network scope、凭据、effect journal、总成本、deadline 或 hidden scorer。
- 034 复测准则：固定同一 Provider、模型、二进制、预算和默认策略，比较修复前的 033 soft 轨迹与修复后的机制回归。接受条件不是单次 flag，而是：重复 metadata 不超过一次、Evidence 不作为每步确认、出现 `list_functions` 或 `decompile_function`，并保持无泄漏和隐藏评分边界；若仍失败，则依据新的第一处偏离继续修复。

### AB-TERRA-IDALIB-MAGIC-034：每配对预算不足的无效 curation 消融（已完成，不计入比较）

- 设置：`manual` 对 `advice`，唯一策略差异为 `evidenceCuration`，但总预算仅 `$0.12`、两个变体各两回合。
- 结果：每个变体只得到一次真实 Provider `200`，随后在没有 HTTP 请求和没有 token 花费的情况下结束。两条均 `budget_exhausted`，不能形成 curation 行为比较。
- 归因：实验预算按四个配对分配。第一次请求实际只花约 `$0.012`，但下一请求的最大输出/上下文预留超过该配对剩余额度；这是预检估计“最多请求数”与实际多步最坏情况预留不相称，不是模型拒绝整理建议。
- 处置：创建新 immutable `035`，固定所有条件但把总预算恢复到已验证可容纳多步的 `$0.40`。034 保留为 evaluator budget 配置诊断，禁止加入成功率或策略比较图。

### AB-TERRA-IDALIB-MAGIC-035：Curation 因子多步烟测与函数级停滞（已完成，非泛化结论）

- 固定条件：同一 Terra Responses/max、IDALIB、二进制、4 回合与 `$0.40`；`manual-curation` 为默认基线，`advice-curation` 只将 `evidenceCuration` 改为 `advice`。两者均 `0/1` verified、无隐藏评分调用、以 `budget_exhausted` 结束。
- 过程：`advice` 使用 14 次 Provider `200`、21 次工具调用、6 次 Evidence、2 次 metadata、2 次 `list_functions`、3 次入口点查询、成本 `$0.102277`；`manual` 使用 13 次 Provider `200`、19 次工具调用、7 次 Evidence、3 次 metadata、2 次 `list_functions`、1 次入口点查询、成本 `$0.154495`。两者都比 033 soft 的“8 次 metadata、无函数列表”推进到函数/入口目录。
- 解释边界：成本差 `$0.052218` 和一次 Evidence/metadata 差异来自各一次随机采样，不能宣称 curation advice 更好；但两变体共享的新行为（函数列表和入口点）与 033 相比符合新提示和 metadata feedback 的预期。共同第一处未完成边是：已经得到函数地址清单，却没有执行 `decompile_function` 或 `disassemble_function`，所以还没有目标相关代码路径。
- 修复与后续：首次 `list_functions` / `get_entry_points` 现在返回非阻断提示，要求从结果选择 `main`、入口或检查函数地址进入反编译/反汇编；重复 inventory 说明无新代码事实并保留调用能力。`036` 应固定 035 的配置和 corpus，以该修复后的 Harness 复测；首要接受条件是一次函数级代码分析，而不是单次 flag。对 curation 的因果比较仍需 20+ 分层 holdout、3--5 attempts。

### AB-TERRA-IDALIB-MAGIC-036：函数级文字建议未被真实轨迹采纳（已完成，反证）

- 固定 035 的配置和 curation 单因素设计，仅加入 035 后的函数级 IDALIB advice。`advice-curation` 产生 20 次 Provider `200`、28 次工具调用；`manual-curation` 产生 16 次 Provider `200`、37 次工具调用。两者均为 `0/1` verified、`budget_exhausted`，且 `decompile_function=0`、`disassemble_function=0`。
- 结论：函数列表/入口点后附加“请选择地址进入反编译”的文字建议具有单元合同覆盖，但没有驱动 Terra 在本题执行函数级工具，不能写作 Harness 能力提升；这也说明不能用更多强制语气取代可操作的工具支架。
- 后续修复假设：在只读、安全的 IDALIB 结果中投影有限、结构化的候选函数地址和一键对应的反编译工具输入，使模型不必自行从大清单中完成地址选择；同时保留模型可改选其它函数的自由。该设计需要单元 fixture、隐藏评分回归和新的 immutable 037 快照验证。
