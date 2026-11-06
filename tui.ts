// tui.ts — TUI part of zcode-benefits: client-side /zai-* commands.
//
// The TUI auto-loads this part from the installed package (the server side
// advertises features.tui, so no tui.json changes are needed). The commands
// run entirely in the TUI process — they talk to the Z.AI gateway directly
// with the stored Start Plan token and display results in dialogs, exactly
// like /update. Zero model involvement: no synthetic messages, no LLM turns.
//
// Gateway access, gift helpers and the captcha flow live in shared.ts and
// captcha.ts — imported here and by the server entry.

import {
  deviceMid,
  fetchCaptchaConfig,
  fetchGiftClaims,
  gatewayFetch,
  claimPlan,
  reportCampaignAction,
  PROVIDER_ID,
} from "./shared.ts"
import { captchaProofHeaders, startCaptchaVerification } from "./captcha.ts"

// External TUI plugins expose dialogs and the toast under context.ui.
function ui(context: any): any {
  return context.ui
}

async function token(context: any): Promise<string> {
  // The promise client unwraps `.data` itself: credential.list() returns the
  // CredentialEntry[] directly (defensively accept the wrapped shape too).
  const listed = await context.client.credential.list()
  const entries: any[] = Array.isArray(listed) ? listed : (listed?.data ?? [])
  const entry = entries.find(
    (c: any) =>
      c.integrationID === PROVIDER_ID &&
      c.value?.type === "oauth" &&
      typeof c.value?.access === "string" &&
      c.value.access.length > 0,
  )
  if (!entry) throw new Error("Not signed in to Z.AI Start Plan — run `opencode auth login` first.")
  return String(entry.value.access)
}

// ── command flows (client-side dialogs, zero model involvement) ──

async function checkFlow(context: any): Promise<void> {
  const jwt = await token(context)
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
  const jwt = await token(context)
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
