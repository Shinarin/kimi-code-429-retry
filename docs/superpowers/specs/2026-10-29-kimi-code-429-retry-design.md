# Kimi Code 429 Retry 设计规范

## 目标

提供一个可直接通过 GitHub URL 安装的 Kimi Code 插件：当一次回合最终因临时性 HTTP 429 失败时，等待 60 秒，通过官方 CLI 会话恢复接口自动续跑一次。

## 已核实的官方边界

- 根目录 `kimi.plugin.json` 是受支持的 manifest；插件 hooks 在插件根目录执行，并获得 `KIMI_CODE_HOME` 与 `KIMI_PLUGIN_ROOT`。
- `StopFailure` 是观察事件，不能阻止失败或直接恢复原模型请求。`Stop` 不会在失败时代替它触发。
- `StopFailure` 输入包含 `session_id`、`cwd`、`error_type`、`error_message`。该字段形状已用 Kimi Code 2.4.0 与本地模拟 OpenAI 服务验证。
- `kimi --session <id> --prompt <text>` 是公开的恢复方式，会恢复已有会话；它不会向原交互窗口注入消息。
- 非交互 `--prompt` 按官方规则自动批准普通工具调用，静态拒绝规则仍然有效。本插件不添加 `--auto` 或 `--yolo`，但安装者必须清楚这一权限差异。
- CLI 自身已会重试临时错误。本插件只在这些内置尝试耗尽、回合最终失败后运行，不配置或修改内置重试。

官方依据：

- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html
- https://www.kimi.com/code/docs/en/kimi-code/error-reference.html

## 方案取舍

### 采用：官方 hook + 独立等待进程 + 官方会话恢复

优点是完全使用公开插件与 CLI 接口，不修改 CLI、不读取会话数据库、不需要 API 凭据。缺点是恢复结果不会自动出现在原交互窗口中，并且非交互续跑采用上述自动权限策略。

### 不采用：纯 Skill、system prompt 或 MCP

这些能力不能监听模型失败，也无法在无人操作时触发恢复，不能满足自动重试。

### 不采用：直接重放 HTTP 请求或修补 CLI 内部文件

插件没有官方模型请求拦截接口；直接访问凭据、会话存储或内部运行时既越界又脆弱。

## 产品规则

1. 默认等待严格为 60,000 ms。测试可注入时钟，集成测试可用环境变量缩短等待。
2. 仅当 `error_type` 为 `APIProviderRateLimitError`、错误消息包含独立的 HTTP 429 状态，且匹配官方列出的临时错误时调度：
   - `We're receiving too many requests`
   - `The engine is currently overloaded`
3. 其他错误类型、未知 429、额度/余额/组织限额、用户中断均不自动续跑。并发风控类消息不猜测为临时错误。
4. 每个最终失败只启动一个新的恢复进程。恢复进程通过 `KIMI_CODE_429_RETRY_ACTIVE=1` 标记，自己的失败不会再次自动调度，避免无限循环。
5. 恢复提示是固定文本，不包含服务端错误正文。它要求模型根据已有会话继续中断任务，并避免重复已经成功的副作用。
6. 会话 ID 只接受有限字符与长度；工作目录必须是绝对路径。使用参数数组启动 CLI，错误正文永不作为命令或提示执行。
7. 默认从 `PATH` 解析 `kimi`，Windows 同时支持原生 `.exe` 和 npm `.cmd`。可用 `KIMI_CODE_429_RETRY_CLI` 指定 CLI 可执行文件。
8. Node.js 20 或更新版本，零第三方运行时依赖。

## 状态所有者与事件顺序

状态只写入 `$KIMI_CODE_HOME/kimi-code-429-retry/`，不读取或修改 Kimi 的会话文件。每个会话最多一个 pending 记录；worker 是定时与恢复子进程的唯一所有者。记录包含随机会话任务令牌和时间；running 还包含 worker PID。不保存提示、错误正文或凭据。

```text
Kimi CLI                 StopFailure hook              Retry worker              活动 hooks
   | 临时性 429 最终失败      |                             |                         |
   |---------------------->| 校验并创建 pending            |                         |
   |                       | 启动独立 worker 后退出          |                         |
   |                       |---------------------------->| 等待至 retry_at            |
   | 用户新输入/退出/中断      |                             |                         | 删除 pending
   |-------------------------------------------------------------------------------->|
   |                       |                             | 原子领取 pending          |
   |                       |                             | 若已取消则退出             |
   |                       |                             | kimi --session ID -p 固定提示
   |                       |                             | 等待子进程并清理 running   |
```

- 重复失败事件看到有效 pending/running 时不重复调度；失活进程留下的记录可被后续失败安全替换。
- `UserPromptSubmit`、`SessionEnd`、`Interrupt` 取消尚未领取的 pending；`Stop` 清理成功手动恢复留下的等待记录。
- 领取与取消以文件系统的原子创建/重命名/删除协调；worker 领取后视为恢复已提交，活动 hook 不强行杀死模型进程。
- worker 崩溃不会反复发起请求；后续新失败可依据 pending 到期宽限期或 running PID 清理失活记录。
- 禁用插件会阻止新 hook，但不能撤销已经 detached 的 worker；文档提供删除 pending 的取消方式。

## 验收场景

- 临时性 429 触发一次调度，默认延迟为 60,000 ms；恢复参数包含正确的会话 ID、固定提示和原工作目录。
- 各类额度 429、401、未知错误、畸形 JSON、非法路径/会话 ID 不调度，不产生命令注入。
- 重复事件不重复恢复；恢复子进程的再次 429 不循环；新用户活动取消等待；失活状态可恢复。
- 在真实 Kimi CLI、隔离 `KIMI_CODE_HOME`、假 API 凭据和本地模拟服务中验证：创建会话 → 第二回合 429 → 插件等待 → 同一会话自动恢复成功。
- manifest 可由真实插件安装器加载；`/plugins info` 无诊断错误。安装、权限差异、结果查看和限制在 README 中明确。
- 主模型子代理独立审查后处理所有阻断问题，再推送公开仓库。

## 明确不做

- 不保证恢复原 HTTP 请求字节流，不保证原窗口实时显示恢复输出。
- 不对所有 429 无限重试，不等待配额周期重置，不绕过配额、权限或静态拒绝规则。
- 不读取、记录或上传凭据、完整会话、模型输出与错误正文。
