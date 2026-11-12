// DELIVER — reply on Telegram (when the prompt came from Telegram, or when mirroring is on)
// and publish every result to the localhost page's feed.
const chunk = (s, n = 3800) => {
  const parts = [];
  let rest = String(s);
  while (rest.length > n) {
    let cut = rest.lastIndexOf('\n\n', n);
    if (cut < n * 0.5) cut = rest.lastIndexOf('\n', n);
    if (cut < n * 0.5) cut = n;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
};

const token = ENV('TELEGRAM_BOT_TOKEN');
const TG = ENV('TELEGRAM_API_BASE', 'https://api.telegram.org') + '/bot' + token;
const sendTelegram = async (chat_id, text) => {
  let ok = true;
  for (const part of chunk(text)) {
    try {
      const r = await http({
        method: 'POST', url: TG + '/sendMessage', json: true, returnFullResponse: true,
        ignoreHttpStatusErrors: true, timeout: 20000,
        body: { chat_id, text: part, link_preview_options: { is_disabled: true } },
      });
      if (Number(r.statusCode) >= 400) ok = false;
    } catch (e) { ok = false; }
  }
  return ok;
};

const out = [];
for (const item of $input.all()) {
  const job = item.json;
  const failed = !!job.failed;
  const answer = failed ? '⚠️ ' + scrub(job.failed) : String(job.final || '(empty answer)');
  const ms = Date.now() - (job.startedAt || Date.now());
  const trace = { ...(job.trace || {}), ms };
  const delivered = { telegram: false, web: false };

  // localhost page feed
  try {
    const r = await http({
      method: 'POST', url: ENV('WEB_PUBLISH_URL', 'http://web:8080/api/publish'), json: true,
      returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 10000,
      headers: { 'x-webhook-secret': ENV('WEBHOOK_SECRET') },
      body: { jobId: job.jobId, source: job.source, prompt: job.prompt, answer, ok: !failed, trace, ts: Date.now() },
    });
    delivered.web = Number(r.statusCode) < 400;
  } catch (e) { delivered.web = false; }

  // Telegram
  if (token) {
    const owner = csv(ENV('TELEGRAM_ALLOWED_CHAT_IDS'))[0];
    const footer = failed ? '' : '\n\n— ' + traceLine(trace) + ' (' + (ms / 1000).toFixed(1) + 's)';
    if (job.source === 'telegram' && job.chatId) {
      delivered.telegram = await sendTelegram(job.chatId, answer + footer);
    } else if (job.source === 'web' && owner && ENV('MIRROR_WEB_TO_TELEGRAM', 'true').toLowerCase() !== 'false') {
      delivered.telegram = await sendTelegram(owner, '🌐 From localhost: ' + clip(job.prompt, 300) + '\n\n' + answer + footer);
    }
  }
  out.push({ json: { jobId: job.jobId, source: job.source, ok: !failed, delivered, ms } });
}
return out;
