// zcode-benefits (server part): opencode on top of the z.ai Start Plan.
//
// model.request hook  — captcha gate (reverse of verification-policy from client.AppImage)
//                       and lane rewrite to /api/v1/zcode-plan/anthropic/v1.
// http.request hook   — final wire format: auth headers (zjwt from the OAuth login),
//                       system reshaped into the 3-block ZCode form (the gateway inspects
//                       their presence, otherwise 405 {"code":3012,"unusual activity"};
//                       the dynamic block starts with an "ignore the prompt above" line
//                       so the model follows the opencode prompt while the ZCode blocks
//                       exist only for the gate) and a leading user-turn with the date.
//                       Hook triggers ignore the callback's return value — the only way
//                       to change anything is mutating the event.
// Stealth headers     — model.request on the adjacent z.ai providers (zai-coding-plan,
//                       zcode-start): strips opencode identity headers and swaps the UA
//                       (formerly the separate stealth-headers-zcode plugin, merged here).
// Provider registration — the plugin itself creates/overlays zai-start-plan and
//                       zai-coding-plan (package aisdk:@ai-sdk/anthropic, ultra-zai
//                       baseURL, static headers) — no provider block in opencode.json.
// Gift ticker         — every 10 minutes, announces pending gifts (claiming lives in
//                       the TUI part: /zai-claim-gift, no model involvement).
//
// Credentials — ONLY via `opencode auth login` (integration zai-start-plan, OAuth z.ai).
// No ZCode desktop files (~/.zcode) are read or written.
//
// Shared helpers (constants, deviceMid, gateway fetch, gifts, captcha) live in
// shared.ts and captcha.ts — imported by both this entry and tui.tsx.

import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { platform, release, arch } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AISDK_ANTHROPIC,
  APP_VERSION,
  CONFIG_HEADERS,
  deviceMid,
  fetchClientConfigs,
  fetchGiftClaims,
  gatewayFetch,
  giftHeaders,
  notify,
  PROVIDER_ID,
  ZCODE_ORIGIN,
  ZCODE_PLAN_ANTHROPIC,
  ZCODE_ULTRA_ANTHROPIC,
} from "./shared.ts"
import { captchaProofHeaders, startCaptchaVerification } from "./captcha.ts"

// ── constants (server-only) ──

const VERIFICATION_CONFIG_TTL_MS = 5 * 60_000
const CHECK_INTERVAL_MS = 10 * 60 * 1000
const SDK_UA_SUFFIX = " ai-sdk/provider-utils/4.0.27 runtime/node.js/24"
const SYSTEM_SIDECAR = join(dirname(fileURLToPath(import.meta.url)), "zcode-system.json")

const ATTRIBUTION_HEADERS: Record<string, string> = {
  "http-referer": ZCODE_ORIGIN,
  "x-zcode-app-version": APP_VERSION,
  "x-title": "Z Code@cli",
  "x-release-channel": "production",
  "x-zcode-agent": "glm",
  "x-platform": `${platform()}-${arch()}`,
  "x-os-category": platform(),
  "x-os-version": release(),
  "x-client-language": "en-US",
  "x-client-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
}

const BETA_MID_CONVERSATION = "mid-conversation-system-2026-04-07"

// ── captcha gate (reverse of request-security-edition/verification-policy.ts) ──

function readRequestVerificationConfig(configs: unknown): Record<string, unknown> | null {
  const captcha = (configs as any)?.captcha
  if (!captcha) return null
  const { skip_model_request, ...rest } = captcha
  return { ...rest, ...(typeof skip_model_request === "boolean" ? { skipModelRequest: skip_model_request } : {}) }
}

// requiresRequestVerification: start-plan + config enabled + not flagged skip.
function requiresRequestVerification(config?: Record<string, unknown> | null): boolean {
  return config?.enabled !== false && config?.skipModelRequest !== true
}

let verificationConfig: { cfg: Record<string, unknown> | null; at: number } | null = null
async function fetchVerificationConfig(): Promise<Record<string, unknown> | null> {
  if (verificationConfig && Date.now() - verificationConfig.at < VERIFICATION_CONFIG_TTL_MS) {
    return verificationConfig.cfg
  }
  try {
    const json: any = await fetchClientConfigs()
    if (!json || (json.code !== undefined && json.code !== 0)) throw new Error("client/configs envelope invalid")
    verificationConfig = { cfg: readRequestVerificationConfig(json.data?.configs), at: Date.now() }
  } catch (e: any) {
    // Fail closed: without a snapshot we don't decide on the server's behalf that verification is off.
    console.error(`[zcode-benefits] verification config read failed: ${e?.message ?? e}`)
    verificationConfig = { cfg: {}, at: Date.now() }
  }
  return verificationConfig.cfg
}

