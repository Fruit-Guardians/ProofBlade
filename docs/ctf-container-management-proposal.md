# CTF 容器管理与自启动设计建议

本文以 PR #58 的 Docker runtime 为基线，给出容器、镜像、网络和工作区的管理方案。

## 1. 先区分镜像和容器

当前仓库构建了 5 个镜像：

| 镜像 | 用途 | 是否应常驻运行 |
| --- | --- | --- |
| `proofblade/ctf-base` | Web/Pwn 的公共基础层 | 否 |
| `proofblade/ctf-egress-gateway` | `target-only` 网络出口网关 | 仅在题目运行期间运行 |
| `proofblade/ctf-web` | Web 题工具环境 | 仅在 Web 题运行期间运行 |
| `proofblade/ctf-pwn` | Pwn 题工具环境 | 仅在 Pwn 题运行期间运行 |
| `proofblade/ctf-pwn-kernel` | Kernel Pwn 专用环境 | 仅在明确选择该 profile 时运行 |

`docker build` 只生成镜像，不会启动容器。当前 `DockerContainerRuntime.create()` 在
`target-only` 模式下为一个题目启动一对容器：

```text
一个 challenge run
  ├─ solver container
  └─ egress gateway container
       └─ 一个专用 Docker network
```

因此并发 `N` 个题目时，预期是 `N` 个 solver 容器、`N` 个 gateway 容器和 `N` 个网络，
而不是固定的 5 个容器。`bridge` 模式只有 solver 容器，`none` 模式也只有 solver 容器。

## 2. 当前实现需要补齐的管理问题

1. 容器使用 `sleep infinity` 作为主进程，没有 `--restart` 策略，也没有应用重启后的恢复入口。
2. `staleContainerTtlMs` 只存在于配置，没有被回收逻辑使用。
3. `reapStale()` 必须传入 `runId`，会删除该 run 下所有容器，不能区分活跃容器和陈旧容器，也不回收 gateway network。
4. 没有生产调用点触发 `reapStale()`，进程崩溃后容器和网络可能长期残留。
5. solver 固定使用 UID `1001:1001`，但宿主机创建的 bind mount 工作区没有统一的 Linux ownership/权限策略。
6. `latest` 镜像标签可变，配置虽然记录了 image digest，但创建前没有强制 digest pin 或签名校验。
7. `pwn-kernel` 镜像已构建，但当前 challenge category 映射只选择 `web` 和 `pwn`，没有明确的 kernel profile 路由。
8. 目标解析和 gateway 规则只覆盖 IPv4/TCP；UDP、IPv6、多个端口和 DNS 解析变化没有完整生命周期定义。
9. Docker daemon 不可用时只在单题 solve 过程中失败，缺少启动时 doctor、GUI 状态和可操作的恢复提示。

## 3. 推荐的自启动策略

### 3.1 不建议给题目容器设置 `restart: always`

题目容器不是长期服务。直接设置 `restart: always` 会产生三个问题：

- Docker Desktop 或主机重启后，旧题目会被无条件复活；
- 已结束的题目会继续占用 CPU、内存、网络和目标环境；
- gateway 与 solver 的配对关系、Control Store generation 和平台环境状态可能已经失效。

题目容器建议使用：

```text
--restart=no
```

自启动应由 ProofBlade 的 host-side `ContainerManager` 完成：应用启动时读取持久化租约，
判断哪些 run 仍然有效，再有条件地重建容器。这样“重启”是一次受控恢复，而不是 Docker
盲目拉起旧进程。

### 3.2 推荐增加 host-side ContainerManager

ContainerManager 与 `DockerContainerRuntime` 分工如下：

```text
ContainerManager
  ├─ startup()/shutdown()
  ├─ doctor()
  ├─ reconcile()
  ├─ heartbeat()
  ├─ ensureRun(runId)
  ├─ stopRun(runId)
  └─ reap()

DockerContainerRuntime
  ├─ create()
  ├─ exec()
  ├─ health()
  └─ destroy()
```

ContainerManager 运行在 ProofBlade 主进程或独立的 Windows Service/systemd service 中，
不放进题目容器，也不把 Docker socket 暴露给模型。启动流程：

1. 读取并校验 `proofblade.config.json`。
2. 执行 Docker daemon doctor，检查 Docker CLI、daemon、磁盘空间和所需镜像。
3. 扫描 `proofblade.managed=true` 标签的容器和网络。
4. 读取 Control Store 中的 run 状态、generation、lease 和 heartbeat。
5. 对每个资源执行 reconcile：恢复、停止、标记 orphan，或回收。
6. 只为仍处于 `RUNNING`/`PAUSED` 且 lease 未过期的 run 重建容器。
7. 启动周期 heartbeat 和回收定时器。

