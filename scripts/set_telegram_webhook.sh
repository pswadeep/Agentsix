#!/usr/bin/env bash
# Points your Telegram bot at the relay.
#   TELEGRAM_BOT_TOKEN=... RELAY_URL=https://telegram-council-relay.<you>.workers.dev \
#   TELEGRAM_WEBHOOK_SECRET=... ./scripts/set_telegram_webhook.sh
# Add --delete to remove the webhook (needed if you switch to the polling workflow).
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
api="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

if [[ "${1:-}" == "--delete" ]]; then
  curl -sS "${api}/deleteWebhook" | sed -E 's/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/[redacted]/g'
  echo
  exit 0
fi

: "${RELAY_URL:?set RELAY_URL}"
: "${TELEGRAM_WEBHOOK_SECRET:?set TELEGRAM_WEBHOOK_SECRET}"

curl -sS "${api}/setWebhook" \
  --data-urlencode "url=${RELAY_URL}" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]' \
  --data-urlencode "drop_pending_updates=true" | sed -E 's/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/[redacted]/g'
echo
curl -sS "${api}/getWebhookInfo" | sed -E 's/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/[redacted]/g'
echo
