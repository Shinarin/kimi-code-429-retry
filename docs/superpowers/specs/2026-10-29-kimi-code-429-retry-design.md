# Kimi Code 429 Retry 设计规范

## 目标

提供一个可通过 GitHub URL 安装的 Kimi Code 插件：在 **Kimi Code Desktop 或 `kimi web`** 中，当回合最终因临时性 HTTP 429 失败时，等待 60 秒，通过官方 loopback Server API 向**原会话**提交一次固定恢复提示。

普通交互 TUI 不在支持范围内：它没有 Server API，第二进程的 `--session` 与 `fork` 又都被活动会话锁拒绝。

## 已核实的边界

- 根目录 `kimi.plugin.json` 是受支持的 manifest；插件 hooks 在插件根目录执行，并获得 `KIMI_CODE_HOME` 与 `KIMI_PLUGIN_ROOT`。
- `StopFailure` 是观察事件，不能恢复原模型请求。真实事件包含 `session_id`、`cwd`、`client_type`、`error_type`、`error_message`。
- 真实交互测试确认：成功回合触发 `Stop`，429 只触发 `StopFailure`，之后没有可用于继续回合的 `Stop`。
- 真实 2.4.0 测试确认：活动会话仍打开时，第二 CLI 进程恢复或 fork 都返回 `This session is in use by another Kimi Code CLI instance.`。
- `kimi web` 提供 `POST /api/v1/sessions/{id}/prompts`，可向现有会话提交提示；不传 `permission_mode` 即不主动覆盖会话权限。响应在提示被接受后返回，不等待回合结束。
- 同一 home 的实例注册在 `server/instances/*.json`，当前记录含 `pid`、`host`、`port`、`started_at`、`heartbeat_at`。共享 bearer token 位于 `server.token`。
- Server API 是官方但实验性的接口，必须以运行版本的 `/openapi.json` 为最终协议依据。本插件以 2.4.0 验证，不宣称跨版本稳定性。
- CLI 自身已会重试临时错误。本插件只处理这些内置尝试耗尽后的最终失败。

官方依据：

- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/guides/server.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html#loop_control
- https://www.kimi.com/code/docs/en/kimi-code/error-reference.html

## 方案取舍

### 采用：官方 hook + 独立 worker + loopback Server API

能在 Desktop/Web 的现有会话中继续，不创建分支、不结束原进程、不读取会话数据库，也不改变权限模式。限制是只支持有本地 server 的客户端，API 为实验性，且需要安全地读取本机 server token。

### 不采用：CLI 恢复、fork 或阻塞 Stop

前两者受活动会话锁限制；429 后没有 `Stop` 可阻塞。保留这些路径会产生名义上重试、实际失败的行为。

### 不采用：纯 Skill、MCP、直接重放 HTTP 或修补内部文件

Skill/MCP 无失败监听能力；插件没有模型请求拦截接口。直接读取模型凭据、会话数据库或内部运行时越界且脆弱。

## 产品规则

1. 默认等待严格为 60,000 ms；测试可注入时钟或用环境变量缩短。
2. 仅当 `error_type` 为 `APIProviderRateLimitError`、消息含独立 429 状态，且匹配以下官方临时错误时调度：
   - `We're receiving too many requests`
   - `The engine is currently overloaded`
3. **额度耗绝不重试。** 5 小时、每周、每月额度、余额、组织额度、并发风控、未知 429、401/403 和用户中断均不调度。
4. 每个自动恢复提示最多被接受一次；该提示自身失败不得再次自动调度。后续真实用户新回合可重新获得一次自动恢复资格。
5. 恢复提示为固定文本，不含服务端错误正文；它要求模型根据原会话继续任务，并检查已完成的副作用。
6. 会话 ID 只接受 `[A-Za-z0-9_-]` 且最长 128；工作目录必须为绝对路径。
7. worker 从 `server.token` 读取 token，仅在内存中用于 loopback 请求。不得记录 token，也不得把它发送到非 loopback URL。
8. 自动发现要求恰好一个注册 server 能确认该会话；多个匹配时安全放弃。可用 `KIMI_CODE_429_RETRY_SERVER_URL` 显式指定唯一 loopback URL。
9. POST body 只含 `content`，不传 `permission_mode`、模型或其他覆盖项。API 接受即视为已提交，不等待模型回合结束，也不自动重复 POST。
10. Node.js 20+，零第三方运行时依赖；`node-pty` 仅作为真实安装器的开发测试依赖。

## 状态所有者与事件顺序

状态只写入 `$KIMI_CODE_HOME/kimi-code-429-retry/`。每个源会话有 pending/running/result 三类记录；worker 独占计时和 API 提交，活动 hook 独占用户活动取消与自动提示标记。记录只含会话 ID、cwd、时间、随机 token、PID 和状态，不含 server token、错误正文、提示或模型输出。

```text
Server/Desktop            StopFailure hook             Retry worker              活动 hooks
   | 临时性 429 最终失败      |                             |                         |
   |---------------------->| 创建 pending                |                         |
   |                       | 启动独立 worker              |                         |
   |                       |---------------------------->| 等待至 retry_at            |
   | 真实用户活动             |                             |                         | 删除 pending/result
   |-------------------------------------------------------------------------------->|
   |                       |                             | 领取 pending；发现唯一 server
   |                       |                             | POST 固定提示到原会话       |
   | 自动提示 UserPromptSubmit |                             |                         | 写入 result=submitting
   |<----------------------|-----------------------------|-------------------------|
   | API 接受               |                             | 写入 result=accepted       |
   | 成功 Stop              |                             |                         | 删除 result
   | 自动提示再次 429         | result 已存在，拒绝重复调度    |                         |
```

- pending/running 去重；失活记录由后续失败根据到期宽限期或 PID 安全替换。
- `submitting` 先于 API 返回写入，保证快速失败也不会绕过防递归；`accepted` 在其后写入。
- 真实 `UserPromptSubmit`、`Stop`、`SessionEnd`、`Interrupt` 清理相应状态。缺少 prompt 字段时不清除防递归 result，宁可跳过一次也不无限重试。
- 取消只作用于尚未领取的 pending；已接受的提示应通过客户端现有中止能力处理。
- 禁用插件阻止新 hook；已经 detached 的 worker 需通过删除 pending 取消。

## 验收场景

- 默认延迟为 60,000 ms；只向原会话 POST 一次固定提示，不带权限覆盖，不产生 shell 命令。
- 所有额度/余额/组织限额与未知错误不调度；畸形输入、非法 ID、非 loopback URL 和多 server 归属歧义安全拒绝。
- pending/running 去重、活动取消、失活恢复、自动提示防递归和后续真实提示重置均有测试。
- 真实安装器显示 `Status: enabled | state: ok`；隔离 `kimi web` 中创建会话 → 首次成功 → 第二次 429 → 自动向同一 session ID 提交恢复 → 历史含成功结果，且不创建 fork。
- README 明确 Desktop/Web 范围、TUI 不支持、实验性 API、token 边界、结果查看和取消方式。
- 主模型子代理独立审查并修正阻断问题后再公开推送。

## 明确不做

- 不支持普通交互 TUI，不承诺恢复原 HTTP 字节流，不无限重试，不等待配额重置。
- 不覆盖权限模式，不绕过配额或静态拒绝，不记录/上传 token、完整会话、模型输出或错误正文。
