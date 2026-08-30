# Skill Registry

```json component-metadata
{
  "id": "materials-skills",
  "name": "Skill Registry",
  "version": "0.1.2",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-28T16:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-28T16:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-28T16:00:00.000Z",
    "sourceHash": "dc746b882d2f1a43b3c24cf57b7b24b4451efd66d6a17ed5d02407329f21cdbb",
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

```powershell
node --import tsx --test packages/materials/tests/skills.test.ts
```
