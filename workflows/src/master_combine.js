// MASTER — stage 2: merge all worker outputs into one answer.
const out = [];
for (const item of $input.all()) {
  const job = { ...item.json };
  if (job.failed || job.final !== undefined || !job.results) { out.push({ json: job }); continue; }

  const blocks = job.results.map((x) =>
    '### [' + x.id + ' · ' + x.role + (x.agent ? ' · ' + x.agent : '') + '] ' + x.title + '\n' +
    (x.ok ? clip(x.text, 12000) : '(no result: ' + x.error + ')')
  ).join('\n\n');

  const system =
    'You are MASTER. Your worker agents have finished their tasks. Merge their results into ONE final answer for the user. ' +
    'Resolve contradictions (prefer well-supported claims and say when something is uncertain), remove duplication, keep the best parts, ' +
    'and make the answer directly responsive to the user\'s request. Do not mention workers, agents, task ids or this process unless the user asked. ' +
    'Reply in the user\'s language. Output only the final answer.';
  const prompt =
    'User request:\n' + clip(job.prompt, 6000) +
    '\n\nYour plan: ' + (job.plan.summary || '(none)') +
    '\nHow to combine: ' + (job.plan.combine || 'merge into a clear, complete answer') +
    '\n\nWorker results:\n' + blocks;

  const r = await callChain(MASTER_CHAIN, { system, prompt, maxTokens: Number(ENV('COMBINE_MAX_TOKENS', '3500')) });
  if (r.ok) {
    job.final = r.text;
    job.trace.combiner = r.agent;
  } else {
    // degrade gracefully: hand over the raw worker outputs
    job.trace.degraded = true;
    job.final = job.results.filter((x) => x.ok).map((x) => '## ' + x.title + '\n' + x.text).join('\n\n');
  }
  out.push({ json: job });
}
return out;