推荐的启动模式：

```json
{
  "execution": {
    "backend": "docker",
    "startupMode": "manager-reconcile",
    "containerRestartPolicy": "never",
    "reconcileOnStartup": true,
    "reconcileIntervalMs": 30000,
    "heartbeatIntervalMs": 10000,
    "shutdownGraceMs": 10000
  }
}
```

以上字段是建议的新增配置，当前 schema 尚未全部实现，不能直接写入现有配置而不更新
`validateConfig()`。

### 3.3 两种启动模式

**按需模式（推荐默认）**

- ProofBlade 启动时只 doctor 和预热镜像，不创建 solver/gateway 容器。
- 开始 challenge 时创建容器。
- challenge 结束、取消、超时或平台环境释放后立即销毁容器和 network。

**恢复模式（可选）**

- ProofBlade 启动时扫描未完成 run。
- 只有 lease、heartbeat、generation 和平台环境仍有效时才恢复。
- 恢复失败则将 run 标记为 `ORPHANED`，不循环重启；由 operator 明确执行 retry/recreate。

镜像可以预热，运行容器不要预创建。这样既能减少首次启动延迟，也不会产生大量空闲容器。

### 3.4 宿主机自启动

Linux 推荐用 systemd 启动 ProofBlade manager，而不是让五个镜像对应五个 service：

```ini
[Unit]
Description=ProofBlade Container Manager
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/proofblade
ExecStart=/usr/bin/node apps/cli/dist/main.js containers manager
ExecStop=/usr/bin/node apps/cli/dist/main.js containers shutdown
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
Environment=NODE_ENV=production
User=proofblade
Group=proofblade

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` 只重启 manager。manager 启动后执行 reconcile；题目容器仍是
`--restart=no`。service 账号应加入受控的 Docker 访问组，并只拥有 ProofBlade 数据目录，
不要使用 root 工作目录。

Windows Docker Desktop 推荐配置“登录后启动 Docker Desktop”，再通过 Windows Service
或任务计划程序启动 ProofBlade manager：

```text
Trigger: At startup 或 At log on
Program: node.exe
Arguments: apps/cli/dist/main.js containers manager
Start in: D:\AI\project\ProofBlade
Retry: 每 30 秒一次，最多 10 次
Stop: 调用 containers shutdown，等待 20 秒后才强制结束
```

manager 的 `startup()` 应以 bounded retry 等待 `docker version` 成功，不能假设 Docker
Desktop 与任务计划同时就绪。超过启动等待时间后进入 `DEGRADED` 状态，GUI 显示 daemon
不可用，但不创建或删除任何题目资源。

不建议用 Docker Compose 声明五个常驻 service。Compose 可以作为五个镜像的 build 文件，
但 solver/gateway 的数量、目标规则和生命周期由 challenge run 动态决定，不适合静态副本数。

## 4. 资源命名、标签和持久化记录

### 4.1 名称

不要只依赖截断后的 run id。建议使用稳定 slug 加短 hash：

```text
proofblade-<run-slug>-<run-hash>-g<generation>-solver
proofblade-<run-slug>-<run-hash>-g<generation>-gateway
proofblade-<run-slug>-<run-hash>-g<generation>-net
```

### 4.2 必须的 Docker labels

```text
proofblade.managed=true
proofblade.schema=1
proofblade.kind=solver|gateway|network
proofblade.run_id=<完整 run id>
proofblade.generation=<整数>
proofblade.profile=web|pwn|pwn-kernel|gateway
proofblade.image_digest=sha256:...
proofblade.created_at=<UTC ISO-8601>
proofblade.lease_id=<租约 id>
proofblade.expires_at=<UTC ISO-8601>
proofblade.parent_id=<solver 或 gateway 的关联 id>
proofblade.restart_policy=never|manager
```

`run_id`、`lease_id` 和 `generation` 必须同时存在。回收不能只用容器名字匹配。

### 4.3 宿主机 runtime record

在 `runs/<run-id>/.proofblade-runtime/container.json` 保存：

```json
{
  "schemaVersion": 1,
  "runId": "CH-1001-1710000000000",
  "generation": 1,
  "solverContainerId": "...",
  "gatewayContainerId": "...",
  "networkName": "...",
  "profile": "pwn",
  "imageDigest": "sha256:...",
  "workspaceHostPath": "...",
  "state": "RUNNING",
  "leaseId": "...",
  "lastHeartbeatAt": "2026-08-19T10:00:00.000Z",
  "expiresAt": "2026-08-19T11:00:00.000Z"
}
```

该文件是恢复索引，不是安全边界；恢复前仍必须以 Docker labels、Control Store 和
平台状态交叉校验。

