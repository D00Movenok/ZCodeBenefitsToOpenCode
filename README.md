# ZCodeBenefitsToOpenCode

> ⚠️ Be careful, completely vibe-coded ⚠️
>
> (but manually verified)

An opencode plugin that runs the `zai-start-plan` and `zai-coding-plan`
providers through the ZCode desktop gateway (`zcode.z.ai`) — decrease token usage,
allow to use free tokens from Start Plan and claim free Gift tokens.

## What it does

- 0.67× token consumption coefficient (gateway metering instead of 1:1 API billing)
- Uses the Start Plan subscription
- Notifications about available gifts (free tokens)
- Manual gift verification and claiming via `/zai-check-gift` and `/zai-claim-gift`
- Display usage limits (for both Coding and Start Plans)

## Install and setup

1. Install the plugin:

    ```sh
    opencode plugin add github:D00Movenok/ZCodeBenefitsToOpenCode
    ```

2. Login to Z.ai with OAuth (for starting plan)

    ```text
    opencode auth login → **Z.AI Start Plan** → z.ai OAuth
    ```

## Usage

### Decrease token usage

Applied automatically when plugin is installed

### Gifts

- `/zai-check-gift` - Check available gifts
- `/zai-claim-gift` - Manually claim available gifts (if captcha is required, the dialog shows a verification link; the claim retries automatically after you solve it)

To use claimed gift tokens select models from `Z.AI Start Plan`

## How it works — the bypass techniques

- Using the zcode gateway gives the **0.67×** token coefficient for the coding plan.
- Using the zcode  gateway + an OAuth JWT token + a mimicked ZCode system prompt (identity blocks for the gateway waf bypass, an ignore-line for the model) unlocks the Start Plan — its lane and model catalog.
- ZCode headers are added and opencode headers/UA are removed from the request (stealth, useless btw.).
- If the gateway demands Aliyun captcha verification (`client/configs`), the plugin gives you a verification link to solve it manually (for now, will try to automate it later).
