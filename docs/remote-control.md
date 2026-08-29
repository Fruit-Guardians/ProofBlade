# ProofBlade 远程控制设计

## 1. 文档状态

- 状态：计划设计，暂不实施。
- 目标：通过 QQ 或飞书发送命令，让 ProofBlade 创建、执行、暂停、恢复任务，并持续汇报进度。
- 推荐首个实现：飞书官方应用机器人 + ProofBlade 本地远程控制桥。
- QQ 实现：优先评估 QQ 官方机器人 API；已有 OneBot 环境时使用 OneBot 11 适配器。

## 2. 结论摘要

项目当前已经具备远程控制所需的执行基础：

1. Run 有持久化快照和事件日志，Control Store 是状态唯一来源。
2. Pi Session 保存对话和模型上下文，可以继续执行同一个对话 Run。
3. GUI 已提供创建对话、发送消息、读取 Run、暂停和 SSE 流式事件的能力。
4. Assist 模式已经有暂停、人工确认和恢复语义。
5. Artifact、Telemetry、Checkpoint 和 Recovery 可以作为远程汇报的数据来源。

因此不需要让 QQ 或飞书直接控制 Agent。正确边界是：

```text
QQ / 飞书
    -> Channel Adapter
    -> Remote Command Gateway
    -> ProofBlade Application Service
    -> Control Store / Pi Session / Agent Lane
    -> Run Event Projector
    -> Channel Adapter
    -> QQ / 飞书
```

远程桥只负责消息接入、身份映射、命令解析、权限判断、进度节流和消息发送。Run 状态、执行权限和完成判定仍由 ProofBlade 负责。

## 3. 现有能力映射

| 现有能力 | 当前位置 | 远程控制用途 |
| --- | --- | --- |
| 创建普通 Coding Run | `apps/gui/src/debug-data.ts:createConversation` | `/run` 创建远程对话 |
| 创建 Fixture Run | `apps/gui/src/debug-data.ts:createFixtureConversation` | 比赛或固定靶场任务 |
| 发送对话消息 | `apps/gui/src/debug-data.ts:runChat` | `/ask` 或普通文本消息 |
| 查询 Run | `apps/gui/src/debug-data.ts:getRun` | `/status` |
| 暂停 Run | `apps/gui/src/debug-data.ts:pause` | `/pause` |
| 恢复 Run | `apps/gui/src/debug-data.ts:runChat` | `/resume` 或继续发送消息 |
| SSE 事件 | `apps/gui/src/api.ts:streamChat` | 进度、工具调用、暂停、完成通知 |
| Control Store | `packages/materials/src/control` | 状态、事件、幂等和恢复 |
| Artifact Store | `packages/materials/src/effects/artifact-store.ts` | 远程发送摘要和产物链接 |
| Fleet 控制 | `apps/gui/src/fleet.ts` | 竞赛题队列、并发和单题状态 |

当前 GUI HTTP API 面向本机浏览器，不应直接暴露到公网。远程桥应调用应用服务或仅监听 loopback 的内部 API，并在边界处重新做认证和授权。

## 4. 现成平台选择

### 4.1 飞书

飞书自定义机器人适合向群里发送通知；需要接收命令、识别发送者和处理事件时，应使用飞书应用机器人与事件订阅。官方能力包括机器人消息发送和事件订阅：

