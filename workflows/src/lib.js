// ============================ SHARED LIBRARY ============================
// Injected at the top of every Code node by scripts/build_workflow.js.
// Provides: env access, the 6-agent registry, vendor adapters (Anthropic / OpenAI / Gemini),
// role routing, failover chains and per-agent cooldowns.

const ENV = (k, d = '') => {
  try {
    const v = $env[k];
    return v === undefined || v === null || String(v).trim() === '' ? d : String(v).trim();
  } catch (e) {
    return d;
  }
};
const http = (o) => this.helpers.httpRequest(o);
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const clip = (s, n) => {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '\n…[truncated]' : s;
};
// never let a key (or a bot token) travel into a user-facing message
const scrub = (s) =>
  String(s == null ? '' : s).replace(
    /(sk-[A-Za-z0-9_\-]{6,}|AIza[0-9A-Za-z_\-]{10,}|\b\d{8,10}:[A-Za-z0-9_\-]{30,})/g,
    '[redacted]'
  );

const sd = $getWorkflowStaticData('global');
sd.cooldown = sd.cooldown || {};

// ---------------------------------------------------------------- agent registry
const AGENT_DEFS = {
  claude_a:  { vendor: 'anthropic', label: 'Claude A',  keyVar: 'ANTHROPIC_API_KEY_A', modelVar: 'CLAUDE_A_MODEL',  model: 'claude-sonnet-5-5' },
  claude_b:  { vendor: 'anthropic', label: 'Claude B',  keyVar: 'ANTHROPIC_API_KEY_B', modelVar: 'CLAUDE_B_MODEL',  model: 'claude-haiku-5-5' },
  chatgpt_a: { vendor: 'openai',    label: 'ChatGPT A', keyVar: 'OPENAI_API_KEY_A',    modelVar: 'CHATGPT_A_MODEL', model: 'gpt-6.1-terra' },
  chatgpt_b: { vendor: 'openai',    label: 'ChatGPT B', keyVar: 'OPENAI_API_KEY_B',    modelVar: 'CHATGPT_B_MODEL', model: 'gpt-6-luna' },
  gemini_a:  { vendor: 'google',    label: 'Gemini A',  keyVar: 'GEMINI_API_KEY_A',    modelVar: 'GEMINI_A_MODEL',  model: 'gemini-3.5-flash' },
  gemini_b:  { vendor: 'google',    label: 'Gemini B',  keyVar: 'GEMINI_API_KEY_B',    modelVar: 'GEMINI_B_MODEL',  model: 'gemini-3.1-flash-lite' },
};
const ALL_AGENTS = Object.keys(AGENT_DEFS);
const disabledAgents = csv(ENV('DISABLED_AGENTS'));

const ROLE_INFO = {
  research: 'broad knowledge, long-context reading, gathering and summarising information',
  quick: 'fast lightweight tasks: extraction, translation, formatting, short summaries, classification',
  code: 'programming, debugging, maths, structured data and technical precision',
  writing: 'drafting, rewriting, creative or persuasive text, alternative angles and tone',
  analysis: 'careful reasoning, critique, trade-offs, risk and edge-case analysis',
};
// primary → fallback order per role (override with ROLE_<NAME> in .env)
const ROLES = {
  research: csv(ENV('ROLE_RESEARCH', 'gemini_a,gemini_b,claude_b,chatgpt_a')),
  quick:    csv(ENV('ROLE_QUICK',    'gemini_b,gemini_a,chatgpt_b,claude_b')),
  code:     csv(ENV('ROLE_CODE',     'chatgpt_a,chatgpt_b,claude_b,gemini_a')),
  writing:  csv(ENV('ROLE_WRITING',  'chatgpt_b,chatgpt_a,gemini_a,claude_b')),
  analysis: csv(ENV('ROLE_ANALYSIS', 'claude_b,chatgpt_a,gemini_a,chatgpt_b')),
};
const MASTER_CHAIN = csv(ENV('MASTER_CHAIN', 'claude_a,claude_b,gemini_a,chatgpt_a,gemini_b,chatgpt_b'));
const REVIEW_CHAIN = [ENV('REVIEWER_AGENT', 'claude_b'), 'gemini_a', 'chatgpt_a', 'claude_a'];
const WORKER_LAST_RESORT = ['gemini_a', 'gemini_b', 'chatgpt_a', 'chatgpt_b', 'claude_b', 'claude_a'];
const chainFor = (role) => [...(ROLES[role] || ROLES.analysis), ...WORKER_LAST_RESORT];

const hasKey = (id) => !!AGENT_DEFS[id] && !!ENV(AGENT_DEFS[id].keyVar) && !disabledAgents.includes(id);
const inCooldown = (id) => !!(sd.cooldown[id] && sd.cooldown[id] > Date.now());
const cool = (id, ms) => { sd.cooldown[id] = Date.now() + ms; };

