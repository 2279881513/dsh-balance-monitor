[简体中文](README.md) | English

# dsh-balance-monitor

**DeepSeek + SiliconFlow balance monitor** in the dsh sidebar footer.

A fork of [@rainronin/dsh-balance-monitor](https://github.com/Rainronin/dsh-balance-monitor) → [jelly-000/dsh-balance-monitor](https://github.com/jelly-000/dsh-balance-monitor) with **SiliconFlow (硅基流动) support**: auto-detects the active model provider and queries the real balance from the platform web API (login cookie) instead of the deprecated `/v1/user/info` open API.

<p align="center">
  <img src="https://raw.githubusercontent.com/2279881513/dsh-balance-monitor/main/docs/preview/balance-wide.png" alt="Sidebar balance card" width="280">
  <img src="https://raw.githubusercontent.com/2279881513/dsh-balance-monitor/main/docs/preview/settings.png" alt="Settings page" width="280">
</p>

## Features

| Feature | Implementation |
|---------|---------------|
| **Dual-provider auto-switch** | DeepSeek ↔ SiliconFlow, auto-detected: follows the actual session model provider, the dsh default model config, or manual override |
| **Balance query** | DeepSeek: `GET /user/balance` (API Key); SiliconFlow: platform web `profile/peek` (login Cookie) with API key fallback |
| **SiliconFlow real balance** | Uses `GET /walletd-server/api/v1/subject/profile/peek` — the same endpoint the platform console uses. Paste a DevTools-copied cURL command into settings (cookie extracted automatically) |
| **Today's spend** | First successful query of the day sets the baseline (persisted in `$DSH_HOME/storages/balance-monitor.json`); spend = `max(0, baseline − current)`. Baseline resets on provider switch |
| **Auto-refresh** | Balance polls every 60 seconds (configurable 5–3600s); **auto-triggers on provider switch** (no manual refresh needed) |
| **12-month usage** | Fetched once per page load, also on ↻ click; requires DeepSeek platform login token |
| **Settings page** | dsh settings → Balance Monitor: refresh interval, low-balance threshold, DeepSeek platform token, SiliconFlow login Cookie + SubjectId (with cURL auto-parse) |
| **Balance ratio bar** | Current ÷ baseline, blue → amber → red gradient |
| **Provider label** | Card shows current provider (`DeepSeek Balance` / `SiliconFlow Balance`) |
| **Resilience** | Dual-channel: web API → falls back to open API; upstream failure shows stale cached data instead of an error flash |

## Installation

No build step required — the browser bundle is a hand-written classic script:

```sh
dsh plugin --profile web add "github:<your-username>/dsh-balance-monitor#main"
```

Then restart the Web UI (`dsh web`). The card appears at the bottom of the expanded sidebar.

### SiliconFlow Setup

To use SiliconFlow's real balance, open the plugin settings page and fill in:

1. **Login Cookie** — In `cloud.siliconflow.cn` (logged in) → F12 → Network → right-click any request → **Copy as cURL** → paste directly here (the cookie is extracted automatically)
2. **SubjectId** — Run `window.subjectInfo.subjectId` in the console (typically `5cjcchom7v`)

Without the cookie, the plugin falls back to the deprecated `/v1/user/info` API which may return zero balance.

## Credentials

### DeepSeek

```yaml
# .credentials.yaml
DEEPSEEK_API_KEY: sk-xxxxx
DEEPSEEK_PLATFORM_TOKEN: xxx   # for 12-month usage (optional)
```

### SiliconFlow (fallback)

```yaml
# .credentials.yaml (optional)
SILICONFLOW_API_KEY: sk-xxxxx
```

## Detection Priority (auto mode)

1. Manual `provider` override in plugin settings
2. Most recent session's actual provider (from `session/event` → `request/header`)
3. DSH `settings.yaml` → `agent-default-model.provider`
4. Credential fallback (SILICONFLOW_API_KEY → SiliconFlow, else → DeepSeek)

## License

MIT