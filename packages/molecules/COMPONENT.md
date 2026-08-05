# Molecules 分子层

```json component-metadata
{
  "id": "molecules",
  "name": "Molecules 分子层",
  "version": "0.2.0",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-06T00:19:34+08:00"
}
```

## 职责

把原子组合成通用的信息获取、处理和传递能力，包括 Tool 执行接口、事件投影、分层上下文、Artifact、文本窗口、缓存指标、Provider 前缀指纹、能力目录和 `OutputRewritePort`。

## 入口与依赖

- 公共入口：`src/index.ts`，所有可复用契约必须从这里导出。
- 唯一内部 workspace 依赖：`@proofblade/atoms`。
- 不认识 Run、Fixture、CTF 阶段、ProofBlade 配置或具体 Provider。

## 开发规则

- 通用组合放在本层，业务决策留给 Materials。
- Context 与缓存处理必须是确定性的，不持久化提示正文或敏感参数。
- 输出改写契约只表达 prepare/finalize 和字节指标；具体 RTK、Run 与 Artifact 策略留给 Materials。
- 修改 Tool、Capability、Context 或缓存类型时补充独立测试，保证移除上层后仍可构建运行。

## 验证

```powershell
npm run test:molecules
```
