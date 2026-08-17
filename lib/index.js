// dsh-balance-monitor — host half.
//
// One logical RPC channel, /balance, serving two endpoints:
//
//   "snapshot" — Account balance + today's spend. Auto-detects the provider:
//   DeepSeek  → DEEPSEEK_API_KEY + GET https://api.deepseek.com/user/balance
//   SiliconFlow → SILICONFLOW_API_KEY + GET https://api.siliconflow.cn/v1/user/info
//   The provider is auto-detected from the configured API key (siliconflow
//   wins when both are present), or can be set explicitly in the plugin config.
//   Folds the result into a tiny state file
//   ($DSH_HOME/storages/balance-monitor.json) that keeps the day-start
//   baseline across page refreshes and process restarts.
//   Payload { refresh: false } returns the last known numbers WITHOUT hitting
//   the network (in-memory last, else the disk state) — the UI uses this on
//   mount so nothing is fetched until the user asks.
//
//   "usage" — yearly (rolling 12 calendar months) token consumption and cost.
//   Requires the DeepSeek platform login token (DEEPSEEK_PLATFORM_TOKEN in
//   env, else the DEEPSEEK_PLATFORM_TOKEN line in .credentials.yaml); queries
//   the private dashboard endpoints /api/v0/usage/amount and /api/v0/usage/cost
//   month by month, aggregates, and caches to
//   $DSH_HOME/storages/balance-usage.json. Payload { refresh: false } returns
//   only the cached numbers; { refresh: true } re-queries DeepSeek. The UI
//   only sends { refresh: true } when the user clicks the refresh button.
//
//   "config" — plugin settings persisted in
//   $DSH_HOME/storages/balance-monitor-config.json: balance poll interval
//   (pollMs), low-balance reminder threshold (lowBalanceThreshold), provider
//   ('auto' | 'deepseek' | 'siliconflow'), and an optional platform token
//   override (platformToken) that takes precedence over .credentials.yaml
//   (the DEEPSEEK_PLATFORM_TOKEN env var still wins).
//   Actions: { action: 'get' } reads the config, { action: 'set', config }
//   merges a patch and persists it, { action: 'test' } validates the
//   effective platform token against the current month's cost endpoint.
//
// Day-spend semantics: the first successful query of a calendar day (local
// time) becomes that day's baseline; spend = max(0, baseline - current).
// A refill pushes current above baseline, which clamps spend to 0 rather
// than going negative. When the upstream call fails and a state file exists,
// the last known numbers are returned with a `stale: true` flag so the UI
// can keep showing something instead of flashing an error.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-balance-monitor'
export const inject = ['connection']

const BALANCE_API = 'https://api.deepseek.com/user/balance'
const SILICONFLOW_USER_INFO_API = 'https://api.siliconflow.cn/v1/user/info'
// SiliconFlow platform web API (login-cookie based). The /v1/user/info open
// API is deprecated; the platform console reads the real balance from this
// walletd endpoint via the cloud rewrite prefix. Requires the browser login
// cookie (X-Subject-Id header + Cookie header).
const SILICONFLOW_PROFILE_PEEK_API = 'https://cloud.siliconflow.cn/walletd-server/api/v1/subject/profile/peek'
const DSH_SETTINGS_FILE = 'settings.yaml'
const USAGE_API_BASE = 'https://platform.deepseek.com/api/v0/usage'
const CREDENTIALS_FILE = '.credentials.yaml'
const STATE_FILE = 'balance-monitor.json'
const USAGE_STATE_FILE = 'balance-usage.json'
// Rolling window: the current calendar month plus the 11 before it.
const USAGE_MONTHS = 12
// Plugin settings (persisted in $DSH_HOME/storages/balance-monitor-config.json).
const CONFIG_STATE_FILE = 'balance-monitor-config.json'
const DEFAULT_POLL_MS = 60000
const DEFAULT_LOW_BALANCE_THRESHOLD = 1
const MIN_POLL_MS = 5000
const MAX_POLL_MS = 3600000

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function today() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// Provider most recently used in any session (module-level so both the
// RPC handlers and the event subscription can share it).
let recentProvider = null

/**
 * Read DSH settings.yaml to find the configured default model provider
 * (agent-default-model.provider). Returns a provider id string or null.
 */