// ---------------------------------------------------------------- one call to one agent
const callAgent = async (id, { system, prompt, maxTokens = 2048 }) => {
  const d = AGENT_DEFS[id];
  const key = ENV(d.keyVar);
  const model = ENV(d.modelVar, d.model);
  const t0 = Date.now();
  let req;
  let parse;

  if (d.vendor === 'anthropic') {
    req = {
      method: 'POST',
      url: ENV('ANTHROPIC_BASE_URL', 'https://api.anthropic.com') + '/v1/messages',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] },
    };
    parse = (b) => (b.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
  } else if (d.vendor === 'openai') {
    const base = ENV('OPENAI_BASE_URL', 'https://api.openai.com/v1');
    if (ENV('OPENAI_API_MODE', 'responses') === 'chat') {
      req = {
        method: 'POST',
        url: base + '/chat/completions',
        headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_completion_tokens: maxTokens },
      };
      parse = (b) => (((b.choices || [])[0] || {}).message || {}).content || '';
    } else {
      req = {
        method: 'POST',
        url: base + '/responses',
        headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: { model, instructions: system, input: prompt, max_output_tokens: maxTokens },
      };
      parse = (b) => {
        if (typeof b.output_text === 'string' && b.output_text) return b.output_text;
        const parts = [];
        for (const o of b.output || []) {
          if (o.type !== 'message') continue;
          for (const c of o.content || []) if (c.type === 'output_text' && c.text) parts.push(c.text);
        }
        return parts.join('');
      };
    }
  } else {
    req = {
      method: 'POST',
      url: ENV('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta') + '/models/' + model + ':generateContent',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      },
    };
    parse = (b) => (((((b.candidates || [])[0] || {}).content || {}).parts) || []).map((p) => p.text || '').join('');
  }

  let res;
  try {
    res = await http({
      ...req,
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: Number(ENV('AGENT_TIMEOUT_MS', '90000')),
    });
  } catch (e) {
    cool(id, 60000);
    return { ok: false, agent: id, status: 0, error: scrub('network error: ' + (e && e.message ? e.message : e)) };
  }

  const status = Number(res.statusCode || res.status || 0);
  const body = res.body;
  if (status === 0 || status >= 400) {
    const msg = (body && body.error && (body.error.message || body.error)) || (body && body.message) ||
      (typeof body === 'string' ? body : JSON.stringify(body || {}));
    if (status === 429) cool(id, 60000);
    else if (status >= 500 || status === 0) cool(id, 30000);
    else if (status === 401 || status === 403) cool(id, 15 * 60000);
    else if (status === 404) cool(id, 10 * 60000);
    return { ok: false, agent: id, status, error: scrub('HTTP ' + status + ': ' + clip(String(msg), 240)) };
  }

  let text = '';
  try { text = parse(typeof body === 'object' && body ? body : {}); } catch (e) { text = ''; }
  text = String(text || '').trim();
  if (!text) return { ok: false, agent: id, status, error: 'empty response' };
  return { ok: true, agent: id, model, text, ms: Date.now() - t0 };
};

// ---------------------------------------------------------------- failover across a chain
const callChain = async (chain, args) => {
  const order = [...new Set(chain)].filter((id) => AGENT_DEFS[id]);
  const tried = [];
  const skipped = [];
  for (const id of order) {
    if (!hasKey(id)) continue;
    if (inCooldown(id)) { skipped.push(id); continue; }
    const r = await callAgent(id, args);
    tried.push({ agent: id, ok: r.ok, status: r.status, error: r.error });
    if (r.ok) return { ...r, tried };
  }
  for (const id of skipped) { // last resort: agents that were cooling down
    const r = await callAgent(id, args);
    tried.push({ agent: id, ok: r.ok, status: r.status, error: r.error });
    if (r.ok) return { ...r, tried };
  }
  const error = tried.length
    ? tried.map((t) => t.agent + ' → ' + t.error).join(' | ')
    : 'no agent has an API key configured (check .env)';
  return { ok: false, error: scrub(error), tried };
};

// ---------------------------------------------------------------- helpers
const extractJson = (txt) => {
  let s = String(txt || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { /* ignore */ } }
  return null;
};
const traceLine = (t) => {
  if (!t) return '';
  const p = [];
  if (t.master) p.push('master ' + t.master);
  if (t.workers && t.workers.length) p.push('workers ' + t.workers.map((w) => w.role + ':' + (w.agent || 'failed')).join(', '));
  if (t.reviewer) p.push('review ' + t.reviewer);
  return p.join(' | ');
};
const agentStatus = () =>
  ALL_AGENTS.map((id) => {
    const d = AGENT_DEFS[id];
    const state = !ENV(d.keyVar) ? 'no key' : disabledAgents.includes(id) ? 'disabled' : inCooldown(id) ? 'cooling down' : 'ready';
    const mark = state === 'ready' ? '✅' : state === 'cooling down' ? '⏸' : '❌';
    return mark + ' ' + d.label + ' (' + ENV(d.modelVar, d.model) + ') — ' + state;
  }).join('\n');