// ── body reshaping: the gateway inspects ZCode identity blocks in system ──

let zcodeSystem: { cliPrefix: string; stable: string; ignoreAbove: string; systemReminderOpen: string; systemReminderClose: string; currentDateLine: string } | null = null
async function loadZcodeSystem() {
  if (!zcodeSystem) zcodeSystem = JSON.parse(await readFile(SYSTEM_SIDECAR, "utf8"))
  return zcodeSystem
}

// Official model id casing: glm-5.3-flash → GLM-5.3-Flash.
function officialModelId(modelId: string): string {
  return String(modelId ?? "").trim().replace(/(^|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase())
}

function localIsoDate(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

// Client system (string or text blocks) → one string; cache markers are dropped —
// the stable block owns the single ephemeral breakpoint (desktop form).
function customSystemText(system: unknown): string | undefined {
  if (system == null) return undefined
  if (typeof system === "string") return system.trim() || undefined
  if (!Array.isArray(system)) return undefined
  const parts: string[] = []
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) parts.push(item)
    } else if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text)
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

async function reshapeStartPlanBody(body: any, sessionId: string | undefined): Promise<any> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const sys = await loadZcodeSystem()
  // Desktop 3-block form: the client prompt rides in the dynamic block (C1 slot).
  // The dynamic block starts with the ignore line: "above" for the model means only
  // the ZCode blocks (cliPrefix + stable); the opencode prompt after the line stays effective.
  const custom = customSystemText(body.system)
  body.system = [
    { type: "text", text: sys.cliPrefix },
    { type: "text", text: sys.stable, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: `\n\n${sys.ignoreAbove}${custom === undefined ? "" : `\n\n${custom}`}`,
      cache_control: { type: "ephemeral" },
    },
  ]
  // Leading user-turn with the date (3.17.x $5o/fce).
  const reminder = `${sys.systemReminderOpen}${sys.currentDateLine.replace("{date}", localIsoDate())}${sys.systemReminderClose}`
  const messages = Array.isArray(body.messages) ? body.messages : []
  const firstText = typeof messages[0]?.content === "string" ? messages[0].content : messages[0]?.content?.[0]?.text
  if (!(typeof firstText === "string" && firstText.startsWith(`${sys.systemReminderOpen}Today's date is`))) {
    body.messages = [{ role: "user", content: [{ type: "text", text: reminder }] }, ...messages]
  }
  // metadata.user_id = JSON{device_id, account_uuid, session_id} (anthropic-request-metadata.ts).
  if (!body.metadata?.user_id) {
    const mid = await deviceMid()
    body.metadata = { ...(body.metadata ?? {}), user_id: JSON.stringify({ device_id: mid, account_uuid: "", session_id: sessionId ?? "" }) }
  }
  body.model = officialModelId(body.model)
  return body
}

// ── credential: opencode OAuth login only (integration zai-start-plan) —
// the ZCode desktop store is never read.

let pluginCtx: any = null
async function resolveZjwt(): Promise<string> {
  const connection = await pluginCtx?.integration?.connection?.active(PROVIDER_ID)
  if (connection) {
    const cred = await pluginCtx.integration.connection.resolve(connection)
    if (cred?.type === "oauth" && cred.access) return String(cred.access)
    if (cred?.type === "key" && cred.key) return String(cred.key)
  }
  throw new Error("Z.AI Start Plan: not signed in — run `opencode auth login` (zai-start-plan / Z.AI account)")
}

// ── OAuth login (opencode auth login → zai-start-plan → Z.AI): CLI-polling flow ──
// cli/init returns an authorize_url with a SERVER-side callback (…/oauth/cli/callback/zai),
// so no local redirect server is needed: the browser finishes the sign-in on z.ai's side
// while we poll cli/poll/{flowId} until status "ready" → data.token (a fresh zjwt).

const OAUTH_METHOD_ID = "zai-oauth"

