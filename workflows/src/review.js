// REVIEWER — final quality gate. Keeps the draft if the reviewer fails or returns something suspiciously short.
const out = [];
for (const item of $input.all()) {
  const job = { ...item.json };
  const wanted = ENV('REVIEW_ENABLED', 'true').toLowerCase() !== 'false';
  if (!wanted || job.failed || !job.final || job.trace.mode === 'direct' || job.trace.degraded || job.final.length < 300) {
    out.push({ json: job });
    continue;
  }

  const system =
    'You are REVIEWER, the final quality gate of a multi-agent team. You receive the user\'s request and a draft answer. ' +
    'Fix factual errors, contradictions, gaps and unclear wording. Keep the draft\'s structure, tone and language unless they are wrong. ' +
    'Output ONLY the final answer text — no commentary, no "here is the revised version".';
  const prompt = 'User request:\n' + clip(job.prompt, 6000) + '\n\nDraft answer:\n' + clip(job.final, 14000);

  const r = await callChain(REVIEW_CHAIN, { system, prompt, maxTokens: Number(ENV('COMBINE_MAX_TOKENS', '3500')) });
  if (r.ok && r.text.length >= job.final.length * 0.4) {
    job.final = r.text;
    job.trace.reviewer = r.agent;
  }
  out.push({ json: job });
}
return out;
