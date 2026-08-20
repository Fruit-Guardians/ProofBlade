# Tool Catalog（本机工具清单）

`tool-catalog.json` 是**本机（agent 运行的那台机器）**可用的工具、解释器和工具链清单。它与 Skill 同性质：元数据常态化注入 Coding 系统提示的稳定前缀，正文/用法按需通过 `read`/`bash` 读取。**绝不记录任何题目环境**——target 侧环境只能来自题目描述，团队清单不承诺无法保证的东西。

## 文件位置

- 仓库根目录 `tool-catalog.example.json` 是提交的示例模板。
- 实机文件 `tool-catalog.json` 被 Git 忽略（路径是本机专属，类似 `gui-provider.json`），由每台机器各自维护。
- 从 ProofBlade install root 读取（与 `skills/`、`.mcp.json` 同级），不随题目工作区临时解压。

## Schema

```json
{
  "schemaVersion": 1,
  "tools": [
    { "id": "python311", "name": "python311", "kind": "interpreter",
      "path": "C:/Users/chriz/.pyenv/versions/3.11.9/python.exe",
      "description": "固定 Python 3.11；自带 requests/pycryptodome",
      "category": "multi" },
    { "id": "s2-045-exec", "name": "s2-045-exec", "kind": "tool",
      "path": "C:/tools/exploit/exec.py",
      "description": "Struts2 S2-045 通用 RCE 模板",
      "doc": "C:/tools/exploit/README.md",
      "category": "web" }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 唯一标识，`[A-Za-z0-9._-]`；重复取第一条 |
| `name` | 否 | 模型看到的名称；缺省回退到 `id` |
| `kind` | 否 | `tool`（默认）\| `interpreter`（解释器）\| `toolchain`（工具链） |
| `path` | 是 | **绝对路径**，Windows 用 `C:/...` 或 `C:\...`（正斜杠统一渲染），POSIX 用 `/...`；相对路径直接丢弃 |
| `description` | 否 | 一句话简介（注入提示词的核心内容）；缺省回退到 `name` |
| `doc` | 否 | 用法文档路径，仅作元数据，按需 `read` |
| `category` | 否 | 类别，预留按题型过滤（v1 全量注入不参与过滤） |

## 注入与哈希

- 注入：`pi-coding-lane` 的 `codingSystemPrompt()` 渲染 `<tool-catalog catalog-hash="…">` 块，按 `kind` 分组，拼进稳定系统提示（L0/L1 前缀）。缓存友好——清单不变则前缀 hash 不变。
- 哈希：`catalogHash()` 由排序后的工具身份 + 描述 + 路径/文档（会被注入系统提示的字面量）计算；路径或文档变化会使稳定前缀与运行版本快照对应变化——这是有意为之，因为模型看到的新路径确属提示内容。未使用的 `category` 字段不参与哈希。
- 版本快照：`toolCatalogHash` 与 `toolCatalog` 写入 `RunVersionSnapshot` 和 `RuntimeResourceSnapshot`（ContextManifest resources），与 `skillCatalogHash`/`mcpCatalogHash` 平行。
- 失效处理：路径不存在只产生 `probe` 诊断（警告），**不阻断、不影响 hash**；manifest 缺失或非法降级为空目录。

## CLI

```powershell
proofblade tools list          # 列出全部条目 + catalogHash + 解析诊断
proofblade tools probe         # 额外探测路径是否存在（warn 不阻断）
proofblade tools show <id>     # 显示单个条目
```

## 扩展什么进清单

只放「本机实际存在、可用 bash 调用」的东西：固定版本解释器、工具链、自研或下载的利用/分析脚本、无头分析器。别放题目相关的 URL、凭证或 target 侧假设——那些属于挑战描述与 playbook。

## 实现

- `packages/materials/src/tools/catalog.ts`：`ProofBladeToolCatalogRegistry`（parse/validate/hash/promptBlock/contextSnapshot/probe）。
- 类型：`domain/types.ts` 的 `ToolKind`、`RuntimeResourceSnapshot.toolCatalog*`、`RunVersionSnapshot.toolCatalog*`。
- 测试：`packages/materials/tests/tool-catalog.test.ts`。