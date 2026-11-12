#!/usr/bin/env node
// Headless runner for the council: the SAME node sources n8n uses (workflows/src/*.js), executed in plain Node.
// Used by the GitHub Actions workflows. Zero dependencies, Node 18+.
//
//   council_cli.js run    PROMPT, CHAT_ID, MESSAGE_ID, UPDATE_ID from env → plan → workers → combine → review → Telegram reply
//   council_cli.js fail   tells the chat the run failed (RUN_URL optional)
//   council_cli.js poll   reads pending Telegram messages (getUpdates), runs each, replies
//
// Privacy: prompts and answers are never written to the log (Actions logs of public repos are public).
'use strict';
const fs = require('fs');
const path = require('path');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const SRC = path.join(__dirname, '..', 'workflows', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const LIB = read('lib.js');

const env = process.env;
const clean = (k, d = '') => (env[k] && String(env[k]).trim() ? String(env[k]).trim() : d);
const TOKEN = clean('TELEGRAM_BOT_TOKEN');
const TG_BASE = clean('TELEGRAM_API_BASE', 'https://api.telegram.org');
const allowed = clean('TELEGRAM_ALLOWED_CHAT_IDS').split(',').map((s) => s.trim()).filter(Boolean);
const log = (...a) => console.log(...a);
const redact = (s) => String(s == null ? '' : s).replace(/\b\d{8,10}:[A-Za-z0-9_\-]{30,}/g, '[redacted]');

// ------------------------------------------------------------------ n8n runtime shims
const httpRequest = async (o) => {
  const init = { method: o.method || 'GET', headers: { ...(o.headers || {}) } };
  if (o.body !== undefined && init.method !== 'GET') {
    init.body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
  }
  if (o.timeout) init.signal = AbortSignal.timeout(o.timeout);
  const r = await fetch(o.url, init);
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch (e) { /* keep text */ }
  if (r.status >= 400 && !o.ignoreHttpStatusErrors) throw new Error('Request failed with status code ' + r.status);
  return o.returnFullResponse ? { statusCode: r.status, body } : body;
};
const staticData = {}; // per-process: cooldowns last for this run only
async function runCode(code, items) {
  const fn = new AsyncFunction('$env', '$input', '$getWorkflowStaticData', LIB + '\n' + code);
  const res = await fn.call({ helpers: { httpRequest } }, env, { all: () => items.map((j) => ({ json: j })) }, () => staticData);
  return (res || []).map((x) => x.json);
}
const runNode = (file, items) => runCode(read(file), items);

// ------------------------------------------------------------------ Telegram
const tg = async (method, body) => {
  try {
    const r = await fetch(TG_BASE + '/bot' + TOKEN + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(25000),
    });
    return await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
  } catch (e) {
    return { ok: false, description: redact(e.message) };
  }
};
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
async function send(chatId, text, replyTo) {
  let ok = true;
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    const body = { chat_id: chatId, text: parts[i], link_preview_options: { is_disabled: true } };
    if (i === 0 && replyTo) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    const r = await tg('sendMessage', body);
    if (!r.ok) { ok = false; log('telegram sendMessage failed:', redact(r.description)); }
  }
  return ok;
}

const HELP =
  'Multi-agent council ready.\n\nSend any prompt. A GitHub Actions run plans it with the master agent, runs the workers in parallel, combines and reviews the result, and replies here.\n\n/agents - which agents have keys\n/help - this message';
const traceLine = (t, ms) => {
  const p = [];
  if (t.master) p.push('master ' + t.master);
  if (t.workers && t.workers.length) p.push('workers ' + t.workers.map((w) => w.role + ':' + (w.agent || 'failed')).join(', '));
  if (t.reviewer) p.push('review ' + t.reviewer);
  return p.join(' | ') + ' (' + (ms / 1000).toFixed(1) + 's)';
};
const setOutput = (k, v) => { if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, k + '=' + v + '\n'); };

