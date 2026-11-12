// Validates a prompt that arrives from the localhost page (via its server-side proxy).
const secret = ENV('WEBHOOK_SECRET');
const out = [];
for (const it of $input.all()) {
  const h = it.json.headers || {};
  const b = it.json.body || {};
  const authorised = !!secret && h['x-webhook-secret'] === secret;
  const prompt = String(b.prompt || '').trim().slice(0, 8000);
  let reason = '';
  if (!authorised) reason = 'unauthorised';
  else if (!prompt) reason = 'empty prompt';
  out.push({
    json: {
      valid: reason === '',
      reason,
      jobId: String(b.jobId || 'web-' + Date.now()).slice(0, 64),
      source: 'web',
      prompt,
      startedAt: Date.now(),
    },
  });
}
return out;
