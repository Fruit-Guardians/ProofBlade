# 函数索引、注释生成与重复实现防护方案

## 1. 结论

建议增加这项能力，但不要把它设计成“扫描所有函数后自动重构代码”。推荐建设一个**同时服务人类和 AI 的确定性 API 索引与重复实现检测工具链**：

1. 源代码中的 TSDoc 注释是唯一事实来源。
2. 索引文件由 TypeScript AST 和 Type Checker 自动生成，禁止人工编辑。
3. 先索引原子层的公共导出，再逐层扩展到 molecules、materials 和 apps。
4. 同时为人类开发者提供 Markdown 文档，为 AI 编码代理提供开发前检索、开发中复用、开发后复查的机器可读入口。
5. 重复检测输出候选报告；AI 发现重复后优先复用或修改已有实现，不自动重构或删除代码。
6. 索引生成和校验接入 CI，避免不同 PR 各自发明相同的原子能力。

这能降低重复造轮子的概率，也能让并行 PR 在修改低频变动的 atoms 层时更快发现已有能力。它不能消除 Git 文本冲突，因此必须同时采用按包拆分生成文件、稳定排序和“小 PR 分层”的冲突治理策略。

## 2. 当前基础与问题

仓库已经具备几个可复用的基础：

- `packages/atoms/src/index.ts` 是原子层公共出口。
- `packages/atoms/COMPONENT.md` 已定义原子层职责、依赖边界和验证命令。
- `component-docs.json` 与 `check-component-docs.mjs` 已能校验组件归属、源哈希和审计元数据。
- `check-change-contracts.mjs` 已能要求高风险源码变化带上对应测试。

当前缺少的不是“能不能找到文本”，而是下面几类结构化信息：

- 一个包公开了哪些函数、类、类型和常量。
- 每个符号的稳定签名、来源文件、导出路径和注释是否完整。
- 新增函数是否已经存在语义相同或高度相似的实现。
- 并行 PR 是否同时新增了同一层的近似原语。
- 修改原子函数后，哪些上层包和测试受到影响。

## 3. 目标与非目标

### 3.1 目标

- 生成可搜索的函数/API 列表和注释摘要。
- 明确区分公共 API、包内实现和测试辅助函数。
- 对原子层提供重复实现候选、调用方和影响面信息。
- 生成结果跨平台、可复现、可审查、可在 CI 中校验。
- 让 AI 在写新函数前能先查到现有原语、签名、注释、约束和测试。
- 让 AI 在开发完成后能反查新增实现，发现重复时直接回到已有实现。
- 为 CLI、AI 工具调用、PR 检查和文档站点提供同一份机器可读数据。

### 3.2 非目标

- 不自动重命名、删除或合并函数。
- 不根据函数名判断两个实现一定重复。
- 不把所有私有 helper 强行写入面向开发者的公共文档。
- 不让生成器修改源代码注释或业务代码。
- 不让 AI 直接改写或重构重复代码；AI 只消费索引、选择复用路径并执行明确的代码修改。

### 3.3 AI 使用边界

该系统的主要消费者是 AI 编码代理，不是终端用户。索引工具负责提供事实，AI 负责做开发决策：

| 时机 | AI 必须做的事 | 工具应返回的内容 |
|---|---|---|
| 开发前 | 根据任务关键词、类型和层搜索已有原语 | 候选符号、签名、职责、约束、测试、调用方 |
| 设计中 | 判断是直接复用、扩展已有函数，还是新增函数 | 复用建议、相似实现、差异点、影响面 |
| 编码中 | 优先调用/导入 canonical export | 导出路径、最小示例、禁止跨层依赖 |
| 开发后 | 对本次新增函数再做一次重复检索 | 精确重复、结构候选、可复用原语和未覆盖测试 |
| 提交前 | 将索引和源码一起校验 | 索引是否过期、注释是否缺失、重复是否已解释 |

AI 不应把索引当作绝对正确的设计结论。候选结果必须带证据，AI 需要检查行为语义、边界条件、错误策略和层级依赖后再决定复用方式。

## 4. 推荐产物

每个 workspace package 单独生成一组文件，所有包的结果都由 `prepare` 或 `npm run api:index` 自动刷新并提交，避免手工维护生成内容：