async function readSettingsProvider() {
  try {
    const yaml = await readFile(join(dshHome(), DSH_SETTINGS_FILE), 'utf8')
    const match = yaml.match(/^agent-default-model:\s*\n\s*provider:\s*(\S+)/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Auto-detect the provider: config override first, then the most recent
 * provider actually used in a session, then the DSH default model provider,
 * then credentials. Returns 'deepseek' or 'siliconflow'.
 */
async function detectProvider(recentProvider) {
  const config = await loadConfig()
  if (config && typeof config.provider === 'string' && config.provider !== 'auto') {
    return config.provider === 'siliconflow' ? 'siliconflow' : 'deepseek'
  }
  // auto: follow the provider most recently used in any session
  if (recentProvider === 'siliconflow' || recentProvider === 'deepseek') return recentProvider
  // auto: follow the DSH default model provider if it names one we know
  const settingsProvider = await readSettingsProvider()
  if (settingsProvider) {
    const p = String(settingsProvider).toLowerCase()
    if (p.includes('siliconflow')) return 'siliconflow'
    if (p.includes('deepseek')) return 'deepseek'
  }
  // fallback: check if SILICONFLOW_API_KEY is configured
  if (process.env.SILICONFLOW_API_KEY) return 'siliconflow'
  try {
    const yaml = await readFile(join(dshHome(), CREDENTIALS_FILE), 'utf8')
    if (yaml.match(/^SILICONFLOW_API_KEY:\s*(\S+)/m)) return 'siliconflow'
  } catch {}
  return 'deepseek'
}

/** Extract the API key for the given provider. */
async function readApiKey(provider) {
  const keyName = provider === 'siliconflow' ? 'SILICONFLOW_API_KEY' : 'DEEPSEEK_API_KEY'
  if (process.env[keyName]) return process.env[keyName]
  try {
    const yaml = await readFile(join(dshHome(), CREDENTIALS_FILE), 'utf8')
    const match = yaml.match(new RegExp(`^${keyName}:\\s*(\\S+)`, 'm'))
    if (match) return match[1]
  } catch {
    // fall through
  }
  return null
}

/** Extract the platform login token (userToken): env first, then the plugin
 *  config override, then .credentials.yaml. */
async function readPlatformToken() {
  if (process.env.DEEPSEEK_PLATFORM_TOKEN) return process.env.DEEPSEEK_PLATFORM_TOKEN
  const config = await loadConfig()
  if (config && typeof config.platformToken === 'string' && config.platformToken) return config.platformToken
  try {
    const yaml = await readFile(join(dshHome(), CREDENTIALS_FILE), 'utf8')
    const match = yaml.match(/^DEEPSEEK_PLATFORM_TOKEN:\s*(\S+)/m)
    if (match) return match[1]
  } catch {
    // fall through
  }
  return null
}

async function fetchBalance(apiKey, signal) {
  const res = await fetch(BALANCE_API, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  if (!res.ok) throw new Error(`balance api responded ${res.status}`)
  const json = await res.json()
  const infos = Array.isArray(json.balance_infos) ? json.balance_infos : []
  const info = infos.find((i) => i.currency === 'CNY') ?? infos[0]
  if (!info) throw new Error('balance api returned no balance_infos')
  return {
    available: json.is_available === true,
    currency: info.currency,
    total: Number.parseFloat(info.total_balance),
    granted: Number.parseFloat(info.granted_balance),
    toppedUp: Number.parseFloat(info.topped_up_balance),
  }
}

/**
 * SiliconFlow balance, two channels:
 *
 * 1. Platform web API (preferred, real balance): the open /v1/user/info is
 *    deprecated, so when a login cookie + subject id are configured we call
 *    the same walletd endpoint the console uses:
 *      GET https://cloud.siliconflow.cn/walletd-server/api/v1/subject/profile/peek
 *    headers: Cookie + X-Subject-Id + accept-language.
 *    Amounts are integers scaled by 1e12 (yuan × 10^12), so balance must be
 *    divided by 1e12 to get yuan.
 *
 * 2. Open API fallback: GET /v1/user/info with the API key. Kept for setups
 *    without a login cookie; the deprecated endpoint may stop working.
 */
async function fetchSiliconFlowBalance(apiKey, signal) {
  const config = (await loadConfig()) ?? {}
  const cookie = config.siliconflowCookie && typeof config.siliconflowCookie === 'string'
    ? config.siliconflowCookie.trim()
    : ''
  const subjectId = config.siliconflowSubjectId && typeof config.siliconflowSubjectId === 'string'
    ? config.siliconflowSubjectId.trim()
    : ''

  // Channel 1: platform web API (real balance from the console).
  if (cookie) {
    try {
      const headers = {
        'Cookie': cookie,
        'Content-type': 'application/json',
        'accept-language': 'zh-CN',
      }
      if (subjectId) headers['X-Subject-Id'] = subjectId
      const res = await fetch(SILICONFLOW_PROFILE_PEEK_API, { headers, signal })
      if (!res.ok) throw new Error(`siliconflow profile peek api responded ${res.status}`)
      const json = await res.json()
      const f = json?.data?.financialInfo || {}
      // Amounts are 1e12-scaled integers; guard against missing/zero values.
      const total = Number.isFinite(Number(f.balance)) ? Number(f.balance) / 1e12 : 0
      return {
        available: total > 0,
        currency: 'CNY',
        total,
        granted: 0,
        toppedUp: 0,
      }
    } catch (error) {
      // Cookie channel failed (expired cookie, WAF, ...): fall through to the
      // open API rather than failing the whole query.
      console.error('[balance-monitor] siliconflow web api failed, falling back to open api:', error)
    }
  }

  // Channel 2: open API fallback (deprecated endpoint, API key auth).
  if (!apiKey) throw new Error('SILICONFLOW_API_KEY not configured and no login cookie set')
  const res = await fetch(SILICONFLOW_USER_INFO_API, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal,
  })
  if (!res.ok) throw new Error(`siliconflow user info api responded ${res.status}`)
  const json = await res.json()
  if (json.code !== 20000 || !json.status) {
    throw new Error(`siliconflow api error: ${json.message ?? 'unknown'}`)
  }
  const data = json.data || {}
  const total = Number.parseFloat(data.totalBalance) || 0
  return {
    available: total > 0,
    currency: 'CNY',
    total,
    granted: Number.parseFloat(data.balance) || 0,
    toppedUp: Number.parseFloat(data.chargeBalance) || 0,
  }
}

/**
 * GET one dashboard endpoint. A browser-like User-Agent is required — the
 * platform WAF (awswaf) blocks bare script clients with 429.
 */
async function fetchDashboard(url, token, signal) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      Referer: 'https://platform.deepseek.com/',
    },
    signal,
  })
  if (!res.ok) throw new Error(`usage api responded ${res.status}`)
  const json = await res.json()
  if (!json || json.code === 40003) {
    throw new Error('DeepSeek platform token is invalid or expired (code 40003)')
  }
  if (json.code !== 0) {
    throw new Error(`usage api error code ${json.code}: ${json.msg ?? ''}`)
  }
  return json
}

