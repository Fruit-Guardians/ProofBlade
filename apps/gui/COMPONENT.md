# ProofBlade GUI

```json component-metadata
{
  "id": "gui",
  "name": "ProofBlade GUI",
  "version": "0.3.1",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-06T02:08:30+08:00"
}
```

## 职责

提供真实模型对话、工作目录选择、Provider 配置、会话文件夹、能力开关、Run 观测和 Tool 调试界面。Node server 是 Materials 的应用适配器，浏览器只保存展示状态和临时脚本结果。

## 入口与依赖

- 服务入口：`src/server.ts`；浏览器入口：`src/main.tsx`；主界面：`src/App.tsx`。
- 数据投影：`debug-data.ts`；Tool 可读投影：`tool-presentation.ts`；目录适配：`directory-browser.ts`；本地配置：`provider-settings.ts`、`workspace-settings.ts`。
- 依赖 Materials 公共 API、React 和 Lucide，不创建第三套 durable state。

## 开发规则

- API 响应只暴露 `hasApiKey`，不回传 Key。
- SSE 临时消息在 turn 完成后由 Pi Session 持久数据替换。
- 会话工作目录必须经过服务端绝对路径、存在性和目录类型校验，再传给 `PiCodingLane`。
- 新控件必须覆盖运行中、空数据、错误和窄屏状态；Tool 原始 JSON 仍从 durable domain 投影，可读卡片不得替代原始记录。
- 最终结论的 `verified/unverified` 状态来自 durable `assistant_message` 事件；已验证状态必须显示 Evidence 引用，缺少复现时必须给出醒目的未验证提示。
- 旧 Session 没有验证元数据时，只读投影可根据解题请求与非 ToolUse 最终消息补充 `unverified`；该兼容逻辑不得补造 Evidence 或改写原始消息。

## 验证

```powershell
npm run test --workspace=@proofblade/gui
npm run build --workspace=@proofblade/gui
```
