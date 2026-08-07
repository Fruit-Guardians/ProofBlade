# Fixture Sandbox

```json component-metadata
{
  "id": "materials-sandbox",
  "name": "Fixture Sandbox",
  "version": "0.2.1",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T15:30:00+08:00"
}
```

## 职责

定义合成 Fixture 目录、构建/重置/健康检查和 generation 隔离，为 Effect 执行提供可复现目标环境。

## 入口与边界

- `fixture-catalog.ts` 描述可见 Fixture。
- `fixture.ts` 管理生命周期和目标执行。
- Web Fixture 使用绑定到 loopback 随机端口的进程内 HTTP 服务；健康检查绑定 generation，进程状态丢失后重建服务并推进 generation。
- 终态 Run 销毁对应 HTTP 服务和进程内 generation 索引；`PAUSED` Run 保留服务用于恢复，应用退出通过幂等 `close()` 释放全部服务。
- 模型看到的是不可信 Observation，不直接拥有 Sandbox 实例或控制状态。

## 开发规则与验证

Fixture 必须确定、离线可运行且可重置。重置提升 generation，旧 Effect/Evidence 不得被新一代任务采用。HTTP 路由方法、路径、状态、Header 和 Body 属于 Fixture 内容契约。

```powershell
npm run eval
```
