# Kimi Code 429 Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建可按官方方式安装的 Kimi Code 插件，在最终临时性 429 后等待 60 秒并安全地自动恢复会话一次。

**Architecture:** `StopFailure` hook 只负责分类与调度，独立 Node worker 持有计时和恢复子进程，活动 hooks 取消未开始的等待。所有恢复通过公开的 `kimi --session --prompt`，状态仅保存在插件自己的 Kimi home 子目录。

**Tech Stack:** Node.js 20+ ESM、`node:test`、Kimi Code manifest/hooks/CLI，无第三方运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-29-kimi-code-429-retry-design.md`

## Global Constraints

- 默认延迟 60,000 ms；每个最终临时性 429 只恢复一次，恢复进程不得再次自动调度。
- 只重试规范列出的两类临时 429；非临时错误、非法输入及用户中断不重试。
- 不读取凭据或会话数据库，不把服务端错误正文放入提示或 shell。
- Windows/macOS/Linux 均可运行；插件 hooks 使用插件根目录相对命令。

## Review Focus

- 429 文案相似但实际为额度耗尽：必须不调度；由分类单元测试覆盖。
- 恢复进程再次失败：必须不形成递归；由入口与进程环境测试覆盖。
- 等待期间用户操作或多个失败同时发生：必须取消或去重；由状态测试覆盖。
- Windows 路径含空格、npm `kimi.cmd`：必须安全启动；由参数与启动测试覆盖。
- 原会话真实恢复而非仅 mock 成功：由隔离 Kimi CLI 端到端测试覆盖。

---

### Task 1: 429 分类与测试基线

**Files:**
- Create: `package.json`
- Create: `lib/rate-limit.mjs`
- Test: `test/rate-limit.test.mjs`

**Interfaces:**
- Produces: `shouldRetry(payload: unknown): boolean`，只接受规范的临时 `StopFailure` 429 输入。

- [ ] **Step 1:** 先写临时 429 接受测试，以及额度/余额/组织限额、401、未知 429、缺失字段、畸形类型拒绝测试，并运行确认因实现不存在而失败。
- [ ] **Step 2:** 实现最小纯函数分类，运行 `node --test test/rate-limit.test.mjs` 确认通过。
- [ ] **Step 3:** 在 `package.json` 固定 `type: module`、Node 20+、`npm test` 和验证命令，不添加运行时依赖。

### Task 2: 调度、取消与恢复执行

**Files:**
- Create: `lib/retry.mjs`
- Create: `hooks/stop-failure.mjs`
- Create: `hooks/session-activity.mjs`
- Create: `hooks/retry-worker.mjs`
- Test: `test/retry.test.mjs`
- Test: `test/hooks.test.mjs`

**Interfaces:**
- Consumes: `shouldRetry(payload)`。
- Produces: `scheduleRetry(payload, options)`、`runWorker(sessionId, token, options)`、`cancelRetry(payload, options)`；options 注入状态根目录、延迟、CLI 启动器，生产默认严格为 60,000 ms。
- Produces: 三个零依赖 hook 入口；stdin 异常安全退出，不向模型流程注入内容。

- [ ] **Step 1:** 先写调度参数、默认延迟、重复事件、活动取消、恢复不递归、失活记录清理测试，运行并确认正确失败。
- [ ] **Step 2:** 实现每会话状态与 worker 所有权，使用异步文件 API、原子状态转换、有限会话 ID 和绝对 cwd 校验。
- [ ] **Step 3:** 实现 PATH/显式 CLI 解析及 `kimi --session <id> --prompt <固定文本>` 参数数组启动，不执行错误正文。
- [ ] **Step 4:** 先写 stdin/退出行为测试，再实现三个入口，运行 `node --test test/retry.test.mjs test/hooks.test.mjs` 确认通过。

### Task 3: 官方打包与真实 CLI 验证

**Files:**
- Create: `kimi.plugin.json`
- Create: `README.md`
- Create: `LICENSE`
- Create: `test/manifest.test.mjs`
- Create: `test/integration/kimi-cli.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 hooks 与 CLI 恢复行为。

- [ ] **Step 1:** 先验证 manifest 路径、受支持字段、hook 事件与超时、所有被引用文件存在，运行确认失败。
- [ ] **Step 2:** 编写 manifest 与安装文档，明确 60 秒一次恢复、非交互权限、原窗口限制、查看/取消与卸载方法。
- [ ] **Step 3:** 用本地假 OpenAI 服务和隔离 `KIMI_CODE_HOME` 写真实 CLI 端到端测试；先确认缺少完整安装/恢复时失败，再完成安装与恢复验证。
- [ ] **Step 4:** 执行完整 `npm test`、包内容检查与真实 `/plugins info` 诊断；保留真实结果，不掩盖 CLI 自身问题。

### Task 4: 独立审查与发布

**Files:**
- Modify only files implicated by verified review findings.

- [ ] **Step 1:** 实现完成后，用 `model: primary` 的 coder 子代理进行只读独立审查，提供规范、官方链接、项目路径和验证证据。
- [ ] **Step 2:** 对审查发现先复现，按 TDD 修正阻断问题，再运行完整验证。
- [ ] **Step 3:** 删除临时产物，确认 Git 状态仅含交付文件；创建 `Shinarin/kimi-code-429-retry` 公开仓库并推送默认分支。
- [ ] **Step 4:** 用 GitHub API 核验公开可见性、默认分支和远端提交一致性，报告仓库 URL 与已验证/未验证边界。
