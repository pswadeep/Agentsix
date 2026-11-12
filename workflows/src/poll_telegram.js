// Polls Telegram (no public URL needed, so it works on localhost).
// Emits one item per authorised text message. Commands /start /help /agents are answered here.
const token = ENV('TELEGRAM_BOT_TOKEN');
if (!token) return [];

const TG = ENV('TELEGRAM_API_BASE', 'https://api.telegram.org') + '/bot' + token;
const tg = async (method, body) => {
  try {
    const r = await http({
      method: 'POST', url: TG + '/' + method, body: body || {}, json: true,
      returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 20000,
    });
    return r.body || {};
  } catch (e) {
    return { ok: false, description: scrub(e && e.message ? e.message : e) };
  }
};
const send = (chat_id, text) => tg('sendMessage', { chat_id, text, link_preview_options: { is_disabled: true } });

// getUpdates fails with 409 while a webhook is registered, so clear it once
if (!sd.tgInit) { await tg('deleteWebhook', { drop_pending_updates: false }); sd.tgInit = true; }

const upd = await tg('getUpdates', { offset: sd.tgOffset || 0, timeout: 0, allowed_updates: ['message'] });
if (!upd.ok) {
  if ((upd.error_code === 401 || upd.error_code === 404) && (!sd.tgErrAt || Date.now() - sd.tgErrAt > 600000)) {
    sd.tgErrAt = Date.now();
    throw new Error('Telegram rejected the bot token (check TELEGRAM_BOT_TOKEN): ' + scrub(upd.description));
  }
  return [];
}

const allowed = csv(ENV('TELEGRAM_ALLOWED_CHAT_IDS'));
const HELP =
  'Multi-agent council ready.\n\nSend any prompt. The master agent plans, worker agents run in parallel, the master combines, a reviewer checks, and the answer comes back here and on the localhost page.\n\n/agents — show which agents are ready\n/help — this message';
const items = [];
for (const u of upd.result || []) {
  sd.tgOffset = u.update_id + 1;
  const m = u.message;
  if (!m || typeof m.text !== 'string' || !m.chat) continue;
  const chatId = String(m.chat.id);

  if (allowed.length === 0) {
    await send(chatId, 'Setup mode — your chat id is ' + chatId + '.\nPut it in TELEGRAM_ALLOWED_CHAT_IDS in .env and restart n8n.');
    continue;
  }
  if (!allowed.includes(chatId)) continue; // silently ignore strangers

  const text = m.text.trim();
  if (!text) continue;
  if (/^\/(start|help)\b/i.test(text)) { await send(chatId, HELP); continue; }
  if (/^\/agents\b/i.test(text)) { await send(chatId, agentStatus()); continue; }
  if (/^\//.test(text)) { await send(chatId, 'Unknown command. Try /help'); continue; }

  await send(chatId, '⏳ Master is planning…');
  items.push({ json: { jobId: 'tg-' + u.update_id, source: 'telegram', prompt: text.slice(0, 8000), chatId, startedAt: Date.now() } });
}
return items;
