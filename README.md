# Kimi Code 429 Retry

一个使用官方 manifest、hooks 和 Server API 的 Kimi Code 插件：在 **Kimi Code Desktop / `kimi web`** 中，当回合最终因**临时性 HTTP 429**失败时，等待 **60 秒**，向原会话自动提交一次恢复提示。

**额度耗尽不重试。** 5 小时、每周、每月额度、账户余额及组织额度限制都不会触发恢复；未知 429 也不会被猜测为临时错误。

## 平台范围与限制

- **支持：** Kimi Code Desktop、运行中的 `kimi web`，以及它们使用的 loopback Server API。
- **不支持普通交互 TUI。** TUI 没有 Server API；第二个 CLI 进程恢复或 fork 活动会话又会被会话锁拒绝。本插件不保留这些表面可用、实际失败的路径。
- 恢复不是原 HTTP 请求的字节重放，而是向原会话提交一条固定用户提示，让模型依据上下文继续任务并检查已完成的副作用。
- 每次自动恢复最多被接受一次。恢复提示自身再次失败不会无限重试；真实用户开始新回合后可重新获得一次自动恢复资格。
- CLI 自身会先重试临时错误。本插件只处理内置尝试耗尽后最终触发的 `StopFailure`，不会修改内置重试间隔。
- 不提交 `permission_mode`、模型或其他覆盖项，沿用原会话配置。
- Server API 是官方**实验性**接口，协议以运行版本的 `/openapi.json` 为准。本仓库以 **Kimi Code 2.4.0** 验证。

## 哪些 429 会重试

必须同时满足：

1. `error_type` 为 `APIProviderRateLimitError`；
2. 错误消息包含独立的 HTTP 状态 `429`；
3. 消息匹配以下官方临时错误之一：
   - `We're receiving too many requests`
   - `The engine is currently overloaded`

以下情况明确不重试：

- `You've reached your 5-hour usage limit`
- `You've reached your weekly (7-day) usage limit`
- `You've reached your monthly usage limit for this billing cycle`
- `Your credit balance is insufficient`
- 组织 Extra Usage 余额或限额耗尽
- 并发风控限制、未知 429、401/403、其他 HTTP 错误及用户主动中断

## 环境要求

- Desktop 或 `kimi web` 的本地服务器正在运行。
- Node.js **20 或更新版本**，并确保 `node` 在 `PATH` 中。
- 支持插件 hooks、`StopFailure` 和 Server API 的 Kimi Code 版本。

插件零第三方运行时依赖，不读取或修改 Kimi 的会话数据库，也不需要读取模型 API 凭据。

## 安装

在 Kimi Code 中执行：

```text
/plugins install https://github.com/Shinarin/kimi-code-429-retry
/plugins info kimi-code-429-retry
/reload
```

也可以重启 Desktop 或 `kimi web` 使插件生效。`/plugins info` 应显示 `Status: enabled | state: ok`。

如果只使用 CLI，可先在 TUI 中通过上述命令完成安装，再启动：

```bash
kimi web
```

安装本地源码目录：

```text
/plugins install <本地插件目录>
/reload
```

官方安装器会把插件复制到 `$KIMI_CODE_HOME/plugins/managed/kimi-code-429-retry/`，实际运行该副本。修改源码目录后需要重新安装。

## 工作方式

```text
临时性 429 → StopFailure → 创建 pending → worker 等待 60 秒
                                             ↓
真实用户活动 → 取消 pending              发现唯一 loopback server
                                             ↓
                              POST 固定提示到原 session ID
                                             ↓
                       result=accepted → 成功 Stop 后清理 result
```

恢复提示会出现在原会话中，结果也可直接在该会话查看。API 返回“已接受”后，worker 不等待回合结束，也不会自动重复 POST。

### Server 与 token 安全

- worker 从 `$KIMI_CODE_HOME/server.token` 读取本地 bearer token，仅在内存中使用，不写入插件状态或日志。
- token 只发往 `127.0.0.1`、`localhost` 或 `[::1]`；非 loopback URL 会被拒绝。
- 自动发现要求恰好一个注册 server 能确认该会话。多个匹配时安全放弃，不猜测归属。
- 可通过 `KIMI_CODE_429_RETRY_SERVER_URL` 指定唯一的 loopback HTTP URL，例如 `http://127.0.0.1:58627`。

## 状态、取消与卸载

状态仅保存在 `$KIMI_CODE_HOME/kimi-code-429-retry/`，包含会话 ID、原工作目录、时间、随机任务令牌、PID 和状态；不保存 server token、API 错误正文、提示内容或模型输出。

- **取消尚未开始的等待：** 在同一会话提交真实新消息、退出或中断，或者删除：

  ```text
  $KIMI_CODE_HOME/kimi-code-429-retry/sessions/<session_id>/pending.json
  ```

- **查看提交状态：** 同目录的 `result.json` 可能为 `submitting`、`accepted` 或 `failed`。成功 `Stop` 会清除该文件；`failed` 不记录服务端错误正文。
- **中止已接受的恢复：** 使用客户端现有的中止功能；删除 pending 或 running 文件不会强制停止模型回合。
- **禁用：** `/plugins disable kimi-code-429-retry`，然后 `/reload`。禁用阻止新 hook；已 detached 的 worker 需先通过删除 pending 取消。
- **卸载：** `/plugins remove kimi-code-429-retry`。按官方行为，卸载只删除安装记录，不删除 managed 副本；插件状态目录可按需手动删除。

## 配置

通常无需配置。

- `KIMI_CODE_429_RETRY_SERVER_URL`：显式指定 loopback Server URL，用于多实例环境。
- `KIMI_CODE_429_RETRY_DELAY_MS`：等待毫秒数，默认 `60000`。主要供集成测试缩短等待；正常使用建议保持一分钟。

## 开发与验证

```bash
pnpm install
pnpm test:unit
pnpm test:integration
pnpm test
```

单元测试使用 Node.js 内置测试运行器。集成测试通过真实安装器加载插件，再启动隔离 `kimi web` 和本地模拟 OpenAI 服务，验证同一 session ID 的完整恢复。`node-pty` 只是开发测试依赖。

测试使用隔离 `KIMI_CODE_HOME`、假模型凭据和独立 server token，不读取正式配置、不消耗真实模型额度。临时产物位于项目 `.tmp/`，已被 Git 忽略。

## 官方依据

- [Plugins：manifest、安装和插件 hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)
- [Hooks：事件、输入和返回值](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)
- [Local Server and API](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/server.html)
- [Server API reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
- [CLI 内置重试规则](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html#loop_control)
- [错误参考：临时 429 与额度限制](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html)

## License

[MIT](./LICENSE)