/** Extract per-model usage dicts from an amount/cost response (handles both biz_data shapes). */
function pickModelUsage(resp) {
  let bd = resp?.data?.biz_data
  if (Array.isArray(bd)) bd = bd[0] ?? null
  const total = bd && Array.isArray(bd.total) ? bd.total : []
  const out = {}
  for (const item of total) {
    const u = {}
    for (const e of item.usage ?? []) {
      u[e.type] = Number.parseFloat(e.amount) || 0
    }
    out[item.model] = u
  }
  return out
}

/** Fetch amount+cost for one month and fold into a plain month summary. */
async function fetchMonthUsage(token, year, month, signal) {
  const [amt, cst] = await Promise.all([
    fetchDashboard(`${USAGE_API_BASE}/amount?month=${month}&year=${year}`, token, signal),
    fetchDashboard(`${USAGE_API_BASE}/cost?month=${month}&year=${year}`, token, signal),
  ])
  const am = pickModelUsage(amt)
  const cs = pickModelUsage(cst)
  const models = new Set([...Object.keys(am), ...Object.keys(cs)])
  const m = { month: `${year}-${String(month).padStart(2, '0')}`, cacheHit: 0, cacheMiss: 0, prompt: 0, response: 0, requests: 0, cost: 0 }
  for (const model of models) {
    const a = am[model] ?? {}
    const c = cs[model] ?? {}
    m.cacheHit += a.PROMPT_CACHE_HIT_TOKEN ?? 0
    m.cacheMiss += a.PROMPT_CACHE_MISS_TOKEN ?? 0
    m.prompt += a.PROMPT_TOKEN ?? 0
    m.response += a.RESPONSE_TOKEN ?? 0
    m.requests += a.REQUEST ?? 0
    m.cost +=
      (c.PROMPT_TOKEN ?? 0) +
      (c.PROMPT_CACHE_HIT_TOKEN ?? 0) +
      (c.PROMPT_CACHE_MISS_TOKEN ?? 0) +
      (c.RESPONSE_TOKEN ?? 0) +
      (c.REQUEST ?? 0)
  }
  m.cost = Math.round(m.cost * 100) / 100
  return m
}