## 5. 生命周期状态机

```text
NEW
  -> PREFLIGHT_OK
  -> NETWORK_CREATED
  -> GATEWAY_READY
  -> SOLVER_READY
  -> RUNNING
  -> DRAINING
  -> STOPPED
```

异常状态：

```text
任何状态 -> FAILED
Docker/应用崩溃后 -> ORPHANED
ORPHANED + lease 仍有效 -> RECOVERING -> RUNNING
ORPHANED + lease 过期 -> REAPING -> REAPED
```

每一步都要持久化状态。创建顺序必须是：

1. 校验 workspace、image digest、资源限制和目标列表。
2. 创建 network，并写入 network labels。
3. 创建 gateway，等待 `health` 和规则初始化成功。
4. 创建 solver，等待 `State.Running=true`。
5. 在 solver 内执行 `/workspace/.proofblade/ready` 写入测试。
6. 写入 runtime record，最后才把 run 状态推进到 `RUNNING`。

失败回滚必须反向执行：solver -> gateway -> network，并且每一步幂等。

## 6. 健康检查与自恢复

### 6.1 Doctor

启动和 GUI 应显示以下维度：

- Docker CLI 是否安装；
- daemon 是否可连接；
- Docker server 版本和 rootless/desktop 模式；
- 所需镜像是否存在、digest 是否匹配；
- Docker 磁盘空间和内存配额；
- target-only 所需的 iptables/capability 是否可用；
- workspace 是否可读写；
- 已管理容器和网络数量。

### 6.2 Liveness

每 10 秒检查：

- solver 和 gateway 是否仍在运行；
- solver 的 generation 是否匹配；
- runtime record heartbeat 是否更新；
- gateway 的 network namespace 是否仍与 solver 绑定；
- 目标 endpoint 是否仍在允许列表中。

连续 3 次失败后停止该 run，不应无限重启。

### 6.3 Readiness

只有以下条件全部满足才允许模型进入工具循环：

- solver `State.Running=true`；
- `/workspace` 写入探针成功；
- skills 只读挂载可读；
- network policy 已安装；
- gateway 初始化脚本退出码为 0；
- 容器内没有平台 key、模型 key 或 Docker socket。

## 7. 回收策略

回收必须由 manager 定时执行，不能只提供一个未调用的 `reapStale()` 方法。

推荐规则：

| 条件 | 动作 |
| --- | --- |
| run 已完成且容器仍存在 | 立即 destroy solver、gateway、network |
| lease 已过期 | 标记 `ORPHANED`，宽限 60 秒后回收 |
| 无 runtime record 但有 managed label | 按 `created_at` + heartbeat 判断，不能直接按 run id 全删 |
| gateway 缺失、solver 存在 | 停止 solver，重新创建整组，不单独补 gateway |
| solver 缺失、gateway 存在 | 停止 gateway 并回收 network |
| network 存在但两端容器都不存在 | 回收 network |
| image digest 不匹配 | 不复用旧容器，创建新 generation |

`reapStale()` 建议改为：

```ts
reconcile(options?: {
  runId?: string;
  olderThanMs?: number;
  includeActive?: boolean;
}): Promise<ReconcileReport>;
```

实现时先 `docker inspect` 读取 `Created`、labels、State 和 network，再决定动作；不能把
`docker ps -aq --filter run_id` 的所有结果直接 `rm -f`。

## 8. 自启动与关闭时序

### 应用启动

```text
load config
  -> docker doctor
  -> load control store + runtime records
  -> scan managed resources
  -> reconcile
  -> prewarm images
  -> start heartbeat/reaper
  -> accept new challenge runs
```

### 应用关闭

```text
stop accepting new runs
  -> mark active runs DRAINING
  -> abort model/tool loops
  -> wait shutdownGraceMs
  -> destroy solver/gateway/network
  -> persist STOPPED or ORPHANED
  -> close Docker transport
```

正常退出应销毁本进程创建的资源；异常退出则依赖下次启动 reconcile，而不是依赖 Docker
自动 restart。

## 9. 配置建议

建议把现有 `execution` 扩展为以下结构：

```json
{
  "execution": {
    "backend": "docker",
    "requireFor": ["web", "pwn"],
    "networkPolicy": "target-only",
    "pullPolicy": "if-missing",
    "imagePolicy": {
      "requireDigest": true,
      "allowMutableTags": false,
      "verifySignature": false
    },
    "lifecycle": {
      "startupMode": "manager-reconcile",
      "containerRestartPolicy": "never",
      "reconcileOnStartup": true,
      "reconcileIntervalMs": 30000,
      "heartbeatIntervalMs": 10000,
      "staleContainerTtlMs": 3600000,
      "orphanGraceMs": 60000,
      "shutdownGraceMs": 10000,
      "maxRestartAttempts": 1
    },
    "workspace": {
      "mode": "managed-volume",
      "containerUid": 1001,
      "containerGid": 1001,
      "writeProbe": true,
      "cleanupAfterRun": false
    },
    "limits": {
      "memory": "4g",
      "cpus": "2",
      "pids": 512,
      "shmSize": "1g",
      "commandHardTimeoutMs": 600000,
      "outputPreviewBytes": 50000
    }
  }
}
```

