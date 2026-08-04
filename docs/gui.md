# ProofBlade 动态调试 GUI

## 启动

GUI 是 `apps/gui` 应用层，不保存独立业务状态。它默认读取项目根目录的 `proofblade.config.json`，模型和 Provider 仍完全由配置文件决定。

```powershell
npm install
npm run gui -- --port 4173
npm run gui -- --config proofblade.config.json --port 4173
```

服务默认只监听 `127.0.0.1`。可用参数：

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `--port` | `4173` | HTTP 端口 |
| `--host` | `127.0.0.1` | 监听地址 |
| `--config` | `proofblade.config.json` | ProofBlade 配置文件 |
| `--project-root` | 仓库根目录 | 运行数据与配置根目录 |

对应环境变量为 `PORT`、`HOST`、`PROOFBLADE_CONFIG` 和 `PROOFBLADE_ROOT`。服务只把 Provider 名称、模型配置值、Base URL 和思考等级作为界面摘要；`apiKeyEnv` 对应的环境变量值不会进入 API 响应。

## 调试路径

Tool 调试器按以下信息层级选择数据：

```text
Run
  -> Pi Session
      -> assistant message / turn
          -> one toolCall
              -> toolResult
              -> Control telemetry
              -> Artifact / Evidence / Effect links
```

Pi Session 通过 Pi 0.83.0 的 `JsonlSessionRepo` 和 `NodeExecutionEnv` 读取。GUI 不手工拆 JSONL 行。Tool 关联使用稳定的 `toolCallId`：

1. 在 assistant message 的 `content` 中定位 `type: "toolCall"`。
2. 在 Session entries 中查找相同 ID 的 `role: "toolResult"`。
3. 在 Control events 中查找相同 ID 的 `tool_call_recorded` 和 `tool_result_recorded`。
4. 从参数和结果递归收集已经存在于 Run Snapshot 的 Artifact、Evidence 和 Effect ID。
5. 根据 Evidence source 和 Effect artifact 引用补全关联记录。

Control telemetry 刻意不保存原始 Arguments；原始参数来自 Pi Session，Control Store 只提供参数哈希、执行策略、等待/执行时间、输出字节和错误签名。两个 durable domain 在 GUI 中关联，但各自的职责没有变化。

## Tool 调试对象

Script Lab 和“完整对象”视图使用以下结构：

```ts
interface ToolCallDebug {
  id: string;
  name: string;
  timestamp: string;
  status: "success" | "error" | "pending";
  assistantEntryId: string;
  assistantOrdinal: number;
  callIndex: number;
  arguments: unknown;
  call: unknown;
  result?: unknown;
  assistantEntry: unknown;
  resultEntry?: unknown;
  telemetry: {
    call?: HarnessEvent;
    result?: HarnessEvent;
  };
  links: {
    artifacts: ArtifactRef[];
    evidence: Evidence[];
    effects: Effect[];
  };
}
```

`pending` 表示 Session 已记录调用但尚未出现对应 Tool Result。界面会保留该调用，运行中刷新后自动显示后续结果。

## Script Lab

脚本在浏览器临时 Web Worker 中运行，`input` 为当前选择的完整 `ToolCallDebug`。示例：

```js
return {
  tool: input.name,
  args: input.arguments,
  result: input.result?.details,
  evidenceIds: input.links.evidence.map(item => item.id)
};
```

每次点击“运行”都会创建新的 Worker。结果或错误返回后 Worker 立即销毁；超过 1500 ms 会被终止。输入和结果使用结构化克隆传递，返回值还会经过 JSON 序列化规范化。脚本源码不进入 Node 服务端、Control Store、Pi Session 或配置文件。

输出视图：

| 视图 | 用途 |
| --- | --- |
| JSON | 可展开的键值树 |
| 表格 | 把对象和数组扁平化为路径、类型、值 |
| 文本 | 查看字符串或格式化 JSON 文本 |

## 本地 API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | Fixture、模型摘要、刷新间隔 |
| `GET` | `/api/runs` | Run 摘要列表 |
| `GET` | `/api/runs/:id` | Snapshot、Events、Telemetry、Pi Sessions 与 Tool 投影 |
| `GET` | `/api/runs/:id/artifacts/:artifactId` | 校验引用后读取 Artifact 文本 |
| `POST` | `/api/solve` | 使用生产 `SingleAgentCtfLoop` 创建并执行 Run |
| `POST` | `/api/runs/:id/reconcile` | 使用 `RunRecoveryService` 核对恢复 |
| `POST` | `/api/runs/:id/checkpoint` | 使用 `CheckpointService` 创建机械检查点 |

Run ID 只接受字母、数字、点、下划线和连字符，Artifact 必须先存在于对应 Run Snapshot。API 请求体上限为 1 MB。

## 验证

```powershell
npm run typecheck --workspace=@proofblade/gui
npm run test --workspace=@proofblade/gui
npm run build:web --workspace=@proofblade/gui
npm test
```

GUI 单元测试覆盖 Tool/Result/Telemetry/Artifact/Evidence 关联、pending 调用和 Run ID 边界。浏览器回归应至少覆盖 1440px 桌面与 390px 移动视口、Script Lab 执行、抽屉交互、控制台错误和页面溢出。