/** Fetch the rolling 12-calendar-month window and aggregate. */
async function fetchYearlyUsage(token, signal) {
  const now = new Date()
  const months = []
  for (let i = USAGE_MONTHS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }
  const from = months[0]
  const to = months[months.length - 1]
  const perMonth = []
  const totals = { cacheHit: 0, cacheMiss: 0, prompt: 0, response: 0, requests: 0, cost: 0 }
  for (const { year, month } of months) {
    const m = await fetchMonthUsage(token, year, month, signal)
    perMonth.push(m)
    for (const k of Object.keys(totals)) totals[k] += m[k]
  }
  totals.cost = Math.round(totals.cost * 100) / 100
  return {
    period: {
      from: `${from.year}-${String(from.month).padStart(2, '0')}`,
      to: `${to.year}-${String(to.month).padStart(2, '0')}`,
    },
    months: perMonth,
    totals,
    currency: 'CNY',
  }
}

const statePath = () => join(dshHome(), 'storages', STATE_FILE)
const usageStatePath = () => join(dshHome(), 'storages', USAGE_STATE_FILE)

async function loadState() {
  try {
    const state = JSON.parse(await readFile(statePath(), 'utf8'))
    if (state && typeof state.date === 'string' && typeof state.dayStart === 'number') return state
  } catch {
    // no state yet
  }
  return null
}

async function loadUsageState() {
  try {
    const state = JSON.parse(await readFile(usageStatePath(), 'utf8'))
    if (state && state.totals && state.period) return state
  } catch {
    // no state yet
  }
  return null
}