```text
docs/generated/api/atoms.json
docs/generated/api/atoms.md
docs/generated/duplicates/atoms.json
docs/generated/agent/atoms-context.json
docs/generated/api/molecules.json
docs/generated/api/molecules.md
docs/generated/api/materials.json
docs/generated/api/materials.md
docs/generated/duplicates/materials.json
```

所有生成文件首行标记：

```text
<!-- GENERATED FILE. Run npm run api:index. Do not edit manually. -->
```

### 4.1 API 索引 JSON

建议使用稳定 schema `api-index/v1`：

```json
{
  "schemaVersion": 1,
  "package": "@proofblade/atoms",
  "moduleHashes": {
    "src/value.ts": "sha256..."
  },
  "symbols": [
    {
      "id": "@proofblade/atoms::function::canonicalJson",
      "name": "canonicalJson",
      "kind": "function",
      "visibility": "public",
      "module": "packages/atoms/src/value.ts",
      "exportPath": "@proofblade/atoms",
      "line": 11,
      "signature": "canonicalJson(value: unknown): string",
      "summary": "Produce deterministic JSON with recursively sorted object keys.",
      "tags": ["deterministic", "serialization"],
      "dependencies": [],
      "symbolHash": "sha256..."
    }
  ]
}
```

`symbolHash` 只覆盖规范化后的符号 kind、名称、签名、注释摘要和导出路径，不包含绝对路径、生成时间或机器路径。`moduleHashes` 为每个源码模块单独计算哈希，使用与组件审计相同的跨平台文本规范化规则；修改一个模块只更新对应模块条目，不修改统一的 package 级 hash。

### 4.2 人类可读 Markdown 索引

Markdown 是正式的人类开发文档，不是临时调试输出。它与 JSON 索引由同一次 AST 扫描生成，不能单独手工维护。建议放在 `docs/generated/api/`，并由组件文档提供固定入口。

Markdown 至少应包含：

- 按层和 package 的目录。
- 按函数、类、类型、常量分类的稳定列表。
- 符号来源文件、行号和 canonical import 路径。
- TSDoc 摘要、`@invariant`、`@throws` 和最小示例。
- 相关测试文件和调用方摘要。
- “相似实现/建议复用”链接，并明确标记为候选而不是事实结论。

示例：

```markdown
## `canonicalJson`

`canonicalJson(value: unknown): string`

递归排序对象键，生成确定性 JSON；数组顺序保持不变，输入对象不会被修改。

- Canonical import: `@proofblade/atoms`
- Source: [`packages/atoms/src/value.ts:11`](../packages/atoms/src/value.ts:11)
- Tests: [`packages/atoms/tests/atoms.test.ts`](../packages/atoms/tests/atoms.test.ts)
- Invariants: deterministic, serializable, no business validation
- Reuse: 优先直接调用，不要在上层复制排序逻辑
```

Markdown 的目标是让人类在代码审查、设计评审和排查冲突时快速理解“已有能力是什么、边界是什么、应该复用什么”。AI 的 JSON 上下文不能替代这份人类文档。

### 4.3 AI 上下文索引

面向 AI 的索引不应直接把完整 Markdown 塞进 prompt，而应生成按需查询的紧凑数据：

```json
{
  "schemaVersion": 1,
  "package": "@proofblade/atoms",
  "layer": "atoms",
  "symbols": [
    {
      "id": "@proofblade/atoms::function::canonicalJson",
      "triggerTerms": ["canonical json", "stable serialization", "sort keys"],
      "signature": "canonicalJson(value: unknown): string",
      "summary": "递归排序对象键，生成确定性 JSON，不修改输入。",
      "invariants": ["数组顺序保持不变", "不承担业务校验"],
      "reuse": { "preferred": true, "import": "@proofblade/atoms", "module": "value" },
      "tests": ["packages/atoms/tests/atoms.test.ts"],
      "similar": []
    }
  ]
}
```

AI 查询接口建议返回 Top-K，而不是整个索引：

```text
api:search --package atoms --query "确定性序列化对象键排序"
api:context --package atoms --symbols canonicalJson,sha256
api:check-new --files packages/atoms/src/value.ts
```

`api:context` 的输出应适合直接放进编码代理的隐藏上下文，包含复用建议和限制，但不包含完整源码。AI 需要源码时再通过正常的 `read` 工具读取对应文件。

