// shared.ts — constants and helpers used by both parts of the plugin:
// zcode-benefits.ts (server) and tui.tsx (TUI commands and cards). No setup logic here.

import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { arch, homedir, platform } from "node:os"
import { dirname, join } from "node:path"

// ── constants ──

export const ZCODE_ORIGIN = "https://zcode.z.ai"
export const ZCODE_PLAN_ANTHROPIC = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1`
// ultra-zai lane (both providers before the plan-lane enforcement) and the SDK package.
export const ZCODE_ULTRA_ANTHROPIC = `${ZCODE_ORIGIN}/api/v1/ultra-zai/anthropic/v1`
export const AISDK_ANTHROPIC = "aisdk:@ai-sdk/anthropic"
export const PROVIDER_ID = "zai-start-plan"
export const APP_VERSION = "3.17.2"

// Verbatim copy of options.headers for both providers from the former opencode.json provider block.
export const CONFIG_HEADERS: Record<string, string> = {
  "User-Agent": "ZCode/3.17.2",
  "X-ZCode-App-Version": "3.17.2",
  "X-Title": "Z Code@cli",
  "X-Release-Channel": "production",
  "HTTP-Referer": ZCODE_ORIGIN,
  "X-ZCode-Agent": "glm",
}

const TOUCH_URL = `${ZCODE_ORIGIN}/api/v1/marketing/touch`
const ACTION_URL = `${ZCODE_ORIGIN}/api/v1/marketing/touch/action`
const CLAIM_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/claim`

// ── deviceMid: the plugin's own state (not shared with ZCode desktop).
// The directory path is kept from the former zcode-passport name, so the deviceMid
// stays the same value the server saw before the rename. ──

const STATE_FILE = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "opencode",
  "zcode-passport",
  "state.json",
)

let midCache: string | undefined
export async function deviceMid(): Promise<string> {
  if (midCache !== undefined) return midCache
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { deviceMid?: string }
    if (typeof state.deviceMid === "string" && state.deviceMid) {
      midCache = state.deviceMid
      return midCache
    }
  } catch {}
  const generated = randomUUID()
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ deviceMid: generated }, null, 2))
  } catch {}
  midCache = generated
  return midCache
}

// ── OS notification (server ticker and fallbacks) ──

export function notify(title: string, body: string): void {
  console.error(`[zcode-benefits] ${title}: ${body}`)
  try {
    if (platform() === "darwin") {
      spawn("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], { stdio: "ignore", detached: true }).unref()
    } else if (platform() === "linux") {
      spawn("notify-send", ["-a", "opencode", title, body], { stdio: "ignore", detached: true }).unref()
    }
  } catch {}
}

// ── gateway fetch (20s cap, parsed JSON envelope) ──

export async function gatewayFetch(url: string, init?: any): Promise<{ status: number; json: any }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    let json: any = null
    try { json = JSON.parse(await res.text()) } catch {}
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

// ── gift campaigns: deliveries, claims (marketing/touch + billing/claim) ──

let touchSeq = 0

export interface GiftClaim {
  campaignId: string
  planId: string
  title: string
}

export function giftHeaders(jwt: string, mid: string): Record<string, string> {
  return {
    "X-Device-Mid": mid,
    "X-Client-Language": "en-US",
    "X-ZCode-App-Version": APP_VERSION,
    "User-Agent": `ZCode/${APP_VERSION}`,
    Authorization: `Bearer ${jwt}`,
  }
}

// Buttons nest under the delivery's resource ("banner" | "popup"), not at the top
// level; a claim button is {action: {type: "claim_zcode_plan", args: {plan_id}}}.
export function extractClaims(deliveries: any[]): GiftClaim[] {
  const out: GiftClaim[] = []
  for (const d of deliveries ?? []) {
    const campaignId = String(d?.campaign_id ?? "")
    if (!campaignId) continue
    const box = d?.resource_position === "popup" ? d.popup : d?.resource_position === "banner" ? d.banner : null
    const title = String(box?.title?.content ?? box?.title?.text ?? "Gift campaign").slice(0, 120)
    for (const b of Array.isArray(box?.buttons) ? box.buttons : []) {
      const action = b?.action
      if (action?.type === "claim_zcode_plan" && action?.args?.plan_id) {
        out.push({ campaignId, planId: String(action.args.plan_id), title })
      }
    }
  }
  return out
}

export async function fetchGiftClaims(jwt: string, mid: string): Promise<GiftClaim[]> {
  const r = await gatewayFetch(`${TOUCH_URL}?seq=${touchSeq++}`, { headers: giftHeaders(jwt, mid) })
  if (r.json?.code !== 0) throw new Error(`marketing/touch failed: code=${r.json?.code ?? r.status} ${r.json?.msg ?? ""}`)
  return extractClaims(r.json?.data?.deliveries ?? r.json?.deliveries ?? [])
}

export type ClaimResult = { status: "claimed" | "captcha" | "failed"; code?: number; msg?: string }

// proofHeaders: consumed captcha proof headers, when a fresh proof is stored.
export async function claimPlan(
  jwt: string,
  mid: string,
  planId: string,
  proofHeaders: Record<string, string>,
): Promise<ClaimResult> {
  const r = await gatewayFetch(CLAIM_URL, {
    method: "POST",
    headers: { ...giftHeaders(jwt, mid), ...proofHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ plan_id: planId }),
  })
  const code = r.json?.code
  if (code === 0 || r.json?.data?.plan) return { status: "claimed", code, msg: r.json?.msg }
  if (code === 3007 || /captcha/i.test(String(r.json?.msg ?? ""))) return { status: "captcha", code, msg: r.json?.msg }
  return { status: "failed", code: code ?? r.status, msg: r.json?.msg }
}