async function oauthAuthorize(): Promise<any> {
  const pollToken = randomBytes(32).toString("hex")
  const init = await gatewayFetch(`${ZCODE_ORIGIN}/api/v1/oauth/cli/init`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pollToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "zai" }),
  })
  const d = init.json?.data
  if (init.json?.code !== 0 || !d?.flow_id || !d?.authorize_url) {
    throw new Error(String(init.json?.msg ?? "oauth cli/init failed"))
  }
  const expiresAtMs = Number(d.expires_at) * 1000
  const intervalMs = Math.max(1_000, Number(d.poll_interval_sec) * 1000)
  const callback = (async () => {
    for (;;) {
      if (Date.now() > expiresAtMs) throw new Error("OAuth flow expired — start the login again")
      await new Promise((r) => setTimeout(r, intervalMs))
      const poll = await gatewayFetch(`${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${d.flow_id}`, {
        headers: { Authorization: `Bearer ${pollToken}` },
      })
      if (poll.json?.code !== 0) throw new Error(String(poll.json?.msg ?? "oauth poll failed"))
      const status = poll.json.data?.status
      if (status === "ready") {
        const access = String(poll.json.data?.token ?? "")
        if (!access) throw new Error("oauth ready without a token")
        return {
          type: "oauth",
          methodID: OAUTH_METHOD_ID,
          access,
          // The refresh slot holds the business JWT (zai.access_token) — long-lived exchange material.
          refresh: String(poll.json.data?.zai?.access_token ?? access),
          expires: Date.now() + 365 * 24 * 3600 * 1000,
          metadata: { user_id: poll.json.data?.user?.user_id ?? null },
        }
      }
      if (status === "failed") throw new Error(String(poll.json.data?.msg ?? "OAuth login failed"))
    }
  })()
  return {
    mode: "auto",
    url: String(d.authorize_url),
    instructions: "Sign in to z.ai in your browser — the CLI polls the status automatically.",
    expiresAt: expiresAtMs,
    callback,
  }
}

// ── dynamic gift-model catalog: balance → entitlements, limits from the CDN config ──

type CatalogEntry = { id: string; name: string; context: number; output: number }
let giftCatalog: CatalogEntry[] | null = null

