// Offline test: runs the real Code-node sources (lib.js + node logic) against mock APIs and the real web server.
// node tests/run_nodes.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { createMock } = require('./mock-services');

const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'workflows', 'src', f), 'utf8');
const LIB = src('lib.js');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const MOCK_PORT = 4010, WEB_PORT = 4011;
const BASE = 'http://127.0.0.1:' + MOCK_PORT;
const FULL_ENV = {
  ANTHROPIC_API_KEY_A: 'key-claude-a', ANTHROPIC_API_KEY_B: 'key-claude-b',
  OPENAI_API_KEY_A: 'key-chatgpt-a', OPENAI_API_KEY_B: 'key-chatgpt-b',
  GEMINI_API_KEY_A: 'key-gemini-a', GEMINI_API_KEY_B: 'key-gemini-b',
  ANTHROPIC_BASE_URL: BASE, OPENAI_BASE_URL: BASE + '/v1', GEMINI_BASE_URL: BASE + '/v1beta',
  TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_API_BASE: BASE, TELEGRAM_ALLOWED_CHAT_IDS: '111',
  WEBHOOK_SECRET: 'sekret', WEB_PUBLISH_URL: 'http://127.0.0.1:' + WEB_PORT + '/api/publish',
};

// stand-in for n8n's this.helpers.httpRequest
const httpRequest = async (o) => {
  const init = { method: o.method || 'GET', headers: { ...(o.headers || {}) } };
  if (o.body !== undefined && o.method !== 'GET') { init.body = JSON.stringify(o.body); init.headers['content-type'] = init.headers['content-type'] || 'application/json'; }
  if (o.timeout) init.signal = AbortSignal.timeout(o.timeout);
  const r = await fetch(o.url, init);
  const text = await r.text();
  let body = text; try { body = JSON.parse(text); } catch (e) { /* keep text */ }
  if (r.status >= 400 && !o.ignoreHttpStatusErrors) { const e = new Error('Request failed with status code ' + r.status); e.httpCode = String(r.status); throw e; }
  return o.returnFullResponse ? { statusCode: r.status, body, headers: Object.fromEntries(r.headers) } : body;
};

const staticData = {};
async function runNode(file, items, env) {
  const code = LIB + '\n' + src(file);
  const fn = new AsyncFunction('$env', '$input', '$getWorkflowStaticData', code);
  const ctx = { helpers: { httpRequest } };
  const res = await fn.call(ctx, env, { all: () => items.map((j) => ({ json: j })) }, () => staticData);
  return (res || []).map((x) => x.json);
}
async function pipeline(job, env) {
  let items = [job];
  for (const f of ['master_plan.js', 'run_workers.js', 'master_combine.js', 'review.js', 'deliver.js']) items = await runNode(f, items, env);
  return items[0];
}
async function stages(job, env, upTo) { // run pipeline but return the job state after `upTo`
  let items = [job];
  for (const f of ['master_plan.js', 'run_workers.js', 'master_combine.js', 'review.js']) { items = await runNode(f, items, env); if (f === upTo) break; }
  return items[0];
}

const api = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());
const feed = () => fetch('http://127.0.0.1:' + WEB_PORT + '/api/feed').then((r) => r.json()).then((j) => j.items);

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await api('/__test/reset'); Object.keys(staticData).forEach((k) => delete staticData[k]); await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message.split('\n')[0]); }
};

