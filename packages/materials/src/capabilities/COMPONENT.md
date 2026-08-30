# Capability Catalog and Router

```json component-metadata
{
  "id": "materials-capabilities",
  "name": "Capability Catalog and Router",
  "version": "0.2.8",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 6,
    "securityAuditCount": 6,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "4d964195aa186bdfcb0a1b1f2946a172f00474043af06d9111886fbdc3b4e460",
    "result": "passed"
  }
}
```

## 职责

维护稳定的逻辑能力目录，并把固定 `invoke_capability` 请求解析到可替换 Backend，再通过 Effect Journal 执行和留痕。

## 入口与边界

- `catalog.ts` 生成规范化 manifest 与哈希。
- `backend.ts` 定义 Backend/Resolver 契约，按优先级和稳定 ID 选择当前可用实现。
- `router.ts` 校验 capability、operation、参数键和 replay policy，并记录完整 Backend 来源。
- `router.ts` 还提供确定性 Discovery：按 capability/operation 稳定排序，默认只返回精简描述和逐操作 Backend 候选，只有显式 describe 才携带完整参数 Schema；Discovery 不连接、不执行也不写 Effect。
- Provider 只看到逻辑 capability，不直接看到 bundled、MCP、本地进程或 provider-native 的重复语义工具。
- 未显式绑定时只允许在执行前跳过不可用 Backend；一旦选定并开始执行，失败不得静默切换实现。
- MCP Backend 按具体 capability 对应的 server 状态判断可用性；连接失败的 server 会被 Resolver 跳过，允许同一逻辑能力使用备用实现。
- MCP Backend 的状态版本与 Job 绑定版本均使用 `catalogHash`，外部状态投影可以直接用于恢复绑定校验。
- MCP 分发器调用按内层 Tool 动态解析策略，前台 Effect 与后台 Job 使用同一结果。
- `proofblade.binary` 的 deep reverse 操作由本地 Rizin 或配置的 MCP reverse adapter 提供；Resolver 只在执行前按可用性回退。
- `functions`、`disassemble` 和 `xrefs` 输出统一规范化、排序并受数量上限约束，Backend 来源和版本进入 Effect/Job 绑定。
- Router 为后台 Job 生成统一的安全持久化参数计划，原始调用参数不进入 Control Store。
- 内层敏感级别为 `secret` 时，Router 必须把分类传给 Effect Journal，确保结果 Artifact 不会降级为 `public`。
- Provider 只看到固定代理 Schema；完整能力细节按需获取。
- Backend 候选诊断必须复用 Resolver 的优先级和 availability 判定；只能有一个首选项，不可用原因对模型可见，但不得泄漏宿主绝对工具路径或秘密配置。

## 开发规则与验证

能力 ID、操作顺序和 canonical JSON 属于缓存及行为契约。Backend ID、优先级和版本也属于恢复契约；新增操作要同步 Tool Contract、Effect 策略和快照测试。

```powershell
npm run test:materials
```
