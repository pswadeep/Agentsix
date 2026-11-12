# Multi-Agent Council (n8n)

One master agent plans the work, five worker agents execute it in parallel, the master combines the results, a reviewer checks them. Prompts come in from **Telegram** or a **localhost page**; answers go back to both.

Full design, diagram and strategy: `docs/Multi-Agent-Council-Architecture.pdf`.

| Role | Agent |
|---|---|
| Master (plan + combine) | Claude A, standby Claude B |
| research / quick | Gemini A / Gemini B |
| code / writing | ChatGPT A / ChatGPT B |
| analysis, reviewer | Claude B |

## About the keys
n8n calls the **APIs**, so each slot needs an API key, not a chat-app login. Gemini has a free API tier (AI Studio). OpenAI and Anthropic APIs are billed separately from ChatGPT / Claude plans and have no general free tier. Any agent without a key is skipped automatically; with only the two Gemini keys, set `MASTER_CHAIN=gemini_a,gemini_b` and `REVIEWER_AGENT=gemini_b`.

## Run it
```bash
cp .env.example .env          # set WEBHOOK_SECRET (openssl rand -hex 24), keys, TELEGRAM_BOT_TOKEN
docker compose up -d
```
1. Open http://localhost:5678, create the n8n owner account.
2. Import the workflow, then restart n8n:
   `docker compose exec n8n n8n import:workflow --input=/import/multi-agent-orchestrator.json && docker compose restart n8n`
   (or Workflows → Import from file).
3. Open the workflow and switch it **Active**.
4. Message your bot. It replies with your chat id → put it in `TELEGRAM_ALLOWED_CHAT_IDS` in `.env` → `docker compose up -d`.
5. Telegram `/agents` shows which agents are ready. Send a prompt, or use http://localhost:8080.

## Run it from GitHub Actions instead
A Telegram message can also trigger a GitHub Actions pipeline that runs the same council and replies in the chat: `.github/workflows/telegram-council.yml` + a small relay in `relay/`. Setup in `docs/GITHUB-ACTIONS.md`. A bot can feed only one consumer, so use a second bot or stop the n8n workflow.

## Files
- `workflows/multi-agent-orchestrator.json` — import this (generated from `workflows/src/`)
- `web/` — localhost console (`server.js`, `index.html`; no dependencies)
- `scripts/build_workflow.js` — rebuild the JSON after editing `workflows/src/*.js`
- `scripts/council_cli.js`, `.github/workflows/`, `relay/`, `optional/` — GitHub Actions pipeline (see above)
- `requirements.txt` — Python deps (only `reportlab`, to rebuild the PDF: `pip install -r requirements.txt`)
- `tests/run_nodes.js`, `tests/run_cli.js` — offline tests (`node tests/run_nodes.js`, Node 18+)

## Tuning
Everything is in `.env`: models, role routing (`ROLE_*`, `MASTER_CHAIN`), `REVIEW_ENABLED`, token limits, `DISABLED_AGENTS`.

Successful executions are not stored (the 5 s Telegram poller would create ~17k a day). To debug, enable *Save successful executions* in the workflow settings.

## Not verified here
Tested against mock APIs and in a real n8n 2.35.7 instance. Not exercised: the real vendor endpoints, the Docker Compose stack, a real Telegram bot. Start with `/agents` and a "hello" prompt.