// Reports the user's decision on a campaign (best effort, as the desktop does).
export async function reportCampaignAction(
  jwt: string,
  mid: string,
  campaignId: string,
  actionType: "confirm" | "cancel",
): Promise<void> {
  try {
    await gatewayFetch(ACTION_URL, {
      method: "POST",
      headers: { ...giftHeaders(jwt, mid), "Content-Type": "application/json" },
      body: JSON.stringify({ campaign_id: campaignId, action_type: actionType }),
    })
  } catch {}
}

// ── client/configs: the account's remote configuration (captcha params, provider rules) ──

// The raw envelope. Callers apply their own validation: the request-verification
// gate is fail-closed, the captcha page and the catalog degrade gracefully.
export async function fetchClientConfigs(): Promise<any> {
  const url = `${ZCODE_ORIGIN}/api/v1/client/configs?app_version=${APP_VERSION}&platform=${platform()}-${arch()}`
  return (await gatewayFetch(url, { headers: { "User-Agent": `ZCode/${APP_VERSION}` } })).json
}

// Captcha widget params (sceneId/prefix/region) for the local verification page.
export async function fetchCaptchaConfig(): Promise<any> {
  return (await fetchClientConfigs())?.data?.configs?.captcha ?? {}
}

// ── usage limits ──
// Coding Plan (API token): GET api.z.ai/api/monitor/usage/quota/limit — the monitor
// endpoint wants the RAW key in `authorization` (no Bearer prefix). Limits carry
// windows: unit 3 + number 5 = five-hour, unit 6 = weekly; each has `remaining`,
// `percentage` (the USED share) and `nextResetTime` (ms). Depending on the plan
// level the metering is CREDIT_LIMIT (`usage` is the window ALLOWANCE, values are
// credits) or TOKENS_LIMIT (token metering).
export interface CodingPlanWindow {
  type: string
  unit: number
  number?: number
  remaining?: number
  usage?: number
  percentage?: number
  nextResetTime?: number
}

export async function fetchCodingPlanQuota(apiKey: string): Promise<CodingPlanWindow[]> {
  const r = await gatewayFetch("https://api.z.ai/api/monitor/usage/quota/limit", {
    headers: { authorization: apiKey },
  })
  const payload = r.json?.data ?? r.json
  if (r.json?.code !== undefined && r.json.code !== 0 && r.json.code !== 200) {
    throw new Error(`quota/limit failed: code=${r.json.code} ${r.json.msg ?? ""}`)
  }
  return (Array.isArray(payload?.limits) ? payload.limits : [])
    .filter((l: any) => l?.type === "TOKENS_LIMIT" || l?.type === "CREDIT_LIMIT")
    .map((l: any) => ({
      type: String(l.type),
      unit: l.unit,
      ...(typeof l.number === "number" ? { number: l.number } : {}),
      ...(typeof l.remaining === "number" ? { remaining: l.remaining } : {}),
      ...(typeof l.usage === "number" ? { usage: l.usage } : {}),
      ...(typeof l.percentage === "number" ? { percentage: l.percentage } : {}),
      ...(typeof l.nextResetTime === "number" ? { nextResetTime: l.nextResetTime } : {}),
    }))
}

// Start Plan (JWT): billing/balance also returns `data.balances[]` — per-entitlement
// token buckets with the models they apply to. `remaining_units` is the display
// remaining (available_units additionally subtracts reserved, do not use it).
export interface StartPlanBalance {
  showName: string
  capabilities: string[]
  remaining?: number
  total?: number
  used?: number
  expiresAt?: number
}

// The balance endpoint delivers unit counts as numbers or numeric strings.
function parseUnits(value: any): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

export async function fetchStartPlanBalances(jwt: string, mid: string): Promise<StartPlanBalance[]> {
  const r = await gatewayFetch(`${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, {
    headers: giftHeaders(jwt, mid),
  })
  if (r.json?.code !== 0) throw new Error(`billing/balance failed: code=${r.json?.code ?? r.status} ${r.json?.msg ?? ""}`)
  return (Array.isArray(r.json?.data?.balances) ? r.json.data.balances : [])
    .map((b: any) => {
      const remaining = parseUnits(b?.remaining_units)
      const total = parseUnits(b?.total_units)
      const used = parseUnits(b?.used_units)
      if (remaining === undefined && total === undefined && used === undefined) return undefined
      return {
        showName: String(b?.show_name ?? "").slice(0, 80),
        capabilities: Array.isArray(b?.capabilities) ? b.capabilities.map(String) : [],
        ...(remaining !== undefined ? { remaining } : {}),
        ...(total !== undefined ? { total } : {}),
        ...(used !== undefined ? { used } : {}),
        ...(typeof b?.expires_at === "number" ? { expiresAt: b.expires_at * 1000 } : {}),
      }
    })
    .filter((b: any): b is StartPlanBalance => b !== undefined)
}