### Workspace 模式选择

推荐优先使用 Docker named volume 或每个 run 一个 managed volume，由容器用户直接拥有；
宿主机需要读取时通过受控导出/归档同步。若必须 bind mount：

- Linux：创建目录后 `chown 1001:1001`，或创建匹配宿主用户的 image user；
- Windows Docker Desktop：启动前做写入探针，不把 Desktop 的 ACL 行为当成 Linux 权限保证；
- 不允许把整个 ProofBlade 根目录挂载进容器；
- skills 使用只读 mount，runtime metadata、Control Store 和 credentials 不挂载。

## 10. 网络策略建议

### target-only

- gateway 和 solver 必须是同一网络 namespace 的成对资源；
- 目标解析结果要保存 protocol、IPv4/IPv6、host、port；
- 允许列表变化时创建新 generation，不在运行中扩大旧规则；
- DNS 只允许必要的 resolver，避免默认放行整个 DNS 通道；
- UDP 不支持时应显式拒绝，不要静默改为 TCP。

### none

离线 reverse/crypto/forensics 优先使用，只有 solver 容器。

### bridge

只作为本地开发模式，生产 competition 配置不应默认使用。

## 11. 镜像构建与版本管理

当前构建脚本使用 `latest`，建议改为版本化 tag：

```text
proofblade/ctf-web:2026.08.19
proofblade/ctf-pwn:2026.08.19
proofblade/ctf-pwn-kernel:2026.08.19
proofblade/ctf-egress-gateway:2026.08.19
```

发布流程：

1. 固定基础镜像 digest，不使用无约束的 `ubuntu:24.04`/`alpine:3.20`。
2. 构建后记录 image ID 和 digest。
3. 运行配置只接受 digest 或不可变 tag。
4. CI 构建五个镜像并运行 doctor、create、exec、health、destroy 集成测试。
5. 新镜像只用于新 generation，旧 run 不热替换。
6. `pwn-kernel` 必须有明确的 challenge category/profile 映射；未映射前不要宣称已支持。

## 12. 建议的实现顺序

### P0：先修生命周期安全

1. 增加 `ContainerManager` 和启动 reconcile。
2. 为每个资源补全 labels、runtime record 和 lease。
3. 修复 `reapStale()` 的年龄判断、活跃保护、gateway/network 回收。
4. 所有题目容器显式使用 `restart=no`。
5. 增加 solver/gateway 成对回滚和 shutdown cleanup。

### P1：修复可运行性

1. 解决 Linux bind mount UID/ownership，或切换 managed volume。
2. 增加 workspace write probe 和 readiness gate。
3. image digest pin、磁盘空间检查和 Docker doctor UI。
4. 把 `pwn-kernel` 接入 profile 选择，或从默认构建/配置中移除。

### P2：完善协议和运维

1. 完整保存 TCP/UDP/IPv4/IPv6 target metadata。
2. 移除 Docker runner 的 AbortSignal listener 泄漏。
3. 增加 manager metrics：active、orphaned、reaped、restart attempts、image pull time。
4. 增加 CLI：`containers doctor|list|reconcile|stop|reap|logs`。

## 13. 推荐运维命令

在 manager CLI 完成前，可以先使用只读检查：

```powershell
docker ps -a --filter label=proofblade.managed=true
docker network ls --filter label=proofblade.managed=true
docker image ls proofblade/ctf-web proofblade/ctf-pwn proofblade/ctf-pwn-kernel proofblade/ctf-egress-gateway
docker inspect --format '{{.Name}} {{.State.Status}} {{.Config.Labels}}' <container-id>
```

不要直接执行按 run id 的批量 `docker rm -f`，应先确认 lease、generation、created time 和
solver/gateway 配对关系。

## 14. 结论

五个镜像不应做成五个常驻容器。推荐“镜像预热 + 题目按需创建 + host-side manager 恢复”的
模式：Docker 负责运行隔离，ProofBlade 负责状态、租约、恢复和回收。容器不使用盲目自启动，
而是由 manager 在应用启动时根据持久化状态有条件重建。这样可以同时解决 Docker Desktop 重启、
ProofBlade 崩溃、题目取消、平台环境过期和多题并发时的资源泄漏问题。
