[English](README.en.md) | 简体中文

# dsh-balance-monitor

**DeepSeek + 硅基流动 余额监控**，直接显示在 dsh 侧边栏底部。

基于 [@rainronin/dsh-balance-monitor](https://github.com/Rainronin/dsh-balance-monitor) → [jelly-000/dsh-balance-monitor](https://github.com/jelly-000/dsh-balance-monitor) 改进，增加 **硅基流动 (SiliconFlow) 支持**：自动跟随当前使用的模型提供商切换余额查询接口。硅基流动端使用网页登录态 Cookie 查真实余额（绕开已弃用的 `/v1/user/info` 开放 API）。

<p align="center">
  <img src="https://raw.githubusercontent.com/2279881513/dsh-balance-monitor/main/docs/preview/balance-wide.png" alt="侧边栏底部余额卡片" width="280">
  <img src="https://raw.githubusercontent.com/2279881513/dsh-balance-monitor/main/docs/preview/settings.png" alt="余额监控设置页" width="280">
</p>

## 功能

| 功能 | 实现 |
|------|------|
| **双提供商自动切换** | DeepSeek 官方 ↔ 硅基流动，**自动检测**：跟随当前会话实际使用的模型提供商，或跟随 DSH 默认模型配置，或手动指定 |
| **余额查询** | DeepSeek：`GET /user/balance` (API Key)；硅基流动：网页 `profile/peek` (登录 Cookie) + 回退 `/v1/user/info` (API Key) |
| **硅基流动真实余额** | 使用网页接口 `GET /walletd-server/api/v1/subject/profile/peek`，需要硅基流动网页登录 Cookie（设置页直接粘贴 DevTools 复制的 cURL 自动解析） |
| **今日花费** | 当天首次成功查询的余额记为基线（持久化在 `$DSH_HOME/storages/balance-monitor.json`）；花费 = `max(0, 基线 − 当前)`。切换提供商时自动重置基线 |
| **自动刷新** | 余额每 60 秒轮询一次（设置页可调 5–3600 秒）；切换模型提供商时**自动立即刷新**（无需手动点刷新） |
| **近一年用量** | 每次加载页面自动查询一次，也可点 ↻ 手动刷新；使用 DeepSeek 平台登录 Token 查询近 12 个月用量 |
| **设置页** | dsh 设置列表新增「余额监控」页：刷新间隔、提醒阈值、DeepSeek 平台 Token、硅基流动 Cookie + SubjectId（支持直接粘贴 cURL 自动提取 Cookie） |
| **余额比例条** | 当前余额 ÷ 当日基线，蓝 → 琥珀 → 红 三档渐降 |
| **Provider 标识** | 卡片标签显示当前查询的提供商（`DeepSeek 余额` / `硅基流动 余额`），一目了然 |
| **健壮性** | 双通道容错：Cookie 通道失败自动回退 API Key 通道；上游失败时保留上次数据（stale 标记），不闪错误 |

## 安装

浏览器端 bundle 是手写 classic script，**无构建步骤**，git 安装无需 prepare 脚本：

```sh
dsh plugin --profile web add "github:<你的用户名>/dsh-balance-monitor#main"
```

然后重启 Web UI（`dsh web`）。卡片出现在展开的侧边栏底部、设置按钮上方。

### 硅基流动配置

使用硅基流动时，需要在设置页 → 余额监控 中填写两项：

1. **硅基流动登录 Cookie** — 在 `cloud.siliconflow.cn`（已登录状态）→ F12 → Network → 右键任意请求 → **Copy as cURL** → 直接粘贴到输入框（自动解析出 Cookie）
2. **SubjectId** — 控制台执行 `window.subjectInfo.subjectId` 获取（通常为 `5cjcchom7v`）

不填 Cookie 时回退到 SILICONFLOW_API_KEY（开放 API `/v1/user/info`，该接口已弃用可能不返回真实余额）。

## 工作原理

一个插件行同时承担两种角色（`dsh.bundle` patch + `dsh.client` 浏览器注册表声明）：

- **服务端半**（`lib/index.js`）— 在 `ctx.connection` 上注册 `/balance` RPC 通道，提供 `snapshot`（余额 + 今日花费）、`usage`（近一年用量）与 `config`（插件设置）三个端点。自动检测提供商、读取对应凭证/ Cookie、查询余额并持久化。
- **浏览器半**（`lib/client.js`）— 零依赖 classic-script bundle，注册 `sidebar.footer.action` 卡片与 `settings.section` 设置页。含 5 秒 provider 变化监听（切换模型后自动触发余额刷新）。

## 凭证与配置

### DeepSeek 官方

```yaml
# .credentials.yaml
DEEPSEEK_API_KEY: sk-xxxxx
DEEPSEEK_PLATFORM_TOKEN: xxx   # 用于近一年用量（可选）
```

### 硅基流动

```yaml
# .credentials.yaml (可选回退)
SILICONFLOW_API_KEY: sk-xxxxx
```

网页 Cookie + SubjectId 通过插件**设置页**填写，保存在 `$DSH_HOME/storages/balance-monitor-config.json`。

## 检测优先级（自动模式）

1. 设置页手动指定 `provider` → 固定为该提供商
2. 会话最近实际使用的模型提供商（通过 `session/event` 监听 `request/header`）
3. DSH `settings.yaml` 的 `agent-default-model.provider`
4. 凭证回退（SILICONFLOW_API_KEY 存在 → 硅基流动，否则 → DeepSeek）

## 许可

MIT