// ------------------------------------------------------------------ one message
// returns 'ignored' | 'command' | 'done' | 'failed'
async function handle({ chatId, text, messageId, updateId }) {
  chatId = String(chatId || '').trim();
  if (!/^-?\d+$/.test(chatId)) { log('invalid chat id, ignoring'); return 'ignored'; }
  if (allowed.length === 0) { log('TELEGRAM_ALLOWED_CHAT_IDS is empty: set it as a repository secret. Ignoring message.'); return 'ignored'; }
  if (!allowed.includes(chatId)) { log('chat not in allow-list, ignoring'); return 'ignored'; }

  const prompt = String(text || '').trim().slice(0, 8000);
  if (!prompt) return 'ignored';
  if (/^\/(start|help)\b/i.test(prompt)) { await send(chatId, HELP, messageId); return 'command'; }
  if (/^\/agents\b/i.test(prompt)) {
    const [r] = await runCode('return [{json:{text: agentStatus()}}];', [{}]);
    await send(chatId, r.text + '\n\n(Keys are checked here; rate-limit cooldowns only exist while a run is in progress.)', messageId);
    return 'command';
  }
  if (/^\//.test(prompt)) { await send(chatId, 'Unknown command. Try /help', messageId); return 'command'; }

  await send(chatId, '⏳ Pipeline started. Master is planning…', messageId);
  let items = [{ jobId: 'tg-' + (updateId || Date.now()), source: 'telegram', prompt, chatId, startedAt: Date.now() }];
  for (const f of ['master_plan.js', 'run_workers.js', 'master_combine.js', 'review.js']) items = await runNode(f, items);
  const job = items[0];
  const ms = Date.now() - job.startedAt;

  // log only the shape of the run, never the content
  log('mode=' + (job.trace && job.trace.mode) + ' ' + traceLine(job.trace || {}, ms) + (job.failed ? ' FAILED' : ''));

  if (job.failed) {
    await send(chatId, '⚠️ ' + job.failed, messageId);
    setOutput('notified', 'true');
    return 'failed';
  }
  const delivered = await send(chatId, String(job.final || '(empty answer)') + '\n\n- ' + traceLine(job.trace || {}, ms), messageId);
  if (!delivered) return 'failed';
  setOutput('notified', 'true');
  return 'done';
}

// ------------------------------------------------------------------ modes
async function modeRun() {
  const r = await handle({ chatId: env.CHAT_ID, text: env.PROMPT, messageId: Number(env.MESSAGE_ID) || undefined, updateId: env.UPDATE_ID });
  return r === 'failed' ? 1 : 0;
}

async function modeFail() {
  const chatId = String(env.CHAT_ID || '').trim();
  if (!TOKEN || !allowed.includes(chatId)) return 0;
  const url = clean('RUN_URL');
  await send(chatId, '⚠️ The pipeline failed before it could answer.' + (url ? '\nDetails: ' + url : ''), Number(env.MESSAGE_ID) || undefined);
  return 0;
}

async function modePoll() {
  const first = await tg('getUpdates', { timeout: 0, allowed_updates: ['message'] });
  if (!first.ok) {
    const hint = /webhook/i.test(first.description || '') ? ' A webhook is registered: delete it (deleteWebhook) to use polling, or use the relay workflow instead.' : '';
    log('getUpdates failed: ' + redact(first.description) + hint);
    return 1;
  }
  const updates = first.result || [];
  log('pending updates: ' + updates.length);
  if (!updates.length) return 0;
  // at-most-once: confirm everything first so a crash never replays the same prompt
  const last = Math.max(...updates.map((u) => u.update_id));
  await tg('getUpdates', { offset: last + 1, timeout: 0, limit: 1 });

  let failed = 0;
  for (const u of updates) {
    const m = u.message;
    if (!m || typeof m.text !== 'string' || !m.chat) continue;
    try {
      const r = await handle({ chatId: m.chat.id, text: m.text, messageId: m.message_id, updateId: u.update_id });
      if (r === 'failed') failed++;
    } catch (e) {
      failed++;
      log('error while handling an update: ' + redact(e.message));
      await send(String(m.chat.id), '⚠️ The pipeline hit an unexpected error.', m.message_id).catch(() => {});
    }
  }
  return failed ? 1 : 0;
}

(async () => {
  const mode = process.argv[2] || 'run';
  if (!TOKEN) { log('TELEGRAM_BOT_TOKEN is not set (add it as a repository secret).'); process.exit(1); }
  const fn = { run: modeRun, fail: modeFail, poll: modePoll }[mode];
  if (!fn) { log('unknown mode ' + mode); process.exit(2); }
  try { process.exit(await fn()); } catch (e) { log('fatal: ' + redact(e && e.message)); process.exit(1); }
})();