### 4.4 Markdown 内容排序

Markdown 供人阅读，按以下顺序稳定排列：

1. 公共函数。
2. 公共类及其公共方法。
3. 公共类型和接口。
4. 公共常量。
5. 包内但未导出的重要 helper（默认不展示，仅在 JSON 中保留可选记录）。

每项至少显示名称、签名、职责摘要、来源文件和相关测试。不要把完整函数体复制进文档，否则索引会变成第二份容易过期的源码。

### 4.5 双消费端一致性

推荐流水线只有一个事实来源和两个渲染器：

```text
TypeScript AST + Type Checker + TSDoc
                |
        normalized symbol model
          /                    \
 human Markdown renderer     AI JSON/context renderer
```

两种产物必须共享 `id`、`name`、`kind`、`signature`、`summary`、`invariants`、`source`、`tests`、`canonical import` 和 `symbolHash`。如果人类 Markdown 和 AI JSON 对同一符号产生不同签名或摘要，`api:index:check` 必须失败。

人类文档可以比 AI 上下文更详细，例如包含目录、示例和跨模块说明；AI 上下文可以更紧凑，但不得删除影响复用决策的约束和差异信息。

## 5. 符号收集规则

### 5.1 解析方式

使用 TypeScript Compiler API，而不是正则表达式或 `rg` 文本拼接：

- 读取包的 `tsconfig.json`。
- 使用 `Program`、`TypeChecker` 和 AST 遍历源码。
- 解析 `export`、`export *`、`export { name }` 的最终出口。
- 解析函数重载、泛型、可选参数、联合类型和类公共方法。
- 从 `src/index.ts` 的实际导出结果确定 `visibility=public`。
- 只收集 `.ts`/`.tsx`，排除 `dist`、`node_modules`、临时目录和测试 fixture。

推荐入口：

```text
scripts/api-index/collect-api.mjs
scripts/api-index/render-api.mjs
scripts/api-index/duplicate-candidates.mjs
```

如果 TypeScript API 需要复杂类型，可以把实现写成 `scripts/api-index/*.ts`，通过仓库现有 `tsx` 执行；生成结果仍然必须是确定性的。

### 5.2 注释规则

公共符号建议使用 TSDoc，最低要求为一行职责摘要：

```ts
/** Produce deterministic JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
```

原子层推荐支持以下标签：

- `@public`：明确纳入公共 API。
- `@internal`：明确排除公共 API，但可保留在内部索引。
- `@since 0.1.0`：首次可用版本。
- `@invariant`：必须长期保持的行为，例如确定性、幂等性、路径边界。
- `@throws`：可预期的失败条件。
- `@example`：最小调用示例，避免把敏感数据写入注释。
- `@layer atoms`：声明所属抽象层，防止原子层误引入业务概念。

生成器只读取和规范化注释，不替开发者生成事实性内容。缺少摘要的公共函数应在 CI 中报告为文档缺口；第一阶段可设为 warning，稳定后升级为 error。

### 5.3 原子层的特别分类

原子层目前的符号可按以下类别索引：

- 值操作：`createId`、`sha256`、`canonicalJson`、`estimateTokens`。
- 存储原语：`atomicWriteFile`、`durableAppendFile`。
- 并发原语：`KeyedOperationQueue`。
- 通用契约：`ToolAtom`、`EffectAtom`、`ReducerAtom`、`AppendOnlyLogAtom`。

索引必须显示“它是什么”和“它不负责什么”。例如 `atomicWriteFile` 是机械一致性原语，不应被描述为 Run 事务；`canonicalJson` 是确定性序列化，不应被描述为业务对象校验器。

## 6. 重复实现检测

重复检测分为三层，避免把简单的同名函数误报成重复：

### 6.1 精确重复

- 相同导出路径、相同名称、相同归一化签名：直接报错。
- 同一 package 内出现两个等价公共导出：直接报错。
- 同一功能被重复从不同模块导出：报告出口冲突，要求保留一个 canonical export。

### 6.2 结构相似

对函数体做 AST 规范化后计算结构指纹：

- 去掉变量名、局部字符串和位置数据。
- 保留调用顺序、控制流、异常分支、读写操作和返回形状。
- 只对达到最小长度的函数计算指纹，避免把一行包装器全部报成重复。

