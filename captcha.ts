// captcha.ts — Aliyun CAPTCHA 2.0 (browser-rendered proof), shared by the
// server gate (model-request captcha) and the TUI claim command.
//
// The gateway verifies claims/requests with an Aliyun captcha proof: the param
// produced by the official web widget, sent as X-Aliyun-Captcha-Verify-Param
// (+ X-Aliyun-Captcha-Verify-Region). The widget params (sceneId/prefix/region)
// come from client/configs. The same widget is rendered on a local page, the
// system browser (or the user) opens it, and the earned proof is captured.
// Proofs are single-use and short-lived, so each is consumed on first use.
//
// Exact widget integration copied from the ZCode desktop bundle: AliyunCaptchaConfig
// is set before the script loads, and the proof arrives via the success callback.

import { createServer } from "node:http"

export interface CaptchaProof {
  param: string
  region?: string
  at: number
}

const PROOF_TTL_MS = 120_000

// Per-process proof store. The server part consumes it for gated model requests;
// the TUI part consumes it for claim retries. (The TUI and the server run in
// separate processes, so each keeps its own store.)
let storedProof: CaptchaProof | null = null

export function captchaProofHeaders(): Record<string, string> {
  const proof = storedProof
  storedProof = null
  if (!proof || Date.now() - proof.at > PROOF_TTL_MS) return {}
  return {
    "X-Aliyun-Captcha-Verify-Param": proof.param,
    ...(proof.region ? { "X-Aliyun-Captcha-Verify-Region": proof.region } : {}),
  }
}

export function captchaPage(cfg: any): string {
  const config = JSON.stringify({ sceneId: cfg?.sceneId ?? "", prefix: cfg?.prefix ?? "", region: cfg?.region ?? "sgp" })
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ZCode verification</title>
<script>
  const CFG = ${config};
  window.AliyunCaptchaConfig = { region: CFG.region, prefix: CFG.prefix };
</script>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
<style>
  body { font-family: system-ui, sans-serif; background: #101418; color: #e8e8e8; display: grid;
         place-items: center; min-height: 90vh; margin: 0; }
  main { text-align: center; max-width: 28rem; }
  button { font-size: 1rem; padding: .6rem 1.4rem; border-radius: .5rem; border: 0; cursor: pointer;
           background: #2f6feb; color: #fff; }
  #captcha-element { margin-top: 1rem; }
  #status { min-height: 1.5rem; color: #9ab; white-space: pre-wrap; }
</style></head>
<body><main>
  <h2>ZCode security verification</h2>
  <p>Complete the captcha to unlock the gift claim / plan requests.</p>
  <button id="verify-button">Start verification</button>
  <div id="captcha-element"></div>
  <p id="status"></p>
</main>
<script>
  let instance = null;
  const status = (text) => { document.getElementById("status").textContent = text };
  initAliyunCaptcha({
    SceneId: CFG.sceneId,
    region: CFG.region,
    prefix: CFG.prefix,
    mode: "popup",
    language: "en",
    showErrorTip: false,
    element: "#captcha-element",
    button: "#verify-button",
    getInstance: (i) => {
      instance = i;
      status("Captcha ready — click again to open it");
    },
    success: async (captchaVerifyParam) => {
      try {
        const r = await fetch("/proof", { method: "POST", body: captchaVerifyParam });
        status(r.ok ? "Proof captured — you can close this page and retry in opencode." : "Failed to deliver the proof.");
      } catch { status("Failed to deliver the proof."); }
    },
    fail: (e) => status("Captcha failed: " + (e?.msg ?? "unknown")),
    onError: (e) => status("Captcha error: " + (e?.msg ?? "unknown")),
  });
</script></body></html>`
}

// Serves the captcha page on 127.0.0.1, fires onReady with the page URL as soon
// as it exists, and resolves once the user-earned proof has been captured (or on
// timeout). The caller decides how to surface the link (dialog / notification).
export function startCaptchaVerification(deps: {
  captchaConfig: () => Promise<any>
  onReady: (url: string) => Promise<void> | void
}, timeoutMs = 180_000): Promise<{ ok: boolean; url: string }> {
  let pageUrl = ""
  return new Promise((resolve) => {
    let settled = false
    let server: ReturnType<typeof createServer> | null = null
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      try { server?.close() } catch {}
      resolve({ ok, url: pageUrl })
    }
    server = createServer((req, res) => {
      if (req.method === "GET") {
        void deps
          .captchaConfig()
          .catch(() => ({}))
          .then((cfg) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
            res.end(captchaPage(cfg))
          })
        return
      }
      if (req.method === "POST" && req.url === "/proof") {
        let body = ""
        req.on("data", (chunk) => (body += chunk))
        req.on("end", () => {
          const param = body.trim()
          if (!param) {
            res.writeHead(400)
            res.end("empty")
            return
          }
          void deps
            .captchaConfig()
            .catch(() => ({}))
            .then((cfg) => {
              storedProof = { param, region: cfg?.region, at: Date.now() }
              res.writeHead(200)
              res.end("ok")
              setTimeout(() => done(true), 250)
            })
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.on("error", () => done(false))
    server.listen(0, "127.0.0.1", () => {
      const port = (server!.address() as any).port
      pageUrl = `http://127.0.0.1:${port}/`
      const countdown = () => setTimeout(() => done(!!storedProof), timeoutMs)
      if (deps.onReady) void Promise.resolve(deps.onReady(pageUrl)).then(countdown, countdown)
      else countdown()
    })
  })
}
