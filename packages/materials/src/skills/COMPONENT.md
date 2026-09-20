# Skill Registry

```json component-metadata
{
  "id": "materials-skills",
  "name": "Skill Registry",
  "version": "0.1.3",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-09-19T10:40:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 3,
    "securityAuditCount": 3,
    "lastBugAuditAt": "2026-09-19T10:40:00.000Z",
    "lastSecurityAuditAt": "2026-09-19T10:40:00.000Z",
    "sourceHash": "a376e4a827252601bb579f3996e38a3c2c458b007b8549d2327741c3da54c250",
    "result": "passed"
  }
}
```

## 职责

发现、验证、去重并哈希项目级 `skills/<name>/SKILL.md`。主上下文只保留元数据，正文通过 `load_skill` 或 Pi 原生 Skill turn 按需加载。

## 入口与边界

- `registry.ts` 负责发现、Pi 校验、内容读取和资源投影。
- Skill 提供过程知识，不直接写 Control Store 或执行副作用。
- 会话级启用集合由应用层传给 Runtime。

## 开发规则与验证

名称、描述和内容哈希必须稳定；无效或重名 Skill 不进入目录。Skill 自演化进入项目之前应有独立评测结果。

`ProofBladeSkillRegistry.load()` 按**结构性 revision** 记忆化：revision 由各 Skill 根下所有 `SKILL.md` 的路径、大小与 mtime 组成，用一个目录遍历得到，不读取任何文件正文。命中时直接返回上次解析的 registry 实例，**不再重新解析 front matter**（本仓库实测约 30ms/次，而 version snapshot 与每次 lane 创建都会加载它）。

返回共享实例是安全的：registry 字段均为 `readonly`，`list()`/`piSkills()` 返回副本，`diagnostics` 在构造期填充、消费方不修改。`load()` 的缓存键是「规范化项目根 + 目录列表」，因此不同项目根或不同 `skillsDirs` 不会互相串用。`cacheStats()` 与 `resetCache()` 供测试与诊断使用——缓存行为必须能用计数器断言，不得依赖耗时断言（共享 runner 上不稳定）。

```powershell
node --import tsx --test packages/materials/tests/skills.test.ts packages/materials/tests/skill-registry-cache.test.ts
```