结果标记为 `candidate`，不自动阻断合并。

### 6.3 语义候选

使用名称、注释标签、参数/返回类型和调用图生成候选，例如：

- `canonicalJson` 与另一个“排序对象后 JSON.stringify”的函数。
- `atomicWriteFile` 与另一个“临时文件 + rename”的实现。
- 多个包各自实现相同的 bounded text truncation。

语义候选只能给出证据和建议：

```json
{
  "status": "candidate",
  "left": "@proofblade/atoms::function::canonicalJson",
  "right": "packages/materials/src/...::function::stableJson",
  "signals": ["same-call-shape", "same-summary-tag", "same-return-type"],
  "recommendation": "reuse atoms canonicalJson or document why semantics differ"
}
```

### 6.4 例外与豁免

允许通过明确注释或配置文件记录例外：

```ts
/** @duplicate-justification Different failure redaction policy is required here. */
```

豁免必须包含原因、责任组件和复查日期。不能只写 `ignore duplicate`。

## 7. 对多 PR 冲突的治理

自动索引不能替代分支治理，建议同时执行以下规则：

1. **按 package 拆分产物**：atoms、molecules、materials 不共用一个大文件。
2. **稳定排序**：按 `visibility -> kind -> exportPath -> name -> signature` 排序。
3. **不写生成时间**：时间放在可选运行日志，不写入提交产物，避免每次生成都造成 diff。
4. **只在源码变化时更新对应索引**：atoms 变化不修改 molecules 索引。
5. **生成文件禁止手工编辑**：PR 中只接受源码/注释和生成器变化。
6. **并行 PR 采用“先源代码、后重生成”**：合并冲突时重新运行生成器，不手工拼 JSON。
7. **原子层高风险变更使用单独 PR**：先合并原语和测试，再由上层 PR 复用。
8. **增加 canonical export 约定**：一个原语只能有一个推荐入口，别名必须记录原因。

推荐的冲突处理命令：

```powershell
npm run api:index
git diff -- docs/generated/api/atoms.json docs/generated/api/atoms.md
npm run api:index:check
```

## 8. CLI 与 CI 设计

根 `package.json` 建议增加：

```json
{
  "api:index": "tsx scripts/api-index/cli.ts generate",
  "api:index:check": "tsx scripts/api-index/cli.ts check",
  "api:duplicates": "tsx scripts/api-index/cli.ts duplicates",
  "api:search": "tsx scripts/api-index/cli.ts search",
  "api:context": "tsx scripts/api-index/cli.ts context",
  "api:check-new": "tsx scripts/api-index/cli.ts check-new"
}
```

命令行为：

- `generate`：生成指定包或全部包的人类 Markdown、公共 API JSON 和 AI context JSON。
- `check`：在临时目录生成并与提交版本比较；有差异则失败。
- `duplicates`：输出精确重复和候选重复，支持 `--package atoms`、`--severity error|candidate`。
- `search`：给 AI 或人类按关键词、类型、层和返回类型查找 Top-K 符号。
- `context`：给 AI 返回紧凑的复用上下文，不返回完整源码。
- `check-new`：只检查本次变更文件，返回“复用/扩展/新增”候选和重复证据。
- `explain <symbol-id>`：显示人类可读的签名、注释、来源、调用方和相关测试。

CI 分三档：

### 阶段 A：只读报告

- 每个 PR 生成 artifact，不阻断合并。
- 统计公共符号数、缺失注释数、精确重复数、候选重复数。

### 阶段 B：原子层门禁

- atoms 索引必须与源码一致。
- 新增公共符号必须有摘要和至少一个测试引用。
- 精确重复阻断；结构/语义候选只评论提醒。

### 阶段 C：全仓库门禁

- molecules/materials 逐步加入。
- 公共 API 变更要求更新组件文档或变更说明。
- 生成索引纳入 `npm run verify`，但不把候选重复当作硬失败。

## 8.1 AI 编码代理工作流

建议把“索引查询”变成编码代理的固定生命周期，而不是靠提示词提醒一次：

### 开发前：先查再设计

代理收到任务后，先从任务中提取名词、动作、输入输出类型和所属层。例如“增加确定性哈希缓存键”应先查询 `deterministic`、`hash`、`cache key` 和 `atoms`。

