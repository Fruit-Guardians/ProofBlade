# Skill Registry

```json component-metadata
{
  "id": "materials-skills",
  "name": "Skill Registry",
  "version": "0.1.4",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-09-22T12:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 4,
    "securityAuditCount": 4,
    "lastBugAuditAt": "2026-09-22T12:00:00.000Z",
    "lastSecurityAuditAt": "2026-09-22T12:00:00.000Z",
    "sourceHash": "d1a4084be299690d13bb9ee056830cedb4e42d23276fe496d0c34d1a32d466e8",
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

`ProofBladeSkillRegistry.load()` 按**结构性 revision** 记忆化：revision 由一次目录遍历得到，每个**输入文件**贡献 `路径 \0 ino \0 size \0 mtimeMs \0 ctimeMs`，**不读取任何文件正文**。输入集合就是 loader 会读的那一组：每个根的 `SKILL.md`、每个根的直系 `*.md`（上游 loader 对每个根都传 `includeRootFiles`，这些文件会产出 `invalid_metadata` 诊断并进入 `registry.diagnostics`，因此它们**是**输入，即使注册表随后会丢弃它们对应的 skill）、以及 `.gitignore`/`.ignore`/`.fdignore`（保守包含规则文件本身，不重写 `ignore` 匹配器）。按 loader 的规则剪枝隐藏目录与 `node_modules`，并跟随目录符号链接——后者需要一个 visited 集合，否则指回上层的链接会一路递归到路径长度上限。命中时直接返回上次解析的 registry 实例，**不再重新解析 front matter**（本仓库实测约 30ms/次，而 version snapshot 与每次 lane 创建都会加载它）。revision 在解析**之后**重新采样一次再入缓存，避免存入一份早于其内容的 revision。

返回共享实例是安全的：registry 字段均为 `readonly`，`list()`/`piSkills()` 返回副本，`diagnostics` 在构造期填充、消费方不修改。`load()` 的缓存键是「规范化项目根 + 目录列表」，因此不同项目根或不同 `skillsDirs` 不会互相串用。`cacheStats()` 与 `resetCache()` 供测试与诊断使用——缓存行为必须能用计数器断言，不得依赖耗时断言（共享 runner 上不稳定）。

```powershell
node --import tsx --test packages/materials/tests/skills.test.ts packages/materials/tests/skill-registry-cache.test.ts
```
