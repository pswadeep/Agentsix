# Telegram → GitHub Actions → Telegram

A Telegram message becomes the prompt. A GitHub Actions run executes the council (master plans, workers run in parallel, master combines, reviewer checks) and the answer is sent back to the same chat, as a reply to your message.

```
Telegram ──webhook──▶ relay (Cloudflare Worker) ──repository_dispatch──▶ GitHub Actions
   ▲                                                                       .github/workflows/telegram-council.yml
   └───────────────────── sendMessage (reply) ◀── scripts/council_cli.js ◀──┘
```

Why a relay: Telegram can only POST its own fixed JSON to a URL, and GitHub's API needs an `Authorization` header and an `event_type` field. Nothing in between means nothing can call GitHub. The relay is ~60 lines, checks the sender, and holds the GitHub token.

Don't want to host anything? Use the polling variant (end of this page).

## Setup

**1. Repository.** Push this project to a GitHub repository, **private** if you can. Run logs and workflow inputs of a public repository are public. The CLI never prints prompts or answers, but a private repo is still the safer default. The workflow must be on the repository's **default branch**: `repository_dispatch` only runs the default-branch version.

**2. Repository secrets** (Settings → Secrets and variables → Actions → Secrets):

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TELEGRAM_ALLOWED_CHAT_IDS` | your chat id(s), comma-separated (message @userinfobot to see yours). **Required**: an empty list makes the pipeline refuse to run |
| `ANTHROPIC_API_KEY_A/_B`, `OPENAI_API_KEY_A/_B`, `GEMINI_API_KEY_A/_B` | whichever keys you have; missing ones are skipped |

Optional **variables** (same page, Variables tab): `MASTER_CHAIN`, `REVIEWER_AGENT`, `REVIEW_ENABLED`, `DISABLED_AGENTS`, `ROLE_*`, `*_MODEL`. Blank means the default from `.env.example`. With only Gemini keys, set `MASTER_CHAIN=gemini_a,gemini_b` and `REVIEWER_AGENT=gemini_b`.

**3. Test without Telegram triggers.** Actions → *Telegram Council* → *Run workflow*, enter a prompt and your chat id. The answer should arrive in Telegram. Send `/agents` as the prompt to see which keys the run can see.

**4. Deploy the relay** (needs a free Cloudflare account; Node on your computer):

```bash
cd relay
npx wrangler login
npx wrangler deploy                      # prints https://telegram-council-relay.<you>.workers.dev
openssl rand -hex 24                     # → use as TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_ALLOWED_CHAT_IDS
npx wrangler secret put GITHUB_REPO      # owner/name
npx wrangler secret put GITHUB_TOKEN     # see below
npx wrangler secret put TELEGRAM_BOT_TOKEN   # optional: lets the relay tell you if GitHub refuses
```

`GITHUB_TOKEN` here is a **fine-grained personal access token**: only this one repository, permission **Contents: Read and write** (GitHub requires it for `POST /repos/{owner}/{repo}/dispatches`). Nothing else.

**5. Point the bot at the relay:**

```bash
TELEGRAM_BOT_TOKEN=... RELAY_URL=https://telegram-council-relay.<you>.workers.dev \
TELEGRAM_WEBHOOK_SECRET=... ./scripts/set_telegram_webhook.sh
```

Send your bot a message. The first reply ("Pipeline started") comes once the runner has booted, then the answer follows.

## Behaviour

- Only chat ids in the allow-list are served, checked twice (relay and pipeline). Everyone else gets no reply and spends nothing.
- Each message is its own run; runs never cancel each other. Long answers are split into Telegram-sized chunks. The first chunk replies to your message.
- `/help` and `/agents` are answered without calling any AI. Other `/commands` get "Unknown command".
- Agent failover works as in n8n (429 → next agent, bad key → skipped for the run). Cooldowns only last for the current run, because every run is a fresh process.
- If the run fails before it can answer, an extra step tells you in Telegram, with a link to the run. Failures the pipeline already reported to you don't produce a second message.
- The prompt reaches the script only as an environment variable, never pasted into a shell command, so message text can't inject commands into the workflow.
- Time-out: 10 minutes per run.

## One bot, one consumer

A Telegram bot can deliver updates to **one** place: a webhook or `getUpdates` polling. The n8n workflow polls, so it and this relay cannot share a bot. Create a second bot in @BotFather for GitHub, or deactivate the n8n workflow first. Switching back: `./scripts/set_telegram_webhook.sh --delete`.

## Polling variant (no relay, slower)

Copy `optional/telegram-poll.yml` to `.github/workflows/`, skip steps 4 and 5 (and make sure no webhook is set). GitHub starts it every 5 minutes at the earliest and often later, so expect replies after several minutes. Each run reads pending messages, confirms them, and answers each one. Scheduled workflows in public repositories get switched off after a period without repository activity (60 days, per GitHub's usual behaviour; not re-checked here).

## Cost

Public repositories run on GitHub-hosted runners for free. Private repositories use your plan's included Actions minutes; check your plan's allowance on GitHub's billing page. A run is dominated by the AI calls (typically well under a minute of runner time for a simple prompt), and the polling variant wakes up every 5 minutes even when nobody wrote.

## Tests

```bash
node tests/run_cli.js     # 19 tests: CLI run/fail/poll against mock Telegram + AI APIs, relay worker
node tests/run_nodes.js   # 18 tests: the shared agent logic (also used by n8n)
```

Not exercised here: a real GitHub runner, a real Cloudflare deployment, a live Telegram bot and the live AI vendor APIs. The first live check is step 3 above.