```text
api:search --package atoms --query "deterministic hash cache key"
api:context --package atoms --symbols sha256,canonicalJson
```

代理需要在计划中记录一条选择：

- `reuse`: 直接使用已有符号。
- `extend`: 在已有符号上增加兼容能力或包装器。
- `new`: 没有合适原语，新增实现并说明差异。

如果返回 `reuse` 候选，默认不能直接创建同名或同语义新函数。

### 开发中：优先调用已有实现

- 优先使用 canonical export，不从源码复制函数体。
- 如果现有函数缺少能力，先检查是否可以向后兼容地扩展它。
- 如果必须新增包装器，在注释中标明底层复用符号和新增差异。
- 如果发现 atoms 层需要业务概念，停止向 atoms 添加代码，改在上层组件实现。

### 开发后：复查新增代码

代码修改完成后，代理必须对变更文件执行：

```text
api:check-new --files <changed-source-files>
api:duplicates --package atoms --changed-only
api:index:check
```

复查结果分三类：

1. **可直接复用**：撤销新函数，改为导入已有 canonical export。
2. **已有实现但行为不完全相同**：扩展已有函数，或保留新函数并在注释/PR 中写出差异。
3. **确实是新原语**：补 TSDoc、测试、索引和 `new` 选择记录。

这一步是“防重复造轮子”的核心。工具不替 AI 修改代码，AI 根据证据主动选择复用、扩展或新增。

### 提交前：形成可审查记录

建议让代理在 PR 描述或变更报告中保留简短的 API 复查结果：

```text
API reuse check:
- reused: @proofblade/atoms::canonicalJson
- extended: none
- new: @proofblade/atoms::stableDigest (no equivalent found)
- duplicate candidates: 1 explained, 0 unresolved exact duplicates
```

这不是新的手工登记表，内容应由 `api:check-new` 根据源码和索引生成，避免再次引入易过期的文档。

## 9. 测试方案

生成器本身应有独立测试，不依赖当前仓库恰好有哪些函数：

1. **导出解析**：默认导出、重导出、`export *`、别名导出。
2. **签名稳定性**：泛型、重载、可选参数、联合类型、类方法。
3. **注释解析**：摘要、标签、缺失摘要、非法标签。
4. **确定性**：不同文件遍历顺序、Windows/Linux 换行、重复生成结果完全一致。
5. **路径安全**：不输出绝对路径，不读取 `dist` 和 workspace 外文件。
6. **索引完整性**：公共出口中的每个符号恰好出现一次。
7. **重复检测**：精确重复阻断，结构候选稳定，豁免必须有原因。
8. **回归快照**：atoms 只保留小型 fixture，不把完整生产索引作为脆弱的大快照。
9. **冲突模拟**：两个 fixture 分支分别新增函数，合并后生成器输出稳定且不依赖提交顺序。

原子层现有测试应继续作为行为测试：索引测试不能替代 `packages/atoms/tests/atoms.test.ts`。函数存在不代表函数正确，生成器只验证可发现性、注释和重复风险。

## 10. 分阶段实施计划

### P0：原子层只读索引

- 新增 AST 收集器和 JSON/Markdown renderer。
- 只处理 `packages/atoms`。
- 生成函数、类、类型、常量列表和来源位置。
- 不阻断 PR，只生成报告。

验收：两次在不同平台运行生成结果相同，公共导出覆盖率 100%。

### P1：注释契约与 atoms 门禁

- 给 atoms 公共函数补 TSDoc 摘要、`@invariant` 和 `@throws`。
- 缺失摘要进入 CI error。
- 精确重复进入 CI error，候选重复进入 PR 报告。
- `COMPONENT.md` 增加索引入口和维护命令。

验收：新增公共原子没有注释或测试时，CI 能给出明确文件、符号和修复命令。

### P2：重复候选与影响面

- 加入 AST 结构指纹和调用方索引。
- `api:duplicates --package atoms` 输出候选及证据。
- 在 PR summary 中显示“建议复用的 atoms”。

验收：为 fixture 添加两个稳定 JSON/原子写入实现时，工具能发现候选，且不会把不相似函数误报为 error。

### P3：扩展 molecules

