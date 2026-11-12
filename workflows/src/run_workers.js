// WORKERS — run every task from the master's plan in parallel; each task has its own failover chain.
const out = [];
for (const item of $input.all()) {
  const job = { ...item.json };
  if (job.failed || job.final !== undefined || !job.plan) { out.push({ json: job }); continue; }

  const maxTokens = Number(ENV('WORKER_MAX_TOKENS', '3000'));
  const results = await Promise.all(job.plan.tasks.map(async (t) => {
    const system =
      'You are a specialist worker agent in a multi-agent team. Your role: ' + t.role + ' (' + ROLE_INFO[t.role] + '). ' +
      'Complete ONLY the assigned task. Be accurate, complete and concise; no preamble and no meta-commentary. ' +
      'If something is uncertain, say so. Reply in the user\'s language.';
    const prompt =
      'Original user request (context only):\n' + clip(job.prompt, 6000) +
      '\n\nYour task — ' + t.title + ':\n' + t.instruction;
    const t0 = Date.now();
    const r = await callChain(chainFor(t.role), { system, prompt, maxTokens });
    return {
      id: t.id, role: t.role, title: t.title, ok: r.ok,
      agent: r.ok ? r.agent : null,
      text: r.ok ? r.text : '',
      error: r.ok ? '' : r.error,
      fallback: r.ok && r.tried.length > 1,
      ms: Date.now() - t0,
    };
  }));

  job.results = results;
  job.trace.workers = results.map((x) => ({ id: x.id, role: x.role, agent: x.agent, ok: x.ok, fallback: !!x.fallback }));
  if (!results.some((x) => x.ok)) {
    job.failed = 'All worker agents failed — ' + results.map((x) => x.role + ': ' + x.error).join(' | ');
  }
  out.push({ json: job });
}
return out;
