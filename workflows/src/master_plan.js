// MASTER — stage 1: decide how to answer. Either answer directly or design the worker workflow.
const roleList = Object.keys(ROLES).map((r) => '- ' + r + ': ' + ROLE_INFO[r]).join('\n');
const system =
  'You are MASTER, the orchestrator of a team of AI worker agents. Decide how to answer the user\'s request.\n\n' +
  'Worker roles you can assign:\n' + roleList + '\n\n' +
  'Return ONLY one JSON object — no prose, no markdown fences.\n' +
  'Simple request (greeting, small talk, short factual question you can fully answer yourself):\n' +
  '{"mode":"direct","answer":"<your complete answer>"}\n' +
  'Anything that benefits from specialists:\n' +
  '{"mode":"delegate","summary":"<one line on your approach>","tasks":[{"id":"t1","role":"<one of the roles>","title":"<short title>","instruction":"<self-contained instruction>"}],"combine":"<how to merge the results into the final answer>"}\n\n' +
  'Rules: 1 to 5 tasks. Tasks run in parallel and cannot see each other, so each instruction must be fully self-contained and include any context it needs. ' +
  'Use the fewest tasks that give an excellent answer. Never include secrets. Write instructions and answers in the user\'s language.';

const out = [];
for (const item of $input.all()) {
  const job = { ...item.json };
  job.trace = { master: null, mode: null, workers: [], reviewer: null, degraded: false };

  const r = await callChain(MASTER_CHAIN, { system, prompt: clip(job.prompt, 8000), maxTokens: Number(ENV('PLAN_MAX_TOKENS', '2500')) });
  if (!r.ok) {
    job.failed = 'No master agent could plan this request — ' + r.error;
    out.push({ json: job });
    continue;
  }
  job.trace.master = r.agent;

  const plan = extractJson(r.text);
  if (plan && plan.mode === 'direct' && typeof plan.answer === 'string' && plan.answer.trim()) {
    job.final = plan.answer.trim();
    job.trace.mode = 'direct';
  } else if (plan && plan.mode === 'delegate' && Array.isArray(plan.tasks)) {
    const roles = Object.keys(ROLES);
    let tasks = plan.tasks.slice(0, 5).map((t, i) => ({
      id: String((t && t.id) || 't' + (i + 1)),
      role: roles.includes(t && t.role) ? t.role : 'analysis',
      title: String((t && t.title) || 'Task ' + (i + 1)).slice(0, 80),
      instruction: String((t && t.instruction) || '').trim(),
    })).filter((t) => t.instruction);
    if (!tasks.length) tasks = [{ id: 't1', role: 'analysis', title: 'Answer the request', instruction: job.prompt }];
    job.plan = { summary: String(plan.summary || '').slice(0, 300), tasks, combine: String(plan.combine || '').slice(0, 600) };
    job.trace.mode = 'delegate';
  } else if (/^\s*[{`]/.test(r.text)) {
    // master returned malformed JSON — fall back to a single analysis worker rather than showing raw JSON
    job.plan = { summary: 'fallback single-task plan', tasks: [{ id: 't1', role: 'analysis', title: 'Answer the request', instruction: job.prompt }], combine: 'Return the worker answer, polished.' };
    job.trace.mode = 'delegate';
  } else {
    job.final = r.text; // master answered in plain text
    job.trace.mode = 'direct';
  }
  out.push({ json: job });
}
return out;