(async () => {
  const { server } = createMock();
  await new Promise((r) => server.listen(MOCK_PORT, '127.0.0.1', r));
  const feedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feed-')), 'feed.json');
  const web = spawn('node', [path.join(root, 'web', 'server.js')], {
    env: { ...process.env, PORT: String(WEB_PORT), HOST: '127.0.0.1', WEBHOOK_SECRET: 'sekret', FEED_FILE: feedFile, N8N_WEBHOOK_URL: BASE + '/webhook/agents-prompt' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) { try { await fetch('http://127.0.0.1:' + WEB_PORT + '/healthz'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }

  console.log('Code-node logic against mock APIs');

  await t('telegram: strangers ignored, owner acked, job emitted', async () => {
    await api('/__test/enqueue', { chat_id: 999, text: 'let me in' });
    await api('/__test/enqueue', { chat_id: 111, text: 'Explain DNS' });
    const out = await runNode('poll_telegram.js', [{}], FULL_ENV);
    assert.strictEqual(out.length, 1); assert.strictEqual(out[0].chatId, '111'); assert.strictEqual(out[0].source, 'telegram');
    const sent = await get('/__test/sent');
    assert.ok(sent.every((m) => m.chat_id === '111'), 'stranger got a reply');
    assert.ok(sent.some((m) => /planning/.test(m.text)));
    const again = await runNode('poll_telegram.js', [{}], FULL_ENV);   // offset advanced → no duplicates
    assert.strictEqual(again.length, 0);
  });

  await t('telegram: setup mode reveals chat id when allow-list empty', async () => {
    await api('/__test/enqueue', { chat_id: 555, text: 'hi' });
    const out = await runNode('poll_telegram.js', [{}], { ...FULL_ENV, TELEGRAM_ALLOWED_CHAT_IDS: '' });
    assert.strictEqual(out.length, 0);
    assert.ok((await get('/__test/sent')).some((m) => m.chat_id === '555' && /555/.test(m.text)));
  });

  await t('telegram: /agents lists all six agents', async () => {
    await api('/__test/enqueue', { chat_id: 111, text: '/agents' });
    await runNode('poll_telegram.js', [{}], FULL_ENV);
    const m = (await get('/__test/sent')).pop().text;
    for (const n of ['Claude A', 'Claude B', 'ChatGPT A', 'ChatGPT B', 'Gemini A', 'Gemini B']) assert.ok(m.includes(n), n);
  });

  await t('simple prompt: master answers directly, no workers called', async () => {
    const r = await pipeline({ jobId: 'j1', source: 'telegram', prompt: 'hello', chatId: '111', startedAt: Date.now() }, FULL_ENV);
    assert.ok(r.delivered.telegram && r.delivered.web);
    const calls = await get('/__test/calls');
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].agent, 'claude_a');
    assert.ok((await get('/__test/sent')).some((m) => /council is online/.test(m.text)));
  });

  await t('delegate: plan → 3 parallel workers → combine → review → deliver', async () => {
    const job = await stages({ jobId: 'j2', source: 'telegram', prompt: 'Explain DNS', chatId: '111', startedAt: Date.now() }, FULL_ENV, 'review.js');
    assert.deepStrictEqual(job.trace.workers.map((w) => w.agent), ['gemini_a', 'chatgpt_a', 'chatgpt_b']);
    assert.strictEqual(job.trace.master, 'claude_a'); assert.strictEqual(job.trace.reviewer, 'claude_b');
    assert.ok(/merged 3 worker results by claude_a/.test(job.final)); assert.ok(/\[reviewed by claude_b\]/.test(job.final));
    const d = (await runNode('deliver.js', [job], FULL_ENV))[0];
    assert.ok(d.delivered.telegram && d.delivered.web);
    const f = (await feed()).find((e) => e.jobId === 'j2');
    assert.strictEqual(f.status, 'done'); assert.strictEqual(f.source, 'telegram'); assert.ok(f.trace.workers.length === 3);
  });

  await t('worker failover: gemini_a 429 → gemini_b serves research; cooldown skips gemini_a next time', async () => {
    await api('/__test/fail', { agents: ['gemini_a'], status: 429 });
    const job = await stages({ jobId: 'j3', source: 'web', prompt: 'Explain DNS', startedAt: Date.now() }, FULL_ENV, 'review.js');
    const research = job.trace.workers.find((w) => w.role === 'research');
    assert.strictEqual(research.agent, 'gemini_b'); assert.ok(research.fallback);
    const before = (await get('/__test/calls')).filter((c) => c.agent === 'gemini_a').length;
    await stages({ jobId: 'j3b', source: 'web', prompt: 'Explain DNS again', startedAt: Date.now() }, FULL_ENV, 'review.js');
    const after = (await get('/__test/calls')).filter((c) => c.agent === 'gemini_a').length;
    assert.strictEqual(after, before, 'gemini_a should be in cooldown');
  });

  await t('master failover: claude_a 500 → claude_b plans and combines', async () => {
    await api('/__test/fail', { agents: ['claude_a'], status: 500 });
    const job = await stages({ jobId: 'j4', source: 'web', prompt: 'Explain DNS', startedAt: Date.now() }, FULL_ENV, 'review.js');
    assert.strictEqual(job.trace.master, 'claude_b'); assert.ok(/by claude_b/.test(job.final));
  });

  await t('whole vendor down: both Gemini keys fail → research served by next in chain', async () => {
    await api('/__test/fail', { agents: ['gemini_a', 'gemini_b'], status: 503 });
    const job = await stages({ jobId: 'j5', source: 'web', prompt: 'Explain DNS', startedAt: Date.now() }, FULL_ENV, 'review.js');
    assert.strictEqual(job.trace.workers.find((w) => w.role === 'research').agent, 'claude_b');
    assert.ok(!job.failed);
  });

  await t('subset of keys: only Gemini A + B configured → everything still answers', async () => {
    const env = { ...FULL_ENV, ANTHROPIC_API_KEY_A: '', ANTHROPIC_API_KEY_B: '', OPENAI_API_KEY_A: '', OPENAI_API_KEY_B: '' };
    const job = await stages({ jobId: 'j6', source: 'web', prompt: 'Explain DNS', startedAt: Date.now() }, env, 'review.js');
    assert.strictEqual(job.trace.master, 'gemini_a'); assert.ok(job.trace.workers.every((w) => /^gemini_/.test(w.agent)));
  });

  await t('no keys at all: clear failure message, delivered, no crash', async () => {
    const env = { ...FULL_ENV, ANTHROPIC_API_KEY_A: '', ANTHROPIC_API_KEY_B: '', OPENAI_API_KEY_A: '', OPENAI_API_KEY_B: '', GEMINI_API_KEY_A: '', GEMINI_API_KEY_B: '' };
    const r = await pipeline({ jobId: 'j7', source: 'telegram', prompt: 'Explain DNS', chatId: '111', startedAt: Date.now() }, env);
    assert.strictEqual(r.ok, false);
    assert.ok((await get('/__test/sent')).some((m) => /no agent has an API key/.test(m.text)));
  });

  await t('error text never leaks an API key', async () => {
    const env = { ...FULL_ENV, ANTHROPIC_API_KEY_A: 'bad-key', ANTHROPIC_API_KEY_B: '', OPENAI_API_KEY_A: '', OPENAI_API_KEY_B: '', GEMINI_API_KEY_A: '', GEMINI_API_KEY_B: '' };
    await pipeline({ jobId: 'j8', source: 'web', prompt: 'Explain DNS', startedAt: Date.now() }, env);
    const f = (await feed()).find((e) => e.jobId === 'j8');
    assert.strictEqual(f.status, 'failed'); assert.ok(!/LEAKEDKEY/.test(f.answer)); assert.ok(/redacted/.test(f.answer));
  });

  await t('malformed plan JSON from master → falls back to a single worker, no raw JSON shown', async () => {
    const job = await stages({ jobId: 'j9', source: 'web', prompt: 'MALFORMED please', startedAt: Date.now() }, FULL_ENV, 'review.js');
    assert.strictEqual(job.plan.tasks.length, 1); assert.ok(!/^\s*\{/.test(job.final));
  });

  await t('all combiners fail → degrades to raw worker output instead of failing', async () => {
    const job = await stages({ jobId: 'j10', source: 'web', prompt: 'Explain DNS', startedAt: Date.now() }, { ...FULL_ENV, MASTER_CHAIN: 'claude_a' }, 'master_plan.js');
    await api('/__test/fail', { agents: ['claude_a'], status: 500 });
    let items = await runNode('run_workers.js', [job], FULL_ENV);
    items = await runNode('master_combine.js', items, { ...FULL_ENV, MASTER_CHAIN: 'claude_a' });
    assert.ok(items[0].trace.degraded); assert.ok(/WORKER OUTPUT/.test(items[0].final));
  });

  await t('web request validation: secret and prompt', async () => {
    const good = (await runNode('validate_web.js', [{ headers: { 'x-webhook-secret': 'sekret' }, body: { jobId: 'w1', prompt: ' hi ' } }], FULL_ENV))[0];
    const bad = (await runNode('validate_web.js', [{ headers: { 'x-webhook-secret': 'nope' }, body: { prompt: 'hi' } }], FULL_ENV))[0];
    const empty = (await runNode('validate_web.js', [{ headers: { 'x-webhook-secret': 'sekret' }, body: { prompt: '  ' } }], FULL_ENV))[0];
    assert.ok(good.valid && good.prompt === 'hi'); assert.ok(!bad.valid && bad.reason === 'unauthorised'); assert.ok(!empty.valid && empty.reason === 'empty prompt');
  });

  await t('long answer is split into Telegram-sized chunks', async () => {
    const long = ('Paragraph of text. '.repeat(40) + '\n\n').repeat(12);
    await runNode('deliver.js', [{ jobId: 'j11', source: 'telegram', prompt: 'x', chatId: '111', final: long, trace: {}, startedAt: Date.now() }], FULL_ENV);
    const sent = (await get('/__test/sent')).filter((m) => m.chat_id === '111');
    assert.ok(sent.length >= 3 && sent.every((m) => m.text.length <= 4096));
  });

  console.log('\nLocalhost web server');

  await t('POST /api/ask forwards to n8n with the secret and records a pending item', async () => {
    const r = await fetch('http://127.0.0.1:' + WEB_PORT + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'from the page' }) });
    assert.strictEqual(r.status, 202); const { jobId } = await r.json();
    const hook = await get('/__test/webhook');
    assert.strictEqual(hook[0].headers['x-webhook-secret'], 'sekret'); assert.strictEqual(hook[0].body.jobId, jobId);
    assert.strictEqual((await feed()).find((e) => e.jobId === jobId).status, 'pending');
    // round trip: n8n side finishes the job → feed shows it and Telegram mirror fires
    const done = await pipeline({ jobId, source: 'web', prompt: 'hello', startedAt: Date.now() }, FULL_ENV);
    assert.ok(done.delivered.web && done.delivered.telegram);
    assert.strictEqual((await feed()).find((e) => e.jobId === jobId).status, 'done');
    assert.ok((await get('/__test/sent')).some((m) => m.chat_id === '111' && /From localhost/.test(m.text)));
  });

  await t('POST /api/publish rejects a wrong secret; /api/ask rejects empty prompt', async () => {
    const p = await fetch('http://127.0.0.1:' + WEB_PORT + '/api/publish', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'wrong' }, body: JSON.stringify({ jobId: 'x', answer: 'pwn' }) });
    assert.strictEqual(p.status, 401);
    const a = await fetch('http://127.0.0.1:' + WEB_PORT + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '   ' }) });
    assert.strictEqual(a.status, 400);
  });

  await t('MIRROR_WEB_TO_TELEGRAM=false keeps web answers off Telegram', async () => {
    await pipeline({ jobId: 'j12', source: 'web', prompt: 'hello', startedAt: Date.now() }, { ...FULL_ENV, MIRROR_WEB_TO_TELEGRAM: 'false' });
    assert.strictEqual((await get('/__test/sent')).length, 0);
  });

  web.kill(); server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
