// End-to-end test against a REAL n8n instance (no Docker needed) with mocked AI vendors and Telegram.
//   N8N_BIN=/path/to/n8n node tests/e2e.js
// Starts: mock APIs (4010), localhost console (4011), n8n (5690). Imports + publishes the generated workflow.
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const N8N_BIN = process.env.N8N_BIN || 'n8n';
const MOCK = 4010, WEB = 4011, N8N = 5690;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-e2e-'));
const feedFile = path.join(home, 'feed.json');
const logs = { n8n: '', web: '', mock: '' };
const kids = [];

const env = {
  ...process.env,
  N8N_USER_FOLDER: home, N8N_LISTEN_ADDRESS: '127.0.0.1', N8N_PORT: String(N8N),
  N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_TEMPLATES_ENABLED: 'false', N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false', N8N_RUNNERS_TASK_TIMEOUT: '900',
  WEBHOOK_SECRET: 'sekret', WEB_PUBLISH_URL: 'http://127.0.0.1:' + WEB + '/api/publish',
  TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_API_BASE: 'http://127.0.0.1:' + MOCK, TELEGRAM_ALLOWED_CHAT_IDS: '111',
  ANTHROPIC_API_KEY_A: 'key-claude-a', ANTHROPIC_API_KEY_B: 'key-claude-b',
  OPENAI_API_KEY_A: 'key-chatgpt-a', OPENAI_API_KEY_B: 'key-chatgpt-b',
  GEMINI_API_KEY_A: 'key-gemini-a', GEMINI_API_KEY_B: 'key-gemini-b',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + MOCK, OPENAI_BASE_URL: 'http://127.0.0.1:' + MOCK + '/v1',
  GEMINI_BASE_URL: 'http://127.0.0.1:' + MOCK + '/v1beta',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = (name, cmd, args, e) => {
  const p = spawn(cmd, args, { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (logs[name] += d)); p.stderr.on('data', (d) => (logs[name] += d));
  kids.push(p); return p;
};
const until = async (label, fn, ms = 120000, step = 500) => {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(step); }
  throw new Error('timeout waiting for ' + label + (last ? ' (' + last.message + ')' : ''));
};
const j = (u, o) => fetch(u, o).then((r) => r.json());
const post = (u, body, h) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...(h || {}) }, body: JSON.stringify(body || {}) });
const mock = (p, body) => post('http://127.0.0.1:' + MOCK + p, body).then((r) => r.json());
const sent = () => j('http://127.0.0.1:' + MOCK + '/__test/sent');
const calls = () => j('http://127.0.0.1:' + MOCK + '/__test/calls');
const feed = () => j('http://127.0.0.1:' + WEB + '/api/feed').then((x) => x.items);

let pass = 0;
const step = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };

async function main() {
  // 0. generated workflow must exist
  const wf = path.join(root, 'workflows', 'multi-agent-orchestrator.json');
  assert.ok(fs.existsSync(wf), 'run node scripts/build_workflow.js first');

  start('mock', 'node', [path.join(__dirname, 'mock-services.js'), String(MOCK)], process.env);
  start('web', 'node', [path.join(root, 'web', 'server.js')], { ...process.env, PORT: String(WEB), HOST: '127.0.0.1', WEBHOOK_SECRET: 'sekret', FEED_FILE: feedFile, N8N_WEBHOOK_URL: 'http://127.0.0.1:' + N8N + '/webhook/agents-prompt' });
  await until('mock + web', async () => (await fetch('http://127.0.0.1:' + WEB + '/healthz')).ok && (await sent()));

  console.log('n8n import / publish (first start runs DB migrations, this takes a while)');
  for (const args of [['import:workflow', '--input=' + wf], ['publish:workflow', '--id=MultiAgentCnl001']]) {
    const r = spawnSync(N8N_BIN, args, { env, encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0) throw new Error(args[0] + ' failed:\n' + (r.stdout || '') + (r.stderr || ''));
  }
  start('n8n', N8N_BIN, ['start'], env);
  await until('n8n workflow activation', async () => /Activated workflow/.test(logs.n8n), 180000, 1000);

  console.log('end-to-end');
  await step('webhook rejects a wrong secret (401)', async () => {
    const r = await post('http://127.0.0.1:' + N8N + '/webhook/agents-prompt', { prompt: 'x' }, { 'x-webhook-secret': 'nope' });
    assert.strictEqual(r.status, 401);
  });

  await step('Telegram prompt: plan -> 3 workers -> combine -> review -> reply + page feed', async () => {
    await mock('/__test/reset');
    await mock('/__test/enqueue', { chat_id: 111, text: 'Explain how DNS works' });
    await until('telegram reply', async () => (await sent()).some((m) => /FINAL ANSWER/.test(m.text)), 60000, 1000);
    const reply = (await sent()).find((m) => /FINAL ANSWER/.test(m.text)).text;
    assert.ok(/master claude_a/.test(reply) && /research:gemini_a/.test(reply) && /review claude_b/.test(reply), reply.slice(-200));
    const f = (await feed()).find((e) => e.source === 'telegram');
    assert.ok(f && f.status === 'done' && f.trace.workers.length === 3);
  });

  await step('localhost prompt: pipeline runs, feed updates, answer mirrored to Telegram', async () => {
    await mock('/__test/reset');
    const r = await post('http://127.0.0.1:' + WEB + '/api/ask', { prompt: 'Explain the TLS handshake' });
    assert.strictEqual(r.status, 202); const { jobId } = await r.json();
    await until('feed done', async () => (await feed()).find((e) => e.jobId === jobId && e.status === 'done'), 60000, 500);
    assert.ok((await sent()).some((m) => m.chat_id === '111' && /From localhost/.test(m.text)));
  });

  await step('failover: Gemini A returns 429 -> Gemini B serves the research task', async () => {
    await mock('/__test/reset'); await mock('/__test/fail', { agents: ['gemini_a'], status: 429 });
    const r = await post('http://127.0.0.1:' + WEB + '/api/ask', { prompt: 'Explain BGP routing' });
    const { jobId } = await r.json();
    const e = await until('feed done', async () => (await feed()).find((x) => x.jobId === jobId && x.status === 'done'), 60000, 500);
    const research = e.trace.workers.find((w) => w.role === 'research');
    assert.strictEqual(research.agent, 'gemini_b'); assert.ok(research.fallback);
  });

  await step('simple prompt is answered directly by the master (1 agent call)', async () => {
    await mock('/__test/reset');
    const r = await post('http://127.0.0.1:' + WEB + '/api/ask', { prompt: 'hello' });
    const { jobId } = await r.json();
    await until('feed done', async () => (await feed()).find((x) => x.jobId === jobId && x.status === 'done'), 60000, 500);
    assert.strictEqual((await calls()).length, 1);
  });

  assert.ok(!/Error in handler|UnhandledPromiseRejection/i.test(logs.n8n), 'n8n logged a workflow error');
  console.log('\n' + pass + ' e2e checks passed');
}

const cleanup = () => { for (const k of kids) { try { k.kill('SIGTERM'); } catch (e) { /* gone */ } } };
main().then(() => { cleanup(); setTimeout(() => process.exit(0), 500); }).catch((e) => {
  console.error('\nE2E FAILED:', e.message);
  console.error('--- n8n log (tail) ---\n' + logs.n8n.split('\n').filter((l) => !/confluence|strapi|mcp|registry/i.test(l)).slice(-40).join('\n'));
  console.error('--- web log ---\n' + logs.web.slice(-800));
  cleanup(); setTimeout(() => process.exit(1), 500);
});
