# AGENTS.md — developing zcode-benefits

An opencode plugin that runs `zai-start-plan` and `zai-coding-plan` through
the ZCode desktop gateway (`zcode.z.ai`) with a plain Z.AI account. The point
of the gateway lane is its metering: tokens sent through it are billed at a
0.67× coefficient versus the public API, so the plugin's whole job is making
opencode traffic indistinguishable from desktop-client traffic. Read
`README.md` for the user-facing picture and the bypass techniques.

## Layout

- `zcode-benefits.ts` — server entry: stealth/captcha/wire hooks, OAuth
  integration, provider self-registration, gift ticker (announce only).
  Default export must stay `{ id: "zcode-benefits", setup }` (the loader
  rejects anything else).
- `tui.ts` — TUI entry: client-side `/zai-check-gift` and `/zai-claim-gift`
  keymap commands with dialogs. Auto-loaded because the server advertises
  `features.tui` (package.json exports `"./tui"`). Zero model involvement.
- `shared.ts` — constants, deviceMid, gateway fetch, gift helpers — used by
  BOTH entries.
- `captcha.ts` — Aliyun widget page + local proof server + proof store.
  Per-process store: the server consumes proofs for gated model requests,
  the TUI consumes them for claim retries (separate processes, no sharing).
- `zcode-system.json` — sidecar data, loaded from
  `dirname(import.meta.url)`. **Must always sit next to `zcode-benefits.ts`**.
- `package.json` — npm/git manifest; the host resolves entrypoints through
  `exports` (`"."`/`"./plugin"` → server, `"./tui"` → TUI).
- `README.md` — user-facing docs (install + bypass techniques, no code
  description).

## Hard invariants — do not break

1. **English only** (owner decision): comments, user-facing strings,
   notifications, error messages, docs. No Cyrillic anywhere in this repo.
2. **Registration order in `setup` is significant**: stealth hooks
   (`zai-coding-plan`, then `zcode-start`) → integration → session hooks
   (`model.request` gate, then `http.request` wire) → providers. It mirrors
   the auto-discovery order of the two former standalone plugin files;
   changing it changes the middleware order on the wire.
3. **Hook semantics**: trigger loops ignore callback return values — the only
   way to affect a request is mutating the event in place (e.g. replacing
   `event.request` on `http.request`).
4. **Provider editor semantics** (core `provider.ts`): `editor.add` REPLACES
   the whole record; `editor.update` creates the record if missing and
   overlays fields without touching models. `zai-coding-plan` already exists
   from models.dev (7 glm models, name "Z.AI Coding Plan") — only overlay
   `package`/`settings`/`headers`/`activation` on it; never `add` it.
5. **UA constants**: the stealth hook uses the literal `"ZCode/3.17.2"`
   (intentionally frozen, not tied to `APP_VERSION`); wire impersonation of
   the client uses `APP_VERSION`.
6. **`STATE_FILE` keeps the legacy `zcode-passport` path** — `deviceMid` is
   the device identity the server has already seen; renaming the plugin must
   not rename the state directory.
7. **`ignoreAbove` line placement**: start of the dynamic (third) system
   block, *before* the opencode prompt — "the prompt above" must scope to the
   ZCode blocks only.
8. **`activation: "auto"`** on both providers is a deliberate deviation from
   the old config (`enabled`): providers appear once their integration has a
   connection.
9. **Fail closed** on the captcha gate: if `client/configs` says verification
   is required, refuse the request; never attempt to bypass the captcha.
10. The desktop's `~/.zcode` files are never read or written; credentials
    come only from the opencode store (server: integration connection;
    TUI: `credential.list()`, which returns the **unwrapped** entry array).
11. **No auto-claim**: the ticker only ANNOUNCES pending gifts; claiming runs
    exclusively through `/zai-claim-gift` in the TUI part.
12. **TUI dialogs live under `context.ui.dialog`** (not `context.dialog`) for
    external plugins; the captcha link is shown in a dialog — never
    auto-open the browser.
13. **Transient gateway errors** (3008 user / 3009 model concurrency limits)
    are rewritten to **HTTP 429 rate-limit shape** in `http.response`, so the
    core retries natively with its own backoff and the standard orange status
    line. Do not re-implement a fetch-retry loop; permanent codes (1005 quota,
    3007 captcha) surface as visible 400s.
14. **The plan lane is enforced at `http.request`**, not `model.request`:
    for ai-sdk providers the model.request `baseURL` rewrite does not reach
    the SDK-built URL — ultra-zai requests are redirected to the plan lane in
    `http.request` before the auth/system rewrite.

## Validation (before finishing any change)

The owner runs live opencode tests separately — **never launch opencode
yourself**. Validate with a fake context script (`check.ts`) run by any TS
runtime (production is Bun). Keep relative imports with explicit `.ts`
extensions — that is what the current files do and any runtime accepts. The
fake context must implement:

- `session.hook(name, cb, options)` recording registrations in order;
- a provider editor with the real core semantics: `add` = replace record,
  `update` = create-if-missing + field mutation (seed a models.dev-like
  `zai-coding-plan` record first, as the builtin models.dev plugin runs
  before user plugins);
- `integration.connection.active/resolve` returning a stub oauth credential,
  so the `http.request` hook runs end-to-end.

Minimum checks:

- server hook order: `model.request:zai-coding-plan`, `model.request:zcode-start`,
  `integration.transform`, `model.request:zai-start-plan`,
  `http.request:zai-start-plan`, `http.response` ×3, `provider.transform`;
- provider ops: `update:zai-coding-plan` (models untouched, package rewritten
  to `aisdk:@ai-sdk/anthropic`) + `add:zai-start-plan`;
- system reshape: exactly 3 blocks, `ignoreAbove` text at the start of block
  3, `ephemeral` cache markers on blocks 2–3, leading date user-turn present;
- 3008/3009 responses rewrite to status 429 + `rate_limit_error` + `retry-after`;
- TUI part: both slash commands registered, dialogs under `context.ui.dialog`,
  captcha link appears in the dialog and a POST to `/proof` completes the flow;
- `setup` returns a cleanup function (both parts);
- `grep -P "[\x{0400}-\x{04FF}]"` over the repo finds nothing.

## Background material

Verified core mechanics (hook triggers and filters, provider editor, models.dev
merge order, npm/git install pipeline, V1→V2 config normalization) are
documented in `docs/opencode-plugins-research.md` of the parent working
project (not shipped in this repo); the fork sources (v2.2.5) live there under
`opencode/`. Consult them before changing anything that touches the host API.

## Release

- `package.json` version bumps on any behavior change.
- npm: `npm publish` (the `files` whitelist applies). git: push all repo
  files, then `opencode plugin add github:D00Movenok/ZCodeBenefitsToOpenCode`.
- A plain git spec tracks the default branch (update checks every 24 h); only
  a full 40-hex commit SHA pin is immutable.
- `APP_VERSION` is the impersonated desktop client version — bump it only
  when the gateway starts expecting a newer client, and check the frozen
  stealth UA literal separately.
