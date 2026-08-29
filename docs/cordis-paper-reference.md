# Cordis 论文参考借鉴与 ProofBlade 落地分析

> 文档版本：1.0.0
> 编写日期：2026-08-14
> 论文：[A Programming Paradigm for Spatiotemporal Composability](https://github.com/cordiverse/paper)
> 参考 PDF：`tmp/cordiverse-paper-review/repo/paper.pdf`
> 参考提交：`948a07b369c62adb3b12e102458be5c18dfb69b9`
> 论文状态：2026-08-13 草稿，作者明确说明仍在修订
> 文档性质：参考借鉴，不代表论文结论已经成为 ProofBlade 的实现

## 1. 先说结论

Cordiverse 的论文《A Programming Paradigm for Spatiotemporal Composability》研究的是动态组合的两个正交问题：

- **时间可组合性（temporal composability）**：组件卸载时，能够完整、安全地撤销它对共享环境造成的修改；
- **空间可组合性（spatial composability）**：组件能够声明、发现和解析依赖，并在依赖出现、消失或替换时正确改变状态。

论文把二者提升为运行时机制：

- 每个环境变更携带可执行的逆操作，称为 **revertible effect**；
- 每个组件声明所需依赖，依赖满足状态变化会触发组件激活或停用，称为 **reactive coeffect**；
- 效果上下文和依赖上下文统一为一个可操作的 Context；
- 通过组件生命周期演算证明组合后的保持性、进展性、时间可组合性、空间可组合性和汇合性；
- 在 Cordis 中实现效果跟踪、依赖解析、配置协调和 HMR。

对 ProofBlade 最有价值的不是照搬 Cordis，也不是立即采用论文的完整演算，而是把下面三条变成工程不变量：

1. **所有动态注册和副作用必须有同一生命周期内的撤销句柄**；
2. **依赖状态变化必须经过统一解析器，并通知受影响的消费者**；
3. **卸载、替换和失败必须有中间状态、顺序约束和可恢复记录**。

这三条能直接改善 ProofBlade 当前的 MCP/Skill 注册、Capability Backend 切换、后台 Job、Context 维护和未来 Sandbox 生命周期。

## 2. 论文贡献结构

### 2.1 时间可组合性

论文将一个效果抽象为：

```text
context -> (newContext, inverse)
```

效果执行时改变 Context，同时把 inverse 放入运行时维护的累加器。多个效果按正向顺序执行，逆操作按相反顺序累积，卸载时统一恢复。

这个抽象解决了普通 `deactivate()` 的两个问题：

- 创建资源和销毁资源分散在两个函数，难以检查是否一一对应；
- 组件执行多个异步或迭代效果时，无法可靠知道已执行到哪一步。

论文进一步允许效果以 iterator 形式逐步产生 inverse，并在每个迭代边界检查组件是否仍然有效。因此，部分完成的加载也能部分回滚，而不是只有全成功或全失败两种状态。

### 2.2 空间可组合性

组件通过 coeffect specification 声明依赖键集合。Context 的依赖表发生变化时，运行时根据满足状态分类：

```text
not satisfied -> satisfied       activating
satisfied     -> not satisfied   deactivating
otherwise                         neutral
```

组件只有在依赖满足时才激活。提供者被撤销时，依赖它的消费者必须先停用，提供者最后才删除绑定并执行自身 inverse。

这比“启动时按顺序 import 模块”更适合动态系统，因为 Provider 可以运行中出现、消失、换版本或切换来源。

### 2.3 统一 Context

论文将：

- 共享状态、注册表、资源和配置变化；
- 依赖声明、隔离范围和拦截元数据；

放入同一个 Context 范式。Context 既是效果作用对象，也是依赖解析的依据。论文还区分：

- **in-place realization**：原地修改 Context，并保存真正的 inverse；
- **derived realization**：派生一个子 Context，父 Context 不变，销毁子 Context 即可撤销局部变化。

这一区分对 ProofBlade 很重要：Control Store 的权威状态不能被随意派生，但 Planner、Executor、Curator、MCP 会话和测试 fixture 可以使用派生 Scope。

## 3. 论文最值得吸收的运行时机制

### 3.1 Effect 必须在创建点获得 inverse

Cordis 的 `ctx.effect` 在注册或修改环境的同一段代码中收集 inverse，并返回 dispose。工程含义是：

```ts
const dispose = await scope.effect(async function* () {
  yield registerTool(tool);       // 产生撤销注册的 inverse
  yield subscribe(event, handler); // 产生取消订阅的 inverse
  yield openTransport(mcp);       // 产生关闭 transport 的 inverse
});
```

ProofBlade 现有 `Effect Journal` 记录业务副作用，但许多进程内注册仍可能依赖手写 cleanup。建议把 `Registry.register`、`EventBus.on`、`McpTransport.open`、`JobScheduler.schedule` 统一改为返回 `Disposable`，并由 Scope 自动持有。

### 3.2 LIFO 不是全部，依赖顺序也必须保留

单一组件内的 inverse 通常按 LIFO 执行，但跨组件卸载不能只按注册顺序倒放。论文引入“依赖仍被使用时暂缓提供者撤销”的 guard：

1. 先把 Provider 标记为 unloading，不再接受新的依赖绑定；
2. 让依赖它的 Consumer 进入 deactivating；
3. Consumer 完成 teardown 后，Provider 才删除绑定和执行 inverse；
4. 若存在中间状态，运行时保留旧 committed view，保证 Consumer 的 teardown 仍可访问旧依赖。

ProofBlade 的 MCP、Provider Resolver 和 Sandbox 都需要这个顺序。直接先删 Provider 再通知 Consumer，会导致取消、保存证据或关闭连接时拿不到原服务。

### 3.3 Reactive coeffect 的关键是“变化通知”，不是观察轮询

论文要求所有 Context 变化都经过可识别的 effect 边界，因此运行时能在变化发生时计算哪些依赖规格受到影响。它不建议每个组件定时查询“依赖现在还在不在”。

ProofBlade 的落地方式：

- Registry mutation 产生 typed `capability/changed` 事件；
- Resolver 用前后 provider identity/version 计算影响集；
- 受影响的 Lane 或 Job 收到 activating/deactivating/reloading；
- 事件进入审计日志，能够解释为何发生重新解析；
- 未声明依赖的读取直接失败，而不是返回 `undefined` 后让错误延迟出现。

### 3.4 Provider identity 必须独立于 Provider value

论文在实现中用永不复用的 fiber UID 识别 Provider，而不是比较 Provider 返回的值。这样即使新旧 Provider 返回相同内容，替换仍然会触发消费者重新加载。

ProofBlade 应将以下字段视为绑定身份：

```text
providerId + providerVersion + registrationId + scopeId
```

不要只比较 `backendId` 或 capability 的最终结果。否则 MCP 服务重启、模型切换、工具实现替换后，消费者可能错误地继续使用旧连接。

### 3.5 Isolation 与 Interception 是两个不同问题

论文明确区分：

- **Isolation**：同一个依赖键在不同 Context/租户/测试环境解析为不同 Provider；
- **Interception**：不改变依赖值，在访问时附加权限、审计、限流或路径约束元数据。

对 ProofBlade 的对应：

- Project、Run、Planner/Executor Lane 应能为同一 capability 使用不同 backend 或 fixture；
- 审计、预算、只读/读写、工作目录和 secret redaction 应通过 interception metadata 注入，而不是复制一套 Tool。

这支持用户要求的多中转站、模型切换、工作目录和动态调试，同时保持模型可见 Tool Schema 稳定。

### 3.6 服务 Broker 比消费者频繁换 Provider 更稳定

论文讨论两种多 Provider 方式：

- exclusive binding：任一时刻只绑定一个 Provider，切换会扰动所有 Consumer；
- service broker：Broker 始终稳定，多个 Provider 注册到 Broker，由 Broker 进行路由。

ProofBlade 的 `CapabilityRouter` 应优先采用第二种：

```text
Consumer -> stable CapabilityRouter -> Provider set
                                  -> local / MCP / remote / fixture
```

这样模型和上层组件依赖的是稳定 capability，不会因 Provider 轮换而改变 Tool Schema 或上下文前缀。Router 可以按显式 backendId、优先级、负载、延迟、可用性和预算选择 Provider。

### 3.7 生命周期必须区分 Loading、Active、Unloading、Inactive

论文把真实运行时的非原子过程显式建模为：

```text
INACTIVE -> RELOADING -> ACTIVE -> UNLOADING -> INACTIVE
```

并保留失败结果。它还讨论了：

- 异步加载尚未完成时配置再次变化；
- 迭代效果只执行了一部分；
- 一个变更触发另一个变更；
- inverse 执行失败；
- Provider 正在卸载但 Consumer 仍需旧依赖完成 teardown。

ProofBlade 当前 `PROPOSED/STARTED/FINISHED` 适合业务 Effect，但能力和组件层还需要更细粒度状态：

```text
REGISTERING
ACTIVE
RELOADING
QUIESCING
UNREGISTERING
INACTIVE
FAILED
```

这些状态必须进入 Control Store 或对应的运行时日志，否则 GUI 只能显示“调用失败”，无法解释失败发生在注册、解析、执行还是撤销。

## 4. 论文形式化保证对 ProofBlade 的工程翻译

论文的定理不能直接等同于 ProofBlade 的测试通过，但可以转化为可检查的不变量。

| 论文保证 | ProofBlade 工程翻译 | 验收方式 |
| --- | --- | --- |
| Preservation | 每次 Registry/Effect 变化后，状态仍符合类型与生命周期约束 | 状态机属性测试、重放测试 |
| Temporal composability | Scope 释放后，不残留注册、监听、进程、连接或临时文件 | 故障注入 + 资源清单对比 |
| Spatial composability | Consumer 只在依赖满足时激活，Provider 变化能触发准确重解析 | Provider 加载/替换/移除矩阵 |
| Progress | 有效配置最终进入稳定状态；不可满足依赖进入明确失败或等待 | 无进展检测、超时、依赖图检查 |
| Confluence | 同一最终配置，不论中间变更顺序，最终投影一致 | 随机变更序列与冷启动对比 |

### 4.1 不应追求无条件的“完整回滚”

论文的 revertible effect 假设 inverse 正确，且可恢复原 Context。现实中以下操作可能不可逆：

- 已经发送到外部 API 的请求；
- 已经写入远端数据库的记录；
- 已经提交的 CTF 答案；
- 已经泄露到 Provider 的敏感数据；
- 已经改变的外部 ECU/设备状态。

ProofBlade 应把论文的逆操作模型与现有 Effect Policy 合并：

```text
READ_ONLY       -> 可直接回放
LOCAL_REVERSIBLE -> 保存 inverse，卸载时执行
COMPENSATABLE    -> 保存补偿动作和人工确认边界
IRREVERSIBLE     -> fail-closed，执行前确认，执行后只记录事实
```

论文提供的是“逆操作必须被显式表达”的原则，不是外部副作用可以神奇回滚的承诺。

### 4.2 失败必须是生命周期结果，而不是普通异常

论文把失败纳入组件状态并继续参与依赖解析。ProofBlade 应避免把异常直接丢给最外层：

- Provider 加载失败：Consumer 不得误激活；
- Consumer 激活失败：Provider 不应被误判为未使用；
- inverse 失败：保留 `UNLOADING/FAILED` 和重试信息；
- 部分迭代失败：只恢复已确认完成的效果；
- 依赖循环：在配置加载前报告，而不是运行后超时。

## 5. Cordis 实现与 ProofBlade 的对应

### 5.1 Fiber 对应 Scope + Runtime Instance

Cordis 每个组件实例都有 fiber，fiber 保存：

- 父子关系；
- 已声明的 coeffects；
- 已提交的 Provider view；
- 已执行效果的 inverse 累加器；
- 生命周期状态和错误结果。

ProofBlade 不必复制 fiber 数据结构，但可以把对应职责拆成：

- `RunScope` / `LaneScope`：父子生命周期；
- `RegistrationHandle`：Provider view；
- `EffectJournal`：副作用记录和恢复策略；
- `CapabilityBinding`：解析出来的 provider identity/version；
- `RuntimeState`：运行中状态和错误。

### 5.2 Proxy 访问对应声明式 capability access

Cordis 的 Proxy 访问会检查当前组件是否声明了依赖，未声明或未激活时直接抛出错误。ProofBlade 可以不使用 Proxy，但应保留语义：

- Capability Consumer 声明需要的 capability 和 operation；
- Resolver 只返回允许范围内的 binding；
- 未声明访问、越过 Project/Run 边界或使用已撤销 Provider 时 fail-closed；
- 访问记录写入 Tool/Effect 审计对象。

### 5.3 Declarative Configuration 对应 ProofBlade 配置解析

Cordis loader 把持久化配置当成权威记录，并对 `id`、`url`、`isolate`、`intercept`、`config`、`disabled` 分别采用最小变更策略。ProofBlade 的 Provider、模型和中转站配置可以借鉴这种字段级 reconciliation：

- `providerId/model` 变化：重建或切换 Lane；
- `baseUrl/keyRef` 变化：重建 Provider，但不改变模型可见 Tool Catalog；
- `workspace` 变化：只更新 Scope/路径策略；
- `enabled` 变化：激活或停用 MCP/Skill；
- `routingPolicy` 变化：更新 Router，不重建 Consumer；
- `toolContract` 变化：必须重新生成 Catalog hash，并显式刷新缓存纪元。

### 5.4 HMR 对应配置热更新，而非直接热替换业务代码

Cordis HMR 用依赖图分类 changed、accepted 和 declined 模块，无法安全接受的变更回退到完整重启。ProofBlade 当前更需要“运行时能力热更新”：

- Provider 实例更新；
- MCP transport 重连；
- Skill registry 刷新；
- 配置 patch reconciliation；
- GUI 中暂停后恢复。

二进制逆向、原生库或不受控脚本仍应使用 Sandbox/子进程边界，不要仅凭 TypeScript 的 dispose 认为已经隔离。

## 6. 对 ProofBlade 当前设计的具体建议

### P0：把可逆注册扩展到所有运行时资源

建立一个最小接口：

```ts
export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface ScopedEffect<T> extends Disposable {
  readonly effectId: string;
  readonly value: T;
  readonly policy: "read-only" | "reversible" | "compensatable" | "irreversible";
}
```

下列 API 必须返回或接受 `Disposable`：

- `capabilityRouter.registerBackend`；
- `mcpRegistry.connect`；
- `skillRegistry.enable`；
- `eventBus.subscribe`；
- `backgroundRunner.enqueue`；
- `telemetry.attach`；
- `sandbox.start`；
- `modelProvider.openSession`。

### P0：记录 Provider binding identity

每次 Capability invoke 保存：

```text
capabilityId
operation
providerId
providerVersion
registrationId
scopeId
contractHash
resolutionReason
```

执行前后都校验 binding。配置在执行期间发生变化时，当前调用保留原绑定，新调用使用新绑定；禁止一次调用中途静默切换 Provider。

### P0：增加依赖变化事件

建议事件：

```text
capability/registered
capability/available
capability/unavailable
capability/reloading
capability/unregistered
capability/consumer_activated
capability/consumer_deactivating
capability/consumer_failed
```

这些事件应关联 `runId`、`laneId`、`providerId` 和 `registrationId`，并进入 GUI 调试时间线。

### P1：引入配置 reconciliation

增加一个纯函数：

```ts
reconcileRuntimeConfig(previous, desired) -> {
  operations,
  unchanged,
  reload,
  dispose,
  warnings,
}
```

它先输出计划，再由 Runtime 执行。GUI 可以显示“为什么要重启 MCP、为什么模型切换只影响 Executor、为什么 Tool Catalog 没有变化”，而不是直接改变全局状态。

### P1：补充隔离和拦截元数据

把以下字段放到 Scope/Context 元数据而不是复制工具：

- `projectId`、`runId`、`laneId`；
- `workspaceRoot`；
- read-only/read-write；
- allowedPaths；
- network policy；
- budget and timeout；
- redaction profile；
- evidence/artifact policy。

Capability Provider 接收的是已经解析和限制过的 `ExecutionContext`，不能自行读取全局配置绕过限制。

### P1：补生命周期中间状态和孤儿恢复

所有需要异步等待的能力都要能表达：

```text
REGISTERING -> ACTIVE
ACTIVE -> QUIESCING -> UNREGISTERING -> INACTIVE
任何阶段 -> FAILED
```

进程重启后扫描未完成操作：MCP 关闭残留、后台 Job、Compaction、Evidence curation、Sandbox 和模型请求。恢复器必须给出明确动作：继续、重试、补偿、人工确认或终止。

### P2：为依赖图增加静态检查

在注册前检查：

- capability key 是否命名空间化；
- contract version 是否满足；
- provider/consumer 是否形成循环；
- required operation 是否被 Provider 声明；
- Scope 是否越过允许的父子边界；
- 是否存在同 priority 且无法稳定排序的 Provider。

检查结果写入开发报告，而不是等到真实模型调用时才暴露。

## 7. 与缓存、上下文和证据链的关系

Cordis 论文不直接讨论 LLM token cache，但它对 ProofBlade 的缓存问题有一个重要启发：**动态依赖和副作用必须有稳定的边界**。

建议将上下文编译拆为：

```text
Stable Context
  = system prompt
  + fixed capability proxy schemas
  + provider protocol contract
  + scope policy hash

Dynamic Context
  = current messages
  + capability availability summary
  + evidence forest projection
  + artifacts/spill previews
  + lifecycle changes
```

Provider 的替换、MCP 重连或 Evidence Tree 更新只应改变动态部分，除非 Tool Contract 或权限策略真的变化。这样既满足论文的依赖反应，又不会因每次能力变化重写整个模型前缀。

Evidence Forest 可以采用类似 Fiber 的关系：

- Evidence node 是可复用的事实或结论；
- Tree projection 是某个 Run/Lane 的 committed view；
- Curator 是生成或更新 projection 的 Consumer；
- Artifact/Tool 变化触发受影响树重新评估；
- 旧 projection 在新 projection 提交前继续可读；
- 新 projection 失败时，保留旧版本，不产生伪完成。

## 8. 不应直接照搬论文的部分

### 8.1 论文是形式化草稿，不是性能和可靠性基准

当前仓库 README 明确写明论文处于 active revision。论文证明依赖模型假设，例如 inverse 满足恢复关系、所有变化都经过 Context、组件边界足够清晰。ProofBlade 仍需用故障注入、真实 MCP、Provider 429、取消和崩溃测试验证工程行为。

### 8.2 不把所有动态状态放入一个 Context

论文的统一 Context 是理论范式。ProofBlade 仍应保持：

- Pi Session：模型可见历史和请求纪元；
- CTF Control Store：任务、阶段、证据、效果和完成状态；
- Artifact/Spill：完整文件和大结果；
- GUI telemetry：观察投影。

统一的是生命周期和事件关联方式，不是把所有权威数据合并到一个对象。

### 8.3 不用语言级代理代替真正沙箱

论文也明确指出，Context/Proxy 访问控制不能阻止不受信任代码直接访问宿主环境。ProofBlade 的 native reverse、脚本和外部工具必须使用子进程、独立运行时或操作系统 Sandbox，能力代理只负责最小权限桥接。

### 8.4 不为了理论完备拆出过多组件

论文承认细粒度拆分可能产生二次方级 integration component，并建议用 bundle、约定 wiring 和 scaffold 工具降低认知负担。ProofBlade 仍应遵守依赖漏斗：只有存在独立契约、生命周期或测试边界时才新增组件。

## 9. 建议测试矩阵

### 9.1 时间维度

- 注册 Tool、MCP、Skill、事件监听和定时任务后 dispose，所有注册和句柄归零；
- 多步异步加载在第二步失败，第一步 inverse 被执行；
- 同一资源重复 dispose 不产生二次副作用；
- Provider unloading 时 Consumer 能完成 teardown；
- 进程在 REGISTERING、QUIESCING、UNREGISTERING 各阶段终止，重启后都能收敛；
- 不可逆 Effect 在执行前被正确拦截或要求确认。

### 9.2 空间维度

- Provider 先加载，Consumer 后加载，Consumer 自动激活；
- Consumer 先加载，依赖缺失时保持等待或明确失败；
- Provider 替换为新 registrationId，Consumer 重新绑定；
- Provider 变为 unavailable，Consumer 收到 deactivating；
- 两个 Provider 同时可用，Broker 按策略稳定选择；
- 循环依赖在加载前报告，并带完整依赖路径；
- 不同 Project/Run/Lane 对同一 key 使用隔离值。

### 9.3 汇合与重放

- 对同一最终配置随机生成不同加载/卸载顺序，最终 Registry/Scope/Projection 相同；
- 从 Effect Journal 和生命周期事件重建当前状态；
- GUI 展示的 Provider、工具、证据和上下文状态都能追溯到事件序号；
- 缓存相关的 stable prefix hash 在 Provider 动态变化时只在契约或策略实际变化时改变。

## 10. 推荐实施顺序

```text
1. Disposable + Scope 统一接口
2. Provider binding identity/version
3. capability changed 事件与 GUI 时间线
4. Provider/Consumer 依赖和循环检查
5. 异步生命周期中间状态与孤儿扫描
6. 配置 reconciliation 与最终配置投影
7. Isolation/interception metadata
8. Broker 路由和 rolling provider update
9. Sandbox bridge 与不受信任能力隔离
10. 将上述不变量接入 replay、eval 和故障注入
```

对应现有 ProofBlade 计划：

| 计划 | Cordis 论文启发 |
| --- | --- |
| PLAN-100 | Tool/Artifact 的可逆和不可逆边界，完整结果与预览分离 |
| PLAN-110 | Phase/Guard 的依赖激活、停用和失败状态 |
| PLAN-120 | Provider identity、Broker、配置 reconciliation、预算拦截 |
| PLAN-130 | Scope、Sandbox、异步卸载、孤儿恢复 |
| PLAN-200 | Effect/Session 事件重放、汇合性和影子评测 |
| PLAN-210 | Planner/Executor 的独立 Lane、能力过滤和父子生命周期 |

## 11. 完成判定

ProofBlade 吸收 Cordis 论文经验的最低完成标准是：

- 每个动态注册都有可追踪、幂等的撤销句柄；
- Provider 替换不会让 Consumer 静默使用旧 binding；
- 依赖变化触发确定性的激活、停用或等待；
- Consumer teardown 完成前，Provider 的旧视图仍可用；
- 异步失败和进程重启后不会产生伪激活或伪完成；
- 配置变更按字段进行最小化 reconciliation；
- Scope 隔离、权限拦截和真实 Sandbox 各司其职；
- 事件日志能够解释注册、解析、切换、撤销和恢复全过程；
- 这些约束通过 replay、故障注入、依赖图和资源泄漏测试。

## 12. 参考资料

- [Cordiverse paper repository](https://github.com/cordiverse/paper)
- [Paper README](https://github.com/cordiverse/paper/blob/main/README.md)
- [Paper PDF](https://github.com/cordiverse/paper/blob/main/paper.pdf)
- [ProofBlade architecture](./architecture.md)
- [ProofBlade tool contract](./tool-contract.md)
- [ProofBlade extensions](./extensions.md)
- [ProofBlade recovery](./recovery.md)
- [DeepSeek Harness reference](./deepseek-harness-reference.md)