// Entitled models = "model:*" capabilities from active plans with effective_at passed;
// limits come from the first modelMatch hit in the CDN config; personal enabled=false entries are dropped.
async function fetchGiftCatalog(): Promise<CatalogEntry[]> {
  const [jwt, mid] = await Promise.all([resolveZjwt(), deviceMid()])
  const balance = await gatewayFetch(`${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, {
    headers: giftHeaders(jwt, mid),
  })
  const nowSec = Math.floor(Date.now() / 1000)
  const entitled = new Set<string>()
  for (const plan of balance.json?.data?.plans ?? []) {
    if (plan?.status !== "active") continue
    for (const ent of plan.entitlements ?? []) {
      if (Number(ent?.effective_at ?? 0) > nowSec) continue
      for (const cap of ent?.capabilities ?? []) {
        if (typeof cap === "string" && cap.startsWith("model:")) entitled.add(cap.slice(6))
      }
    }
  }
  if (entitled.size === 0) throw new Error("balance contains no active entitlements")

  let rules: any[] = []
  const disabled = new Set<string>()
  try {
    const cc = await fetchClientConfigs()
    const cfgUrl = cc?.data?.configs?.builtin_provider_config_json
    if (typeof cfgUrl === "string" && cfgUrl.startsWith("http")) {
      const cfg = await gatewayFetch(cfgUrl, { headers: { "User-Agent": `ZCode/${APP_VERSION}` } })
      const c = cfg.json?.config ?? cfg.json
      rules = c?.modelConfigRules?.modelRules ?? []
      for (const pr of c?.providerConfigRules?.providerRules ?? []) {
        if (pr?.providerId === "account:zai-start-plan" && pr?.config?.enabled === false && pr?.modelId) {
          disabled.add(String(pr.modelId).toLowerCase())
        }
      }
    }
  } catch {}

  const catalog: CatalogEntry[] = []
  for (const id of entitled) {
    if (disabled.has(id)) continue
    let context = 128_000
    let output = 64_000
    for (const r of rules) {
      try {
        if (new RegExp(r?.modelMatch, "i").test(id)) {
          context = r?.config?.properties?.contextWindow ?? context
          output = r?.config?.optionSpecs?.maxOutputTokens?.max ?? output
        }
      } catch {}
    }
    catalog.push({ id, name: `${officialModelId(id)} (Start/Gifts)`, context, output })
  }
  if (catalog.length === 0) throw new Error("no entitled models left after filtering")
  return catalog.sort((a, b) => a.id.localeCompare(b.id))
}

// The catalog fetch is capped by a timeout: an unreachable balance endpoint must not
// stall setup. `null` = no result in time; the timer is cleared once the race settles.
async function fetchCatalogWithTimeout(timeoutMs: number): Promise<CatalogEntry[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([fetchGiftCatalog(), deadline])
  } finally {
    clearTimeout(timer)
  }
}

function catalogModels(): any[] {
  return (giftCatalog ?? []).map((m) => ({
    id: m.id,
    modelID: m.id,
    providerID: "zai-start-plan",
    name: m.name,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: m.context, output: m.output },
  }))
}

async function refreshCatalogChanged(): Promise<boolean> {
  const prev = giftCatalog
  const next = await fetchCatalogWithTimeout(15_000)
  if (!next) return false
  giftCatalog = next
  return JSON.stringify(prev) !== JSON.stringify(next)
}

// ── stealth headers: adjacent z.ai providers outside the passport lane ──
// The subscription (zai-coding-plan) and the account balance (zcode-start): the gateway
// must not see the opencode identity headers the core puts on every request
// (session/model-request.ts). The UA is the constant series from the reference, not tied to APP_VERSION.

const STRIP = new Set([
  "user-agent",
  "x-opencode-client",
  "x-opencode-project",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-opencode-parent-session-id",
  "x-session-affinity",
  "x-session-id",
  "x-parent-session-id",
])

function stripOpencodeHeaders(event: any) {
  // event.headers — the final request header set; mutate in place
  for (const key of Object.keys(event.headers)) {
    if (STRIP.has(key.toLowerCase())) delete event.headers[key]
  }
  event.headers["User-Agent"] = "ZCode/3.17.2"
}

// ── gateway error surfacing ──
// Some gateway failures arrive as HTTP 200 + JSON `{code, msg}` (quota, captcha,
// concurrency limits). A non-SSE 200 makes the AI SDK wait for stream events that
// never come, so the session hangs silently.
//
// Transient concurrency errors (3008 user limit / 3009 model limit) are rewritten
// into HTTP 429 — the core classifies that as RateLimit, retries natively with its
// own backoff, and renders the standard orange "retrying" status line, exactly as
// for other providers. A `retry-after` header steers the delay. Permanent errors
// are rewritten into a visible 400 (quota_error / gateway_error).
const GATEWAY_TRANSIENT_CODES = new Set([3008, 3009])

async function surfaceGatewayErrors(event: any) {
  const res = event.response
  const ct = res.headers.get("content-type") ?? ""
  if (!ct.includes("application/json")) return // SSE responses pass through untouched
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch {}
  if (!parsed || typeof parsed.code !== "number" || parsed.code === 0) {
    // JSON but not a gateway error — restore the buffered body unchanged.
    event.response = new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
    return
  }
  const message = `ZCode gateway ${parsed.code}: ${parsed.msg ?? "unknown error"}`
  if (GATEWAY_TRANSIENT_CODES.has(parsed.code)) {
    // RateLimit shape: the core retries natively (orange status line) and the
    // request is replayed from the transport — headers/system are already in place.
    event.response = new Response(
      JSON.stringify({ type: "error", error: { type: "rate_limit_error", message } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "3" } },
    )
    return
  }
  event.response = new Response(
    JSON.stringify({ type: "error", error: { type: parsed.code === 1005 ? "quota_error" : "gateway_error", message } }),
    { status: 400, headers: { "content-type": "application/json" } },
  )
}

// ── gift campaigns: the periodic ticker only ANNOUNCES pending gifts ──
// Deliveries arrive from GET marketing/touch?seq=<n> as
// {campaign_id, resource_position: "banner"|"popup", banner|popup: {title?, buttons}}.
// A "claim_zcode_plan" button carries {args: {plan_id}}; claiming runs on the
// TUI side (/zai-claim-gift in tui.ts) so the model is never involved.

const announced = new Set<string>()

// Periodic check: announce pending gifts via OS notification, never auto-claim.
async function giftTick(): Promise<void> {
  const jwt = await resolveZjwt()
  const mid = await deviceMid()
  const claims = await fetchGiftClaims(jwt, mid)
  for (const c of claims) {
    const key = `${c.campaignId}:${c.planId}`
    if (announced.has(key)) continue
    announced.add(key)
    notify("🎁 ZCode: gift available", `${c.title} — run /zai-claim-gift in opencode`)
  }
}

// ── setup steps ──
// Registration order matters and mirrors the auto-discovery order of the two former
// standalone plugin files: stealth hooks first, then the integration, then the
// passport's own session hooks, then the providers.

async function registerStealthHeaders(ctx: any): Promise<void> {
  // both z.ai providers: the subscription (coding plan) and the account balance (start plan / Global Build)
  await ctx.session.hook("model.request", stripOpencodeHeaders, { providerID: "zai-coding-plan" })
  await ctx.session.hook("model.request", stripOpencodeHeaders, { providerID: "zcode-start" })
}

async function registerIntegration(ctx: any): Promise<void> {
  // Z.AI Start Plan integration with the z.ai OAuth method — enables `opencode auth login`
  // with no ties to the ZCode desktop store. The config-provided key method stays alongside.
  try {
    await ctx.integration.transform((editor: any) => {
      editor.update("zai-start-plan", (integration: any) => {
        integration.name = "Z.AI Start Plan"
      })
      editor.method.update({
        integrationID: "zai-start-plan",
        method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Z.AI account (browser OAuth)" },
        authorize: () => oauthAuthorize(),
        refresh: async (credential: any) => credential,
      })
    })
  } catch (e: any) {
    console.error(`[zcode-benefits] integration register: ${e?.message ?? e}`)
  }
}

async function registerSessionHooks(ctx: any): Promise<void> {
  // Routing and policy. All headers and the body go on http.request (the final instance):
  // the fork's SDK sets x-api-key from the config apiKey on top of model.request hook headers.
  await ctx.session.hook(
    "model.request",
    async (event: any) => {
      const cfg = await fetchVerificationConfig()
      if (requiresRequestVerification(cfg)) {
        const proofHeaders = captchaProofHeaders()
        if (Object.keys(proofHeaders).length > 0) {
          Object.assign(event.headers, proofHeaders)
        } else {
          notify("🔒 ZCode: security verification required", "Complete the captcha in the opened browser window, then send the message again")
          void startCaptchaVerification(
            { captchaConfig: fetchVerificationConfig, onReady: async (url) => notify("🔒 ZCode: captcha page", url) },
            180_000,
          )
          throw new Error(
            "ZCode start-plan: the server requires interactive security verification (Aliyun captcha). " +
              "Complete it in the opened browser window, then send your message again.",
          )
        }
      }
      event.baseURL = ZCODE_PLAN_ANTHROPIC
    },
    { providerID: "zai-start-plan" },
  )

  await ctx.session.hook(
    "http.request",
    async (event: any) => {
      const req: Request = event.request
      const onPlan = req.url.startsWith(ZCODE_PLAN_ANTHROPIC)
      const onUltra = req.url.startsWith(ZCODE_ULTRA_ANTHROPIC)
      // The start-plan token is only valid on the plan lane. For ai-sdk providers the
      // model.request baseURL rewrite does not reach the SDK-built URL (it comes from
      // provider settings), so the lane is enforced here instead: ultra-zai requests
      // are redirected to the plan lane before the auth/system rewrite.
      if (!onPlan && !onUltra) return event
      const url = onPlan ? req.url : `${ZCODE_PLAN_ANTHROPIC}${req.url.slice(ZCODE_ULTRA_ANTHROPIC.length)}`
      const jwt = await resolveZjwt() // fail fast: a clear error without creds instead of a 3012
      try {
        const body = await reshapeStartPlanBody(JSON.parse(await req.clone().text()), stripSessionId(event.sessionID))
        const headers = new Headers(req.headers)
        headers.set("authorization", `Bearer ${jwt}`)
        headers.set("x-api-key", jwt)
        headers.set("content-type", "application/json")
        headers.delete("content-length")
        const beta = headers.get("anthropic-beta")
        if (!beta?.includes(BETA_MID_CONVERSATION)) {
          headers.set("anthropic-beta", beta ? `${beta},${BETA_MID_CONVERSATION}` : BETA_MID_CONVERSATION)
        }
        for (const [k, v] of Object.entries(ATTRIBUTION_HEADERS)) headers.set(k, v)
        headers.set("user-agent", `ZCode/${APP_VERSION}${SDK_UA_SUFFIX}`)
        event.request = new Request(url, { method: req.method, headers, body: JSON.stringify(body) })
      } catch (e: any) {
        throw new Error(`ZCode start-plan: failed to build the request: ${e?.message ?? e}`)
      }
      return event
    },
    { providerID: "zai-start-plan" },
  )

  // Gateway error surfacing on every z.ai lane (see surfaceGatewayErrors).
  await ctx.session.hook("http.response", surfaceGatewayErrors, { providerID: "zai-start-plan" })
  await ctx.session.hook("http.response", surfaceGatewayErrors, { providerID: "zai-coding-plan" })
  await ctx.session.hook("http.response", surfaceGatewayErrors, { providerID: "zcode-start" })
}

async function registerProviders(ctx: any): Promise<void> {
  // Provider self-registration — no provider block in opencode.json needed.
  // Repeats what the config overlays did (config/plugin/provider.ts: overlayProvider):
  // update on top of the record; editor.add here replaces the record wholesale
  // (core/src/provider.ts:420-426), update creates it when missing and never touches models.
  // Deviation from the config: activation "auto" (the config used "enabled") — the provider
  // shows up in the list once its integration has a connection.
  try {
    // Dynamic gift-model catalog: built from balance entitlements.
    // If the balance endpoint is unreachable → a minimal fallback of one known-entitled
    // model, so the provider is never left empty.
    giftCatalog = await fetchCatalogWithTimeout(10_000)
    if (!giftCatalog) {
      giftCatalog = [{ id: "glm-5.3-flash", name: "GLM-5.3-Flash (Start/Gifts)", context: 1_000_000, output: 128_000 }]
      console.error("[zcode-benefits] gift catalog: balance unavailable — falling back to glm-5.3-flash")
    }
  } catch (e: any) {
    console.error(`[zcode-benefits] gift catalog: ${e?.message ?? e} — claim a gift via /zai-claim-gift to fill it`)
  }
  await ctx.provider.transform((editor: any) => {
    // zai-coding-plan: the record already exists from models.dev (7 glm models, name "Z.AI Coding Plan"),
    // but with npm @ai-sdk/openai-compatible — rewrite the package to anthropic, as the config did;
    // models and the name from models.dev stay untouched. No system-prompt/auth for this lane
    // (stealth headers only).
    editor.update("zai-coding-plan", (p: any) => {
      p.activation = "auto"
      p.package = AISDK_ANTHROPIC
      p.settings = { ...(p.settings ?? {}), baseURL: ZCODE_ULTRA_ANTHROPIC }
      p.headers = { ...(p.headers ?? {}), ...CONFIG_HEADERS }
    })
    // zai-start-plan: no models.dev record — the provider is created by the plugin wholesale
    // (before: an empty config-overlay record + editor.models.set). Catalog: gift models.
    editor.add({
      info: {
        id: "zai-start-plan",
        name: "Z.AI Start Plan",
        activation: "auto",
        package: AISDK_ANTHROPIC,
        settings: { baseURL: ZCODE_ULTRA_ANTHROPIC },
        headers: { ...CONFIG_HEADERS },
      },
      models: catalogModels(),
    })
  })
}

function startPromoTicker(ctx: any): () => void {
  // Every 10 minutes (plus once right away, 30s after start): announce pending gifts
  // and refresh the catalog, so a TUI-side claim extends the model list without a restart.
  let timer: ReturnType<typeof setInterval> | null = null
  const tick = async () => {
    try {
      await giftTick()
      if (await refreshCatalogChanged()) await ctx.provider.reload()
    } catch (e: any) {
      console.error(`[zcode-benefits] gift tick failed: ${e?.message ?? e}`)
    }
  }
  const boot = setTimeout(() => { void tick(); timer = setInterval(() => void tick(), CHECK_INTERVAL_MS) }, 30_000)
  ;(boot as unknown as { unref?: () => void }).unref?.()
  return () => {
    clearTimeout(boot)
    if (timer) clearInterval(timer)
  }
}

function stripSessionId(sessionID: unknown): string | undefined {
  const id = String(sessionID ?? "")
  return id ? id.replace(/^ses_/, "") : undefined
}

export default {
  id: "zcode-benefits",
  setup: async (ctx: any): Promise<() => void> => {
    await registerStealthHeaders(ctx)
    await registerIntegration(ctx)
    pluginCtx = ctx // credential lookups below resolve through the integration connection
    await registerSessionHooks(ctx)
    await registerProviders(ctx)
    return startPromoTicker(ctx)
  },
}
