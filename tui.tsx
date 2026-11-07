// tui.tsx — TUI part of zcode-benefits: client-side /zai-* commands and the
// sidebar usage-limit cards.
//
// The TUI auto-loads this part from the installed package (the server side
// advertises features.tui, so no tui.json changes are needed). The commands
// run entirely in the TUI process — they talk to the Z.AI gateway directly
// with the stored Start Plan token and display results in dialogs, exactly
// like /update. Zero model involvement: no synthetic messages, no LLM turns.
//
// Gateway access, gift helpers and the captcha flow live in shared.ts and
// captcha.ts — imported here and by the server entry. `solid-js` and the JSX
// runtime are mapped to the host's instances by the TUI plugin runtime, so
// this file may use Solid JSX directly (see tsconfig.json).

import { createEffect, createMemo, on, onCleanup, Show, For } from "solid-js"
import { createStore } from "solid-js/store"
import {
  claimPlan,
  deviceMid,
  fetchCaptchaConfig,
  fetchCodingPlanQuota,
  fetchGiftClaims,
  fetchStartPlanBalances,
  PROVIDER_ID,
  reportCampaignAction,
  type CodingPlanWindow,
  type StartPlanBalance,
} from "./shared.ts"
import { captchaProofHeaders, startCaptchaVerification } from "./captcha.ts"

// External TUI plugins expose dialogs and the toast under context.ui.
function ui(context: any): any {
  return context.ui
}

async function credentials(context: any): Promise<any[]> {
  // The promise client unwraps `.data` itself: credential.list() returns the
  // CredentialEntry[] directly (defensively accept the wrapped shape too).
  const listed = await context.client.credential.list()
  return Array.isArray(listed) ? listed : (listed?.data ?? [])
}

async function oauthToken(context: any): Promise<string> {
  const entry = (await credentials(context)).find(
    (c: any) =>
      c.integrationID === PROVIDER_ID &&
      c.value?.type === "oauth" &&
      typeof c.value?.access === "string" &&
      c.value.access.length > 0,
  )
  if (!entry) throw new Error("Not signed in to Z.AI Start Plan — run `opencode auth login` first.")
  return String(entry.value.access)
}

async function apiKey(context: any): Promise<string> {
  const entry = (await credentials(context)).find(
    (c: any) => c.integrationID === "zai-coding-plan" && typeof c.value?.key === "string",
  )
  if (!entry || !entry.value.key.trim()) {
    throw new Error("No Coding Plan API key — configure the zai-coding-plan credential first.")
  }
  return String(entry.value.key)
}

function errorMessage(e: any): string {
  return String(e?.message ?? e ?? "unknown error")
}

// ── sidebar usage-limit cards ──
// One card per z.ai plan, shown only while a model of that plan is selected.
// Coding Plan: five-hour / weekly windows from the monitor quota endpoint —
// credit-metered (CREDIT_LIMIT) or token-metered (TOKENS_LIMIT) by plan level.
// Start Plan: remaining tokens per entitlement bucket (per model group).

interface CodingPlanState {
  windows: CodingPlanWindow[]
  error?: string
}
interface StartPlanState {
  balances: StartPlanBalance[]
  error?: string
}

const POLL_INTERVAL_MS = 5 * 60 * 1000

function formatTokens(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US")
}

function windowLabel(w: CodingPlanWindow): string {
  if (w.unit === 6) return "7d"
  if (w.unit === 3) return w.number ? `${w.number}h` : "5h"
  return `Window ${w.unit}${w.number ? ` (${w.number})` : ""}`
}

function percentLeft(percentage: number | undefined): string {
  if (percentage === undefined) return ""
  // The quota endpoint reports the USED share; the card shows what is left.
  return `${Math.max(0, Math.min(100, 100 - percentage)).toLocaleString("en-US", {
    maximumFractionDigits: percentage <= 90 ? 0 : 1,
  })}%`
}