- 复用同一 schema 和 renderer。
- 允许 molecules 依赖 atoms 的符号链接关系进入索引。
- 检测跨层重复：molecules 不应重新实现 atoms 已提供的通用确定性原语。

### P4：开发者体验

- 提供 `api:explain <symbol>`。
- 在 CLI/IDE 中支持按名称、标签、返回类型和层搜索。
- 可选生成静态 HTML 或 Markdown 文档站点。
- 将候选报告作为 PR comment，但保留本地 CLI 作为真源。

## 11. 原子层第一批建议注释

以下不是立即修改清单，而是建议的注释最低标准：

- `canonicalJson`：说明递归排序对象键、数组顺序不变、输入不被修改。
- `sha256`：说明输入编码和返回格式，禁止把它描述成密码学签名。
- `createId`：说明只提供唯一性，不提供排序或安全随机数语义。
- `estimateTokens`：说明这是有界估算，不是 Provider 精确 tokenizer。
- `atomicWriteFile`：说明临时文件、同步和 rename 的边界，以及跨文件事务不受支持。
- `durableAppendFile`：说明追加顺序、同步语义和并发调用责任。
- `KeyedOperationQueue.run`：说明同一 key 串行、不同 key 可并行、失败不会毒化后续队列。
- `ToolAtom`/`EffectAtom`/`ReducerAtom`：说明它们只是契约，不含业务验证和持久化策略。

## 12. 风险与取舍

### 风险：索引变成第二份过期文档

对策：只允许生成器写入；CI 使用 `--check`，不接受手工修改生成文件。

### 风险：重复检测误报导致开发者绕过工具

对策：精确重复才阻断，结构/语义相似只报告候选；所有阻断都必须给出可复现证据。

### 风险：AST 工具升级造成大面积噪声

对策：锁定 TypeScript 主版本，schema 和 renderer 版本化；升级工具单独开 PR。

### 风险：原子层改动引起大索引冲突

对策：按包拆分文件、稳定排序、源代码和生成文件同 PR 更新；合并冲突时重新生成而不是手工拼接。

### 风险：过度记录私有 helper 暴露实现细节

对策：公共索引默认只展示实际 package export；内部索引单独文件，默认不进开发者文档。

## 13. 建议的 PR 拆分

不要一次提交全部层级，建议按以下顺序拆分：

1. `P0-api-index-atoms`：AST 收集器、schema、renderer、atoms fixture 测试。
2. `P1-atoms-doc-contract`：补齐 atoms TSDoc、组件文档入口和索引门禁。
3. `P2-duplicate-candidates`：结构指纹、候选报告和豁免规则。
4. `P3-api-index-molecules`：扩展 molecules 和跨层引用。
5. `P4-api-explain`：CLI/IDE 查询与 PR 报告。

每个 PR 只修改一个主要生成产物目录，避免多个开发者同时编辑同一份索引。原子层的行为代码、索引工具和注释契约应分开审查，以便出现问题时容易回滚。

## 14. 最终验收标准

- `npm run api:index:check` 在 Windows 和 Linux 结果一致；安装依赖时 `prepare` 自动刷新 molecules/materials 本地索引。
- atoms 公共导出覆盖率 100%，每个公共函数都有职责摘要。
- 索引不含绝对路径、密钥、提示词正文或运行时敏感参数。
- 同一公共原语只有一个 canonical export。
- 精确重复能阻断，候选重复能解释原因且不误阻断正常实现。
- 修改 atoms 源码时，CI 能指出受影响的索引、组件文档和测试。
- 生成文件冲突可通过重新运行命令解决，不需要人工编辑 JSON。
- 生成器失败时不会修改源代码，也不会覆盖已有正确索引。

## 15. 推荐结论

这项功能值得做，优先级建议为 **P1（原子层开发基础设施）**，但第一版应保持小而确定：

1. 先做 atoms 公共 API 索引，同时生成给人类看的 Markdown 和给 AI 查询的 JSON。
2. 把 `api:search`、`api:context`、`api:check-new` 接入 AI 编码代理的开发前/开发后固定流程。
3. 再做精确重复和结构相似候选检测；发现重复时由 AI 复用或修改已有实现。
4. 最后扩展到 molecules、Materials 和 IDE/PR 体验。

这样既能防止重复造轮子，也不会因为一个“大而全的自动文档系统”给并行 PR 增加新的合并热点。
