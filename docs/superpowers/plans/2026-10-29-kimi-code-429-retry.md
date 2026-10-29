# Kimi Code 429 Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建官方格式的 Kimi Code 插件，在 Desktop/Web 最终临时性 429 后等待 60 秒，向原会话提交一次恢复提示。

**Architecture:** `StopFailure` hook 分类并调度；独立 Node worker 持有计时、发现并认证唯一 loopback server，通过公开 Server API 提交固定提示。活动 hooks 取消等待并防止自动提示递归。普通 TUI 明确不支持。

**Tech Stack:** Node.js 20+ ESM、`node:test`、Kimi Code manifest/hooks/Server API；零运行时依赖，`node-pty` 仅用于安装器集成测试。

**Spec:** `docs/superpowers/specs/2026-10-29-kimi-code-429-retry-design.md`

## Global Constraints

- 默认 60,000 ms，每个自动提示只接受一次且不得递归；真实用户后续回合可重置。
- 只重试两类临时 429，所有额度/余额/组织限制绝不重试。
- token 仅用于 loopback，不记录；不传权限覆盖，不读会话数据库，不把错误正文放入提示或 shell。
- 多 server 归属不唯一时安全放弃；普通 TUI 不宣称支持。

## Review Focus

- 额度耗尽：由分类测试证明不调度。
- 自动提示快速再次失败：由 submitting/accepted 状态测试证明不递归。
- 多实例、失效注册、非 loopback URL：由发现与 API 测试证明不发错目标。
- 活动取消与状态竞争：由状态测试证明不会重复提交。
- 真实原会话恢复：由隔离 `kimi web` 端到端测试证明。

---

### Task 1: 429 分类与测试基线

**Files:** `package.json`、`lib/rate-limit.mjs`、`test/rate-limit.test.mjs`

- [x] 先写临时与额度/未知错误测试并观察失败，再实现 `shouldRetry(payload): boolean`；15 项通过。

### Task 2: 调度、取消与恢复执行

**Files:** `lib/retry.mjs`、`lib/server.mjs`、三个 hook 入口、`test/retry.test.mjs`、`test/server.test.mjs`、`test/hooks.test.mjs`

**Interfaces:** `scheduleRetry(payload, options)`、`runWorker(sessionId, token, options)`、`cancelRetry(payload, options)`；`launchRecovery(record, options)` 发现并调用唯一 server。

- [ ] 先写默认延迟、去重、取消、失活、防递归和 API 请求测试，再实现状态机与 loopback discovery。
- [ ] 验证 token 不泄漏、多实例拒绝、无权限覆盖、接受后不重复 POST、失败不写错误正文。
- [ ] 验证三个入口对畸形输入安全退出。

### Task 3: 官方打包与真实 Kimi Web 验证

**Files:** `kimi.plugin.json`、`README.md`、`LICENSE`、`test/manifest.test.mjs`、`test/integration/kimi-web.test.mjs`

- [ ] 先验证 manifest 字段、事件与文件路径，再编写文档。
- [ ] 真实安装器显示 enabled/state ok；隔离 `kimi web` 和模拟 OpenAI 服务验证同一 session ID 的完整恢复。
- [ ] 执行完整 `npm test`、语法/包内容检查；删除已证伪的 CLI/fork 路径，不将旧失败隐藏为通过。

### Task 4: 独立审查与发布

- [ ] 使用 `model: primary` 的 coder 子代理只读审查规范、实现和验证证据。
- [ ] 对 Critical/Important 发现先复现并按 TDD 修正，再跑完整验证。
- [ ] 清理 `.tmp`，创建 `Shinarin/kimi-code-429-retry` 公开仓库并推送默认分支。
- [ ] 用 GitHub API 核验可见性、默认分支和提交一致性，报告验证与平台边界。