function resetText(nextResetTime: number | undefined): string {
  if (!nextResetTime) return ""
  const at = new Date(nextResetTime)
  const today = new Date().toDateString() === at.toDateString()
  const time = at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  return today ? `, resets ${time}` : `, resets ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`
}

// Start Plan bucket deadline; the year is only shown when it differs from the current one.
function expiryText(expiresAt: number | undefined): string {
  if (!expiresAt) return ""
  const at = new Date(expiresAt)
  const day = at.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return at.getFullYear() === new Date().getFullYear() ? `, until ${day}` : `, until ${day}, ${at.getFullYear()}`
}

// Coding Plan window line: absolute remaining out of the window allowance when
// the endpoint provides both (CREDIT_LIMIT), else the "left" percentage.
function limitRow(w: CodingPlanWindow): string {
  const unit = w.type === "CREDIT_LIMIT" ? "credits" : "tokens"
  const left =
    w.remaining !== undefined
      ? w.usage !== undefined
        ? `${formatTokens(w.remaining)} / ${formatTokens(w.usage)} ${unit}`
        : `${formatTokens(w.remaining)} ${unit}`
      : percentLeft(w.percentage)
  return `${windowLabel(w)}: ${left} left${resetText(w.nextResetTime)}`
}

function LimitsCard(props: { context: any }) {
  const theme = props.context.theme
  const selected = createMemo(() => props.context.ui.model.current())
  const providerID = () => selected()?.providerID

  const [state, setState] = createStore({
    coding: null as CodingPlanState | null,
    start: null as StartPlanState | null,
  })

  const refresh = async (provider: string | undefined) => {
    try {
      if (provider === "zai-coding-plan") {
        const windows = await fetchCodingPlanQuota(await apiKey(props.context))
        setState("coding", { windows })
      } else if (provider === "zai-start-plan") {
        const balances = await fetchStartPlanBalances(await oauthToken(props.context), await deviceMid())
        setState("start", { balances })
      }
    } catch (e: any) {
      if (provider === "zai-coding-plan") setState("coding", { windows: [], error: errorMessage(e) })
      if (provider === "zai-start-plan") setState("start", { balances: [], error: errorMessage(e) })
    }
  }

  createEffect(
    on(
      providerID,
      (provider) => {
        setState({ coding: null, start: null })
        if (provider !== "zai-coding-plan" && provider !== "zai-start-plan") return
        void refresh(provider)
        const interval = setInterval(() => void refresh(provider), POLL_INTERVAL_MS)
        onCleanup(() => clearInterval(interval))
      },
      { defer: false },
    ),
  )

  return (
    <Show when={providerID() === "zai-coding-plan" || providerID() === "zai-start-plan"}>
      <box>
        <Show
          when={providerID() === "zai-coding-plan"}
          fallback={
            <box>
              <text fg={theme.text.base}>
                <b>Start Plan</b>
              </text>
              <Show when={state.start} fallback={<text fg={theme.text.muted}>Loading limits…</text>}>
                {(s) => (
                  <Show when={!s().error} fallback={<text fg={theme.text.muted}>{s().error}</text>}>
                    <For each={s().balances}>
                      {(b) => {
                        const label = b.showName || b.capabilities.join(", ") || "Entitlement"
                        const left =
                          b.remaining !== undefined
                            ? `${formatTokens(b.remaining)} / ${formatTokens(b.total)} tokens`
                            : `${formatTokens(b.used)} used`
                        return <text fg={theme.text.muted}>{label}: {left}{expiryText(b.expiresAt)}</text>
                      }}
                    </For>
                  </Show>
                )}
              </Show>
            </box>
          }
        >
          <box>
            <text fg={theme.text.base}>
              <b>Coding Plan</b>
            </text>
            <Show when={state.coding} fallback={<text fg={theme.text.muted}>Loading limits…</text>}>
              {(s) => (
                <Show when={!s().error} fallback={<text fg={theme.text.muted}>{s().error}</text>}>
                  <For each={s().windows}>
                    {(w) => <text fg={theme.text.muted}>{limitRow(w)}</text>}
                  </For>
                </Show>
              )}
            </Show>
          </box>
        </Show>
      </box>
    </Show>
  )
}