- [飞书自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
- [发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [事件订阅概览](https://open.feishu.cn/document/server-docs/event-subscription/overview)

建议：

- 群聊中使用应用机器人。
- 用 `open_id` 或 `user_id` 绑定 ProofBlade 账户。
- 在事件处理层验证请求签名、事件唯一 ID 和时间窗口。
- 通过消息卡片显示 Run 状态，并提供“暂停”“恢复”“批准”按钮。
- 长文本、日志和 Artifact 使用链接，避免把完整工具输出塞进聊天消息。

### 4.2 QQ 官方机器人

QQ 官方机器人适合需要官方渠道和明确平台权限的部署，具体能力、群聊范围和权限以 QQ 开放平台当前规则为准：[QQ 机器人官方文档](https://bot.q.qq.com/wiki/)。

建议将 QQ 事件转换成内部统一事件，不让业务层依赖 QQ 的消息结构：

```text
QQ MESSAGE_CREATE
    -> RemoteInboundMessage
QQ MESSAGE_ACK / API response
    <- RemoteOutboundMessage
```

### 4.3 OneBot 11

OneBot 11 是 QQ 机器人生态常用的统一事件和动作协议：[OneBot 11](https://github.com/botuniverse/onebot-11)。它不是单独的 QQ 账号服务，仍需要一个兼容 OneBot 的适配器和运行环境。

适合场景：

- 已经有 OneBot 11 服务。
- 希望以后替换 QQ 适配器而不修改 ProofBlade 业务逻辑。
- 可以接受社区适配器的版本和部署维护成本。

### 4.4 n8n / Node-RED

n8n 或 Node-RED 可以快速接收 webhook、转发 HTTP 请求和发送通知，适合原型或单向汇报。但不建议让它们保存 Run 状态、决定完成结果或实现审批状态机。持久状态和幂等操作应留在 ProofBlade Control Store。

## 5. 推荐总体架构

### 5.1 进程划分

建议新增一个独立的 `remote-bridge` 应用，而不是把平台 SDK 直接塞进 GUI Server：

```text
apps/remote-bridge
  src/
    main.ts                 # 启动、配置和生命周期
    gateway.ts              # 统一命令网关
    identity-store.ts       # 平台用户到 ProofBlade 身份的绑定
    run-bindings.ts         # 会话、聊天和 Run 的绑定
    progress-projector.ts   # Run 事件到消息摘要
    adapters/
      feishu.ts             # 飞书应用机器人
      qq-official.ts        # QQ 官方 API
      onebot.ts              # OneBot 11
```

远程桥通过同一进程内的材料层服务或 loopback API 调用 ProofBlade。首版可以和 GUI 共用服务工厂，但消息适配器、权限和持久映射必须独立成模块。

### 5.2 核心接口

```ts
interface RemoteInboundMessage {
  platform: "feishu" | "qq" | "onebot";
  eventId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  text?: string;
  action?: {
    name: "pause" | "resume" | "approve" | "cancel" | "status";
    value?: string;
  };
  receivedAt: string;
  rawHash: string;
}

interface RemoteOutboundMessage {
  conversationId: string;
  text?: string;
  card?: Record<string, unknown>;
  replyToEventId?: string;
  dedupeKey: string;
}

interface RemoteCommandContext {
  identityId: string;
  conversationId: string;
  runId?: string;
  sourceEventId: string;
}
```

适配器只实现以下能力：

```ts
interface ChannelAdapter {
  verifyInbound(request: unknown): Promise<RemoteInboundMessage | undefined>;
  send(message: RemoteOutboundMessage): Promise<{ externalMessageId?: string }>;
  edit?(externalMessageId: string, message: RemoteOutboundMessage): Promise<void>;
}
```

## 6. 命令协议

首版不建议把自然语言直接当成任意控制命令。使用小而明确的命令集合，普通文本只作为当前 Run 的聊天输入。

| 命令 | 作用 | 权限 |
| --- | --- | --- |
| `/help` | 显示可用命令 | 已绑定用户 |
| `/run <目标>` | 创建新的 Coding Run | operator |
| `/bind <runId>` | 绑定现有 Run | operator 或 owner |
| `/status` | 显示当前 Run 状态 | viewer |
| `/tail` | 显示最近进度摘要 | viewer |
| `/pause` | 请求暂停当前 Run | operator |
| `/resume` | 恢复已暂停 Run | operator |
| `/approve <id>` | 批准 Assist 候选 | approver |
| `/cancel` | 取消当前未完成任务 | operator |
| `/artifact <id>` | 返回 Artifact 摘要或链接 | viewer |
| `/unbind` | 解除当前会话绑定 | owner |

命令解析规则：

1. 命令名称大小写不敏感。
2. 参数数量、长度和字符集必须有界。
3. 未知命令返回帮助，不交给 Agent 猜测。
4. 普通文本只有在存在唯一活动 Run 时才转为该 Run 的消息。
5. 没有绑定 Run 的普通文本必须要求用户先执行 `/run` 或 `/bind`。
6. 所有命令都记录 `platform`, `conversationId`, `senderId`, `eventId` 和授权结果。

## 7. Run 与聊天绑定

远程控制需要持久化三类关系：

```text
platform + conversationId -> remote session
remote session            -> active runId
sender identity           -> role + allowed project roots
```

建议新增一个轻量的 `remote-bindings.jsonl` 或独立存储表，记录：

```json
{
  "bindingId": "bind_01J...",
  "platform": "feishu",
  "conversationId": "oc_...",
  "identityId": "feishu:user:ou_...",
  "runId": "RUN-2026-001",
  "projectRoot": "D:/AI/project/ProofBlade",
  "role": "operator",
  "createdAt": "2026-08-17T00:00:00.000Z",
  "updatedAt": "2026-08-17T00:00:00.000Z",
  "status": "active"
}
```

绑定必须满足：

- 一个会话默认只有一个活动 Run。
- 一个 Run 可以被多个授权会话观察，但控制操作必须再次校验角色。
- `/bind` 只能绑定同一项目范围内的 Run。
- 终态 Run 只读，不自动复用为下一个任务。
- 用户离开群聊或撤销授权后，绑定进入 `revoked`，历史记录保留。

## 8. 进度汇报模型

### 8.1 汇报事件

远程桥不应转发每一个底层事件，而应把它们投影成稳定的高层事件：

```text
run_created
run_started
phase_changed
progress_changed
waiting_for_approval
paused
resumed
artifact_ready
run_succeeded
run_failed
run_cancelled
run_reconciled
```

### 8.2 消息示例

开始：

```text
已创建 Run RUN-2026-001
目标：分析样本 A
模式：assist
当前阶段：reconnaissance
```

执行中：

```text
Run RUN-2026-001 进度
阶段：verification
最近动作：读取 Artifact art_01J...
已确认事实：4
待验证候选：1
下次动作：等待验证结果
```

需要人工确认：

```text
Run RUN-2026-001 等待批准
候选：completion_01J...
原因：需要执行外部提交
操作：/approve completion_01J...
或点击“批准”按钮
```

完成：

```text
Run RUN-2026-001 已完成
结果：SUCCEEDED
耗时：12m 31s
Evidence：6
Artifacts：3
报告：<内部链接>
```

### 8.3 节流和去重

- 同一个 Run 的普通进度消息默认 15 秒合并一次。
- `waiting_for_approval`、`paused`、`failed`、`succeeded` 不延迟。
- 相同 `runId + snapshot.version + eventType` 不重复发送。
- 单条消息限制在平台允许范围内；超长内容切片或只发 Artifact 链接。
- 限制每个会话每分钟的消息数量，防止工具循环造成消息风暴。
- 发送失败进入重试队列，但不阻塞 Agent Run。

## 9. 权限模型

建议使用三种角色：

| 角色 | 允许操作 |
| --- | --- |
| viewer | 查看状态、进度、非敏感 Artifact 摘要 |
| operator | 创建、绑定、发送消息、暂停、恢复、取消 |
| approver | 批准 Assist 候选和外部副作用 |
| owner | 修改绑定、撤销成员、查看完整审计 |

权限判断顺序：

1. 验证平台请求签名或连接认证。
2. 根据平台和发送者 ID 查找 ProofBlade identity。
3. 检查会话是否属于允许的群聊、项目和 Run。
4. 检查命令所需角色。
5. 将授权结果和拒绝原因写入审计记录。

不要只依赖群聊 ID。群成员变更后需要重新同步或定期校验成员权限。高风险操作必须要求明确的按钮确认或一次性确认码，而不是仅依赖自然语言。

## 10. 安全边界

### 10.1 网络暴露

- ProofBlade GUI 和 Control Store 默认只监听 `127.0.0.1`。
- 公网入口只暴露远程桥的 webhook 或反向代理。
- 远程桥调用 ProofBlade 时使用 loopback、Unix socket 或进程内服务接口。
- 不把 Control Store、Artifact 原始文件和模型 Provider API 直接暴露给 QQ/飞书。

### 10.2 敏感信息

- 访问令牌只放环境变量或系统密钥存储。
- 聊天消息不发送 flag、Provider key、完整请求头、完整命令输出和 secret Artifact 内容。
- 远程消息只发送脱敏摘要、哈希、状态和内部 Artifact 链接。
- URL、错误信息和日志继续使用现有脱敏逻辑。

### 10.3 执行控制

- 远程桥不能直接调用任意 shell。
- 所有执行继续经过现有 Tool、Capability Router、Effect Journal 和 Control Store。
- Assist 模式下，远程命令只能批准已经持久化且尚未失效的候选。
- Run、generation、lease 和 handoff 不匹配时拒绝控制命令。
- Run 已暂停时，远程桥不能直接提交完成或失败事件，只能调用显式恢复。

## 11. 幂等、重试和恢复

### 11.1 入站事件幂等

平台可能重试同一个事件。远程桥需要保存：

```text
inbound:<platform>:<eventId> -> accepted / processed / rejected
```

处理顺序：

1. 先以 `eventId` 判重。
2. 持久化 `received` 记录。
3. 解析并授权命令。
4. 写入命令或发送到 Run 服务。
5. 持久化 `processed` 或 `rejected`。
6. 返回平台要求的快速确认响应。

平台 webhook 的响应不应等待 Agent 完成。Agent 执行是异步任务，进度通过独立的出站消息发送。

### 11.2 出站消息重试

出站消息使用：

```text
outbound:<platform>:<conversationId>:<runId>:<eventType>:<snapshotVersion>
```

相同键只允许一条有效消息。网络失败按指数退避重试；超过上限后记录 `notification_failed`，但不改变 Run 的业务状态。

### 11.3 进程重启

远程桥重启后：

1. 从绑定存储恢复会话到 Run 的关系。
2. 从 Control Store 查询每个活动 Run 的最新快照。
3. 重新订阅事件或从最后一个已发送版本开始补发摘要。
4. 对运行中的 Run 发送一次 `recovered` 摘要。
5. 对已终止但未通知的 Run 补发最终结果。

远程桥不应该因为自身重启而重新启动 Agent；是否恢复执行由现有 Run Recovery 逻辑决定。

## 12. 配置草案

配置只表达接入和授权，不保存运行时状态：

```json
{
  "remoteControl": {
    "enabled": false,
    "projectRoot": "D:/AI/project/ProofBlade",
    "bind": "127.0.0.1",
    "port": 4310,
    "progressIntervalMs": 15000,
    "maxMessagesPerMinute": 20,
    "feishu": {
      "enabled": false,
      "appIdEnv": "PROOFBLADE_FEISHU_APP_ID",
      "appSecretEnv": "PROOFBLADE_FEISHU_APP_SECRET",
      "verificationTokenEnv": "PROOFBLADE_FEISHU_VERIFICATION_TOKEN",
      "encryptKeyEnv": "PROOFBLADE_FEISHU_ENCRYPT_KEY"
    },
    "qq": {
      "enabled": false,
      "mode": "official",
      "appIdEnv": "PROOFBLADE_QQ_APP_ID",
      "appSecretEnv": "PROOFBLADE_QQ_APP_SECRET",
      "onebotUrlEnv": "PROOFBLADE_ONEBOT_URL",
      "onebotTokenEnv": "PROOFBLADE_ONEBOT_TOKEN"
    },
    "identities": [
      {
        "platform": "feishu",
        "senderId": "ou_xxx",
        "conversationIds": ["oc_xxx"],
        "role": "owner",
        "projectRoots": ["D:/AI/project/ProofBlade"]
      }
    ]
  }
}
```

密钥字段只保存环境变量名，不保存密钥值。绑定、入站事件、出站消息和审计记录必须写入运行数据目录，而不是提交到仓库配置。

## 13. 实施阶段

### Phase 0：单向通知

- 只接飞书或 QQ 其中一个平台。
- 远程桥订阅 Run 事件。
- 只发送开始、暂停、失败、成功和 Artifact 摘要。
- 不允许远程命令控制。
- 验证消息限流、重试和进程重启恢复。

### Phase 1：查询和暂停

- 加入 `/status`、`/tail`、`/pause`。
- 加入身份绑定和 viewer/operator 角色。
- 验证重复事件、重复暂停和平台重试。

### Phase 2：创建、聊天和恢复

- 加入 `/run`、`/bind`、普通文本转发和 `/resume`。
- 一个会话只能有一个活动 Run。
- 增加 Run 创建失败、并发创建和终态 Run 的测试。

### Phase 3：Assist 审批

- 加入 `/approve` 和交互式消息卡片。
- 只允许批准当前 generation、当前 lease、未过期的候选。
- 审批前后发送完整审计事件。

### Phase 4：第二个平台和竞赛 Fleet

- 复用统一 `ChannelAdapter` 接入第二个平台。
- 增加 Fleet 的题目列表、并发、优先级、取消和单题错误摘要。
- 竞赛提交和外部副作用默认使用 Assist 或额外确认。

## 14. 测试计划

### 单元测试

- 命令解析：参数、未知命令、中文文本和超长输入。
- 身份映射：viewer/operator/approver/owner 权限矩阵。
- 入站事件幂等：相同 `eventId` 不重复创建 Run。
- 出站去重：相同快照版本不重复发送。
- 进度节流：高频事件合并、终态事件立即发送。
- 脱敏：flag、token、路径、请求头和 secret Artifact 不出现在消息中。

### 集成测试

- 模拟飞书事件验证、消息发送和按钮回调。
- 模拟 QQ 官方 API 或 OneBot 事件和动作。
- 远程桥调用真实 Control Store 创建、暂停和恢复 Run。
- Agent 执行过程中远程桥重启，恢复后不重复启动 Agent。
- 出站平台不可用时，Run 仍能完成，通知队列最终补发。

### 契约测试

- 每个平台适配器输出同一 `RemoteInboundMessage`。
- 同一个业务事件在不同平台都能生成稳定摘要。
- 远程桥不得绕过 Control Store 修改 Run 终态。
- GUI、CLI 和远程桥对同一个 Run 的快照必须一致。

## 15. 运维和审计

远程桥至少需要以下指标：

- 入站事件数、拒绝数、重复数。
- 每个命令的解析、授权和执行耗时。
- 出站消息成功、失败、重试和限流数量。
- 当前绑定数、活动 Run 数和等待审批数。
- 每个平台的 API 延迟和错误率。
- 最后一次 Control Store 同步时间。

审计记录至少包含：

```text
auditId
platform
conversationId
senderId
eventId
runId
command
authorizationResult
result
createdAt
```

不记录完整消息原文、访问令牌、flag 和 secret Artifact 内容；必要时记录正文哈希和脱敏摘要。

## 16. 暂不解决的问题

- 多租户项目隔离。
- 跨机器 Agent Worker 调度。
- 通过聊天直接修改项目配置或 Provider 配置。
- 让模型自行决定是否接受远程命令。
- 在没有人工确认的情况下执行不可逆外部操作。
- 将完整终端日志实时转发到聊天平台。

这些问题应在远程控制基础链路稳定后单独设计，不能通过放宽命令解析或直接暴露内部 HTTP API 解决。

## 17. 推荐决策

1. 首选飞书官方应用机器人作为第一个平台。
2. 新增独立 `apps/remote-bridge`，不把平台 SDK 混入 GUI Server。
3. 首版只实现单向通知、`/status`、`/pause` 和 `/resume`。
4. 继续使用 Control Store、Pi Session、Artifact Store 和现有恢复机制作为唯一状态来源。
5. Assist 审批稳定后，再接 QQ 官方 API 或 OneBot 11。
