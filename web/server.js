// Localhost console for the multi-agent council. Zero dependencies (Node 18+).
//   GET  /               the page
//   GET  /api/feed       all exchanges (web + telegram), newest last
//   POST /api/ask        {prompt}  → forwards to the n8n webhook, returns {jobId}
//   POST /api/publish    called by n8n with the finished answer (needs x-webhook-secret)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const N8N_URL = process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/agents-prompt';
const SECRET = process.env.WEBHOOK_SECRET || '';
const DATA_FILE = process.env.FEED_FILE || path.join(__dirname, 'data', 'feed.json');
const MAX_ITEMS = 200;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 200 * 1024;

if (!SECRET) {
  console.error('WEBHOOK_SECRET is not set. Generate one (openssl rand -hex 24) and put it in .env.');
  process.exit(1);
}

let feed = [];
try { feed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { feed = []; }
let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(feed.slice(-MAX_ITEMS)));
    } catch (e) { /* history is a nicety, never fatal */ }
  }, 300);
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('invalid JSON')); }
  });
  req.on('error', reject);
});
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const upsert = (entry) => {
  const i = feed.findIndex((e) => e.jobId === entry.jobId);
  if (i >= 0) feed[i] = { ...feed[i], ...entry };
  else feed.push(entry);
  if (feed.length > MAX_ITEMS) feed = feed.slice(-MAX_ITEMS);
  save();
};

const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/api/feed') {
      const now = Date.now();
      const items = feed.map((e) =>
        e.status === 'pending' && now - e.ts > PENDING_TTL_MS
          ? { ...e, status: 'failed', answer: 'No reply received. Check that the n8n workflow is active and the API keys are set.' }
          : e
      );
      return send(res, 200, { items, now });
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const body = await readBody(req);
      const prompt = String(body.prompt || '').trim().slice(0, 8000);
      if (!prompt) return send(res, 400, { error: 'prompt is empty' });
      const jobId = 'web-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
      upsert({ jobId, source: 'web', prompt, status: 'pending', ts: Date.now() });
      try {
        const r = await fetch(N8N_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
          body: JSON.stringify({ jobId, prompt }),
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) {
          const detail = (await r.text()).slice(0, 300);
          const hint = r.status === 404 ? ' (is the workflow active? production webhooks only work on active workflows)' : '';
          upsert({ jobId, status: 'failed', answer: 'n8n rejected the prompt: HTTP ' + r.status + hint + ' ' + detail });
          return send(res, 502, { error: 'n8n returned ' + r.status + hint });
        }
      } catch (e) {
        upsert({ jobId, status: 'failed', answer: 'Could not reach n8n at ' + N8N_URL + ' — ' + e.message });
        return send(res, 502, { error: 'cannot reach n8n: ' + e.message });
      }
      return send(res, 202, { jobId });
    }

    if (req.method === 'POST' && url.pathname === '/api/publish') {
      if (!safeEqual(req.headers['x-webhook-secret'], SECRET)) return send(res, 401, { error: 'unauthorised' });
      const b = await readBody(req);
      if (!b.jobId) return send(res, 400, { error: 'jobId missing' });
      upsert({
        jobId: String(b.jobId),
        source: b.source === 'telegram' ? 'telegram' : 'web',
        prompt: String(b.prompt || ''),
        answer: String(b.answer || ''),
        status: b.ok === false ? 'failed' : 'done',
        trace: b.trace || null,
        ts: Number(b.ts) || Date.now(),
      });
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log('Console on http://' + HOST + ':' + PORT + '  →  n8n ' + N8N_URL));