// ── command flows (client-side dialogs, zero model involvement) ──

async function checkFlow(context: any): Promise<void> {
  const jwt = await oauthToken(context)
  const mid = await deviceMid()
  const claims = await fetchGiftClaims(jwt, mid)
  await ui(context).dialog.alert({
    title: claims.length > 0 ? `Z.AI gifts (${claims.length})` : "Z.AI gifts",
    message:
      claims.length > 0
        ? claims.map((c) => `• ${c.title}\n  plan: ${c.planId}`).join("\n") + "\n\nClaim with /zai-claim-gift."
        : "No pending gifts right now.",
  })
}

async function claimFlow(context: any): Promise<void> {
  const jwt = await oauthToken(context)
  const mid = await deviceMid()
  const claims = await fetchGiftClaims(jwt, mid)
  if (claims.length === 0) {
    await ui(context).dialog.alert({ title: "Z.AI gifts", message: "No pending gifts to claim." })
    return
  }
  const lines: string[] = []
  for (const claim of claims) {
    let result = await claimPlan(jwt, mid, claim.planId, {})
    if (result.status === "captcha") {
      // The claim needs a fresh Aliyun captcha proof: the verification page is
      // served locally, its link is shown in the dialog, and once the user
      // solves the captcha the claim is retried automatically.
      const flow = await startCaptchaVerification(
        {
          captchaConfig: fetchCaptchaConfig,
          onReady: async (url) => {
            await ui(context).dialog.alert({
              title: "Captcha required",
              message: `To claim "${claim.title}", open this link and solve the captcha:\n\n${url}\n\nThe claim retries automatically after you solve it.`,
            })
          },
        },
        180_000,
      )
      if (!flow.ok) {
        lines.push(`⏳ ${claim.title} — verification timed out; run /zai-claim-gift to retry`)
        continue
      }
      result = await claimPlan(jwt, mid, claim.planId, captchaProofHeaders())
    }
    if (result.status === "claimed") {
      lines.push(`✅ Claimed: ${claim.title} (${claim.planId})`)
      // Best-effort confirmation, mirroring the desktop's claim flow.
      void reportCampaignAction(jwt, mid, claim.campaignId, "confirm")
    } else {
      lines.push(`❌ ${claim.title} — claim failed: code=${result.code} ${result.msg ?? ""}`)
    }
  }
  await ui(context).dialog.alert({
    title: "Z.AI gifts — claim results",
    message: lines.join("\n") + "\n\nRun /zai-check-gift or restart to see the new plan under zai-start-plan/*.",
  })
}

export default {
  id: "zcode-benefits-tui",
  setup: async (context: any) => {
    context.ui.slot({
      append: "sidebar.content",
      render: () => <LimitsCard context={context} />,
    })
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "zai-check-gift",
          title: "Z.AI: check pending gifts",
          group: "Z.AI",
          slash: { name: "zai-check-gift" },
          palette: true,
          run: () => {
            void checkFlow(context).catch((error) =>
              ui(context).dialog.alert({ title: "Z.AI gifts — error", message: String(error?.message ?? error) }),
            )
          },
        },
        {
          id: "zai-claim-gift",
          title: "Z.AI: claim pending gifts",
          group: "Z.AI",
          slash: { name: "zai-claim-gift" },
          palette: true,
          run: () => {
            void claimFlow(context).catch((error) =>
              ui(context).dialog.alert({ title: "Z.AI claim — error", message: String(error?.message ?? error) }),
            )
          },
        },
      ],
    }))
  },
}