async function saveState(state) {
  try {
    await mkdir(join(dshHome(), 'storages'), { recursive: true })
    await writeFile(statePath(), JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('[balance-monitor] state write failed:', error)
  }
}

async function saveUsageState(state) {
  try {
    await mkdir(join(dshHome(), 'storages'), { recursive: true })
    await writeFile(usageStatePath(), JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('[balance-monitor] usage state write failed:', error)
  }
}

const configPath = () => join(dshHome(), 'storages', CONFIG_STATE_FILE)

async function loadConfig() {
  try {
    const config = JSON.parse(await readFile(configPath(), 'utf8'))
    if (config && typeof config === 'object') return config
  } catch {
    // no config yet
  }
  return null
}

async function saveConfig(config) {
  try {
    await mkdir(join(dshHome(), 'storages'), { recursive: true })
    await writeFile(configPath(), JSON.stringify(config, null, 2))
  } catch (error) {
    console.error('[balance-monitor] config write failed:', error)
  }
}

/** Clamp an integer setting (e.g. poll interval in ms) into its allowed range. */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Clamp a float setting (e.g. the low-balance threshold) into its range. */
function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const maskToken = (token) => {
  if (!token) return null
  if (token.length <= 8) return '****'
  return `${token.slice(0, 4)}*****${token.slice(-4)}`
}

/** Read the effective plugin config with every setting normalized. */
async function effectiveConfig() {
  const config = (await loadConfig()) ?? {}
  return {
    pollMs: clampInt(config.pollMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS),
    lowBalanceThreshold: clampNum(config.lowBalanceThreshold, 0, 1000000, DEFAULT_LOW_BALANCE_THRESHOLD),
    platformToken: config.platformToken && typeof config.platformToken === 'string' ? config.platformToken : null,
    siliconflowCookie: config.siliconflowCookie && typeof config.siliconflowCookie === 'string' ? config.siliconflowCookie : null,
    siliconflowSubjectId: config.siliconflowSubjectId && typeof config.siliconflowSubjectId === 'string' ? config.siliconflowSubjectId : null,
  }
}

async function handleConfig(payload, signal) {
  const action = payload && payload.action
  if (action === 'get') {
    const config = await effectiveConfig()
    const source = config.platformToken
      ? 'plugin'
      : process.env.DEEPSEEK_PLATFORM_TOKEN
        ? 'env'
        : 'credentials'
    // detect current provider
    const provider = await detectProvider(recentProvider)
    return {
      ok: true,
      value: {
        pollMs: config.pollMs,
        lowBalanceThreshold: config.lowBalanceThreshold,
        tokenConfigured: Boolean(config.platformToken),
        tokenPreview: maskToken(config.platformToken),
        tokenSource: source,
        provider: config.provider || 'auto',
        effectiveProvider: provider,
        siliconflowCookieConfigured: Boolean(config.siliconflowCookie),
        siliconflowSubjectId: config.siliconflowSubjectId || null,
      },
    }
  }
  if (action === 'set') {
    const patch = payload && payload.config ? payload.config : {}
    const config = (await loadConfig()) ?? {}
    if (patch.pollMs !== undefined) config.pollMs = clampInt(patch.pollMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS)
    if (patch.lowBalanceThreshold !== undefined) {
      config.lowBalanceThreshold = clampNum(patch.lowBalanceThreshold, 0, 1000000, DEFAULT_LOW_BALANCE_THRESHOLD)
    }
    if (patch.platformToken !== undefined) {
      const token = typeof patch.platformToken === 'string' ? patch.platformToken.trim() : ''
      config.platformToken = token || null
    }
    if (patch.provider !== undefined) {
      const p = typeof patch.provider === 'string' ? patch.provider.trim().toLowerCase() : 'auto'
      config.provider = ['deepseek', 'siliconflow'].includes(p) ? p : 'auto'
    }
    if (patch.siliconflowCookie !== undefined) {
      const cookie = typeof patch.siliconflowCookie === 'string' ? patch.siliconflowCookie.trim() : ''
      config.siliconflowCookie = cookie || null
    }
    if (patch.siliconflowSubjectId !== undefined) {
      const sid = typeof patch.siliconflowSubjectId === 'string' ? patch.siliconflowSubjectId.trim() : ''
      config.siliconflowSubjectId = sid || null
    }
    await saveConfig(config)
    const saved = await effectiveConfig()
    return {
      ok: true,
      value: {
        saved: true,
        pollMs: saved.pollMs,
        lowBalanceThreshold: saved.lowBalanceThreshold,
        tokenConfigured: Boolean(saved.platformToken),
        tokenPreview: maskToken(saved.platformToken),
        siliconflowCookieConfigured: Boolean(saved.siliconflowCookie),
        siliconflowSubjectId: saved.siliconflowSubjectId || null,
      },
    }
  }
  if (action === 'test') {
    const token = await readPlatformToken()
    if (!token) {
      return { ok: true, value: { valid: false, message: 'DEEPSEEK_PLATFORM_TOKEN not configured' } }
    }
    try {
      const now = new Date()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      await fetchDashboard(`${USAGE_API_BASE}/cost?month=${month}&year=${now.getFullYear()}`, token, signal)
      return { ok: true, value: { valid: true, message: 'ok' } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: true, value: { valid: false, message } }
    }
  }
  return {
    ok: false,
    error: { code: 'bad-request', message: `unknown config action: ${action}`, details: {} },
  }
}

export function apply(ctx) {
  // In-process fallback so a transient upstream failure after a success
  // still answers the UI without touching disk.
  let last = null

  // Track the provider most recently used in any session (from
  // request/header events) so the balance query follows the model in use.
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type === 'request/header' && event.data?.header?.config) {
          const cfg = event.data.header.config
          if (typeof cfg.provider === 'string') {
            const p = cfg.provider.toLowerCase()
            if (p.includes('siliconflow')) recentProvider = 'siliconflow'
            else if (p.includes('deepseek')) recentProvider = 'deepseek'
          }
        }
      } catch {}
    })
  } catch {
    // session/event subscription is optional — detection falls back
  }

  /** Serve the freshest known snapshot without hitting the network. */
  async function cachedSnapshot() {
    const fallback = last ?? (await loadState())
    const lastTotal =
      fallback &&
      (typeof fallback.lastTotal === 'number'
        ? fallback.lastTotal
        : typeof fallback.total === 'number'
          ? fallback.total
          : NaN)
    if (fallback && Number.isFinite(lastTotal)) {
      return {
        date: fallback.date,
        dayStart: fallback.dayStart,
        total: lastTotal,
        currency: fallback.lastCurrency ?? fallback.currency ?? 'CNY',
        provider: fallback.lastProvider ?? fallback.provider ?? null,
        available: false,
        spent: fallback.spent ?? Math.max(0, fallback.dayStart - lastTotal),
        updatedAt: fallback.updatedAt ?? 0,
        stale: true,
      }
    }
    return null
  }

  async function handleSnapshot(payload, signal) {
    if (payload && payload.refresh === false) {
      const cached = await cachedSnapshot()
      if (!cached) return { ok: true, value: null }
      // Report the currently-detected provider so the client can spot a
      // provider switch and force a real refresh without waiting for the poll.
      let currentProvider = null
      try {
        currentProvider = await detectProvider(recentProvider)
      } catch {}
      return {
        ok: true,
        value: {
          ...cached,
          provider: cached.provider ?? currentProvider,
          currentProvider,
        },
      }
    }
    try {
      const provider = await detectProvider(recentProvider)
      const apiKey = await readApiKey(provider)
      if (provider === 'siliconflow') {
        // The web API channel only needs a login cookie (no API key), so the
        // key is optional here — fetchSiliconFlowBalance falls back to the
        // open API only when the cookie channel is unavailable.
        const config = (await loadConfig()) ?? {}
        const hasCookie = config.siliconflowCookie && typeof config.siliconflowCookie === 'string'
        if (!apiKey && !hasCookie) {
          return {
            ok: false,
            error: {
              code: 'unauthorized',
              message: 'SILICONFLOW_API_KEY or siliconflowCookie not configured',
              details: {},
            },
          }
        }
      } else if (!apiKey) {
        return {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'DEEPSEEK_API_KEY not found',
            details: {},
          },
        }
      }
      const balance = provider === 'siliconflow'
        ? await fetchSiliconFlowBalance(apiKey, signal)
        : await fetchBalance(apiKey, signal)
      const state = (await loadState()) ?? {}
      const date = today()
      const sameDay = state.date === date
      const sameCurrency = state.lastCurrency === undefined || state.lastCurrency === balance.currency
      const sameProvider = state.lastProvider === undefined || state.lastProvider === provider

      // Cross-day, currency switch, or provider switch: reset the day-start
      // baseline and the spend ledger (never carry across any of these).
      let dayStart = sameDay && sameCurrency && sameProvider ? state.dayStart : balance.total
      let spent = sameDay && sameCurrency && sameProvider ? (state.spent ?? 0) : 0
      const prevTotal = sameDay && sameCurrency && sameProvider ? state.lastTotal : balance.total

      // Spend ledger: accumulate balance *drops* only. A refill (or refund)
      // raises the balance and is not consumption, so it must not inflate
      // today's spend — and must not wash out spend already accumulated.
      if (prevTotal > balance.total) {
        spent += prevTotal - balance.total
        spent = Math.round(spent * 100) / 100 // keep float drift out of the ledger
      }

      // Refill re-fills the bar: the baseline follows balance rises, so the
      // ratio bar reads full right after a top-up and every later drop is
      // visible immediately instead of being clamped at 100%.
      if (balance.total > dayStart) dayStart = balance.total

      await saveState({
        date,
        dayStart,
        lastTotal: balance.total,
        lastCurrency: balance.currency,
        lastProvider: provider,
        spent,
        updatedAt: Date.now(),
      })

      const snapshot = {
        date,
        dayStart,
        total: balance.total,
        currency: balance.currency,
        provider,
        available: balance.available,
        spent,
        updatedAt: Date.now(),
        stale: false,
      }
      last = snapshot
      return { ok: true, value: snapshot }
    } catch (error) {
      // Upstream failure: serve the freshest known numbers if we have any.
      const cached = await cachedSnapshot()
      if (cached) return { ok: true, value: cached }
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: { code: 'internal', message: `balance query failed: ${message}`, details: {} },
      }
    }
  }

  async function handleUsage(payload, signal) {
    const wantRefresh = payload && payload.refresh === true
    const cached = await loadUsageState()
    if (!wantRefresh) {
      // Cached read only — never touches the network.
      return cached ? { ok: true, value: { ...cached, cached: true } } : { ok: true, value: null }
    }
    try {
      const token = await readPlatformToken()
      if (!token) {
        return {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'DEEPSEEK_PLATFORM_TOKEN not found in .credentials.yaml',
            details: {},
          },
        }
      }
      const usage = await fetchYearlyUsage(token, signal)
      const value = { ...usage, fetchedAt: Date.now(), cached: false }
      await saveUsageState(value)
      return { ok: true, value }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (cached) {
        return { ok: true, value: { ...cached, cached: true, error: message } }
      }
      return {
        ok: false,
        error: { code: 'internal', message: `usage query failed: ${message}`, details: {} },
      }
    }
  }

  ctx.connection.rpc.handle(
    '/balance',
    async (endpoint, payload, signal) => {
      if (endpoint === 'usage') return handleUsage(payload, signal)
      if (endpoint === 'config') return handleConfig(payload, signal)
      return handleSnapshot(payload, signal)
    },
    { authority: 'loopback' },
  )
}
