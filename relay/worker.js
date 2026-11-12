// Telegram -> GitHub relay (Cloudflare Worker, free plan is enough).
// Telegram calls this URL for every message; it checks the sender and fires a
// repository_dispatch event, which starts .github/workflows/telegram-council.yml.
//
// Secrets (wrangler secret put <NAME>):
//   TELEGRAM_WEBHOOK_SECRET   random string, also passed to setWebhook as secret_token
//   TELEGRAM_ALLOWED_CHAT_IDS comma-separated chat ids that may use the bot
//   GITHUB_TOKEN              fine-grained PAT limited to this one repo, "Contents: Read and write"
//                             (the permission GitHub requires to create a repository_dispatch event)
//   GITHUB_REPO               owner/name, e.g. swadeep/agent-council
//   TELEGRAM_BOT_TOKEN        optional; only used to tell you when GitHub refused the dispatch

const ok = () => new Response('ok', { status: 200 });

const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

const safeEqual = (a, b) => {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

async function tell(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) { /* best effort */ }
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return ok(); // health check / browser visit

    if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response('forbidden', { status: 403 });
    }

    let update;
    try { update = await request.json(); } catch (e) { return ok(); }

    const m = update && update.message;
    if (!m || typeof m.text !== 'string' || !m.chat) return ok(); // edits, photos, joins… ignored

    const chatId = String(m.chat.id);
    if (!csv(env.TELEGRAM_ALLOWED_CHAT_IDS).includes(chatId)) return ok(); // strangers get nothing

    const prompt = m.text.trim().slice(0, 8000);
    if (!prompt) return ok();

    const res = await fetch('https://api.github.com/repos/' + env.GITHUB_REPO + '/dispatches', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.GITHUB_TOKEN,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'telegram-council-relay',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'telegram_prompt',
        client_payload: { prompt, chat_id: chatId, message_id: m.message_id, update_id: update.update_id },
      }),
    });

    if (res.status !== 204) {
      await tell(env, chatId, '⚠️ Could not start the GitHub pipeline (GitHub answered HTTP ' + res.status + '). Check GITHUB_TOKEN and GITHUB_REPO on the relay.');
    }
    // Always 200: a non-2xx makes Telegram retry the same update repeatedly.
    return ok();
  },
};
