// Tests the GitHub Actions side: scripts/council_cli.js (run / fail / poll) and relay/worker.js.
// node tests/run_cli.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { createMock } = require('./mock-services');

const root = path.join(__dirname, '..');
const CLI = path.join(root, 'scripts', 'council_cli.js');
const PORT = 4020;
const BASE = 'http://127.0.0.1:' + PORT;
const ENV = {
  ANTHROPIC_API_KEY_A: 'key-claude-a', ANTHROPIC_API_KEY_B: 'key-claude-b',
  OPENAI_API_KEY_A: 'key-chatgpt-a', OPENAI_API_KEY_B: 'key-chatgpt-b',
  GEMINI_API_KEY_A: 'key-gemini-a', GEMINI_API_KEY_B: 'key-gemini-b',
  ANTHROPIC_BASE_URL: BASE, OPENAI_BASE_URL: BASE + '/v1', GEMINI_BASE_URL: BASE + '/v1beta',
  TELEGRAM_API_BASE: BASE, TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_ALLOWED_CHAT_IDS: '111',
};

const cli = (mode, extra = {}) => new Promise((resolve) => {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gho-')), 'out');
  fs.writeFileSync(outFile, '');
  // start from a clean environment so the test never depends on the developer's shell
  const base = { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' };
  const p = spawn('node', [CLI, mode], { env: { ...base, ...ENV, GITHUB_OUTPUT: outFile, ...extra } });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out, gh: fs.readFileSync(outFile, 'utf8') }));
});
const api = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await api('/__test/reset'); await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message.split('\n')[0]); }
};

(async () => {
  const { server } = createMock();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  console.log('council_cli.js');

  await t('run: prompt → pipeline → reply to the same chat, threaded to the message, trace footer', async () => {
    const r = await cli('run', { PROMPT: 'Explain DNS $(rm -rf /) `id` "quotes"', CHAT_ID: '111', MESSAGE_ID: '42', UPDATE_ID: '900' });
    assert.strictEqual(r.code, 0, r.out);
    const sent = await get('/__test/sent');
    assert.strictEqual(sent.length, 2); assert.ok(/Pipeline started/.test(sent[0].text));
    assert.ok(/FINAL ANSWER \(merged 3 worker results by claude_a\)/.test(sent[1].text));
    assert.ok(/master claude_a \| workers research:gemini_a, code:chatgpt_a, writing:chatgpt_b \| review claude_b/.test(sent[1].text));
    assert.ok(sent.every((m) => m.chat_id === '111'));
    assert.ok(/notified=true/.test(r.gh));
  });

  await t('run: log never contains the prompt or the answer (public-repo logs are public)', async () => {
    const r = await cli('run', { PROMPT: 'SECRET-PROMPT-MARKER explain DNS', CHAT_ID: '111' });
    assert.strictEqual(r.code, 0);
    assert.ok(!/SECRET-PROMPT-MARKER/.test(r.out), 'prompt leaked into log');
    assert.ok(!/FINAL ANSWER|Lorem ipsum/.test(r.out), 'answer leaked into log');
    assert.ok(/mode=delegate/.test(r.out));
  });

  await t('run: simple prompt is answered directly by the master', async () => {
    const r = await cli('run', { PROMPT: 'hello', CHAT_ID: '111' });
    assert.strictEqual(r.code, 0);
    assert.ok((await get('/__test/sent')).some((m) => /council is online/.test(m.text)));
    assert.strictEqual((await get('/__test/calls')).length, 1);
  });

  await t('run: chat outside the allow-list is ignored silently (exit 0, no messages, no AI calls)', async () => {
    const r = await cli('run', { PROMPT: 'hello', CHAT_ID: '999' });
    assert.strictEqual(r.code, 0);
    assert.strictEqual((await get('/__test/sent')).length, 0); assert.strictEqual((await get('/__test/calls')).length, 0);
  });

  await t('run: empty allow-list refuses to run (nobody can spend your keys)', async () => {
    const r = await cli('run', { PROMPT: 'hello', CHAT_ID: '111', TELEGRAM_ALLOWED_CHAT_IDS: '' });
    assert.strictEqual((await get('/__test/calls')).length, 0); assert.ok(/ALLOWED_CHAT_IDS/.test(r.out));
  });

  await t('run: malformed chat id is rejected', async () => {
    const r = await cli('run', { PROMPT: 'hello', CHAT_ID: '111; curl evil' });
    assert.strictEqual((await get('/__test/calls')).length, 0); assert.strictEqual((await get('/__test/sent')).length, 0); assert.strictEqual(r.code, 0);
  });

  await t('run: gemini_a down → fallback worker serves, run still succeeds', async () => {
    await api('/__test/fail', { agents: ['gemini_a'], status: 429 });
    const r = await cli('run', { PROMPT: 'Explain DNS', CHAT_ID: '111' });
    assert.strictEqual(r.code, 0); assert.ok(/research:gemini_b/.test((await get('/__test/sent')).pop().text));
  });

  await t('run: no API keys → user gets a clear error, exit 1, notified=true (no duplicate failure message)', async () => {
    const none = { ANTHROPIC_API_KEY_A: '', ANTHROPIC_API_KEY_B: '', OPENAI_API_KEY_A: '', OPENAI_API_KEY_B: '', GEMINI_API_KEY_A: '', GEMINI_API_KEY_B: '' };
    const r = await cli('run', { PROMPT: 'Explain DNS', CHAT_ID: '111', ...none });
    assert.strictEqual(r.code, 1);
    assert.ok((await get('/__test/sent')).some((m) => /no agent has an API key/.test(m.text)));
    assert.ok(/notified=true/.test(r.gh));
  });

  await t('run: missing bot token fails loudly without leaking anything', async () => {
    const r = await cli('run', { PROMPT: 'hi', CHAT_ID: '111', TELEGRAM_BOT_TOKEN: '' });
    assert.strictEqual(r.code, 1); assert.ok(/TELEGRAM_BOT_TOKEN/.test(r.out));
  });

  await t('run: /help and /agents answer without calling any AI', async () => {
    await cli('run', { PROMPT: '/help', CHAT_ID: '111' });
    const a = await cli('run', { PROMPT: '/agents', CHAT_ID: '111', GEMINI_API_KEY_B: '' });
    assert.strictEqual(a.code, 0);
    const sent = await get('/__test/sent');
    assert.ok(/Multi-agent council ready/.test(sent[0].text));
    assert.ok(/Gemini B[^\n]*no key/.test(sent[1].text) && /Claude A[^\n]*ready/.test(sent[1].text));
    assert.strictEqual((await get('/__test/calls')).length, 0);
  });

  await t('fail: allowed chat is told, with the run link; strangers are not', async () => {
    await cli('fail', { CHAT_ID: '111', RUN_URL: 'https://github.com/o/r/actions/runs/1', MESSAGE_ID: '5' });
    await cli('fail', { CHAT_ID: '999', RUN_URL: 'https://github.com/o/r/actions/runs/1' });
    const sent = await get('/__test/sent');
    assert.strictEqual(sent.length, 1); assert.ok(/failed/.test(sent[0].text) && /runs\/1/.test(sent[0].text));
  });

  await t('poll: processes allowed messages once, ignores strangers, does not replay on the next run', async () => {
    await api('/__test/enqueue', { chat_id: 999, text: 'let me in' });
    await api('/__test/enqueue', { chat_id: 111, text: 'Explain DNS' });
    await api('/__test/enqueue', { chat_id: 111, text: 'hello' });
    const r = await cli('poll');
    assert.strictEqual(r.code, 0, r.out);
    let sent = await get('/__test/sent');
    assert.ok(sent.every((m) => m.chat_id === '111'), 'stranger got a reply');
    assert.strictEqual(sent.filter((m) => /FINAL ANSWER/.test(m.text)).length, 1);
    assert.strictEqual(sent.filter((m) => /council is online/.test(m.text)).length, 1);
    await api('/__test/reset-sent');
    const again = await cli('poll');
    assert.strictEqual(again.code, 0); assert.ok(/pending updates: 0/.test(again.out));
    assert.strictEqual((await get('/__test/sent')).length, 0, 'second poll replayed old messages');
  });

  await t('poll: nothing pending → clean exit, no AI calls', async () => {
    const r = await cli('poll');
    assert.strictEqual(r.code, 0); assert.strictEqual((await get('/__test/calls')).length, 0);
  });

  console.log('\nrelay/worker.js');
  const worker = (await import(pathToFileURL(path.join(root, 'relay', 'worker.js')).href)).default;
  const realFetch = globalThis.fetch;
  const rec = { calls: [], githubStatus: 204 };
  globalThis.fetch = async (url, init) => {
    rec.calls.push({ url: String(url), init });
    if (String(url).startsWith('https://api.github.com/')) return new Response(null, { status: rec.githubStatus });
    return new Response('{"ok":true}', { status: 200 });
  };
  const E = { TELEGRAM_WEBHOOK_SECRET: 'whsec', TELEGRAM_ALLOWED_CHAT_IDS: '111,222', GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'me/council', TELEGRAM_BOT_TOKEN: 'TESTTOKEN' };
  const hit = (body, secret = 'whsec', method = 'POST') => worker.fetch(new Request('https://relay.example/', {
    method, headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret }) }, body: method === 'POST' ? JSON.stringify(body) : undefined,
  }), E);
  const reset = () => { rec.calls = []; rec.githubStatus = 204; };
  const msg = (chat, text) => ({ update_id: 7, message: { message_id: 3, chat: { id: chat }, text } });
  const tt = async (name, fn) => { reset(); try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message.split('\n')[0]); } };

  await tt('valid message → repository_dispatch with prompt, chat, message and update ids', async () => {
    const r = await hit(msg(111, '  Explain DNS  '));
    assert.strictEqual(r.status, 200); assert.strictEqual(rec.calls.length, 1);
    const c = rec.calls[0];
    assert.strictEqual(c.url, 'https://api.github.com/repos/me/council/dispatches');
    assert.strictEqual(c.init.headers.Authorization, 'Bearer ghp_x'); assert.ok(c.init.headers['User-Agent']);
    assert.deepStrictEqual(JSON.parse(c.init.body), { event_type: 'telegram_prompt', client_payload: { prompt: 'Explain DNS', chat_id: '111', message_id: 3, update_id: 7 } });
  });
  await tt('wrong or missing secret → 403, nothing dispatched', async () => {
    assert.strictEqual((await hit(msg(111, 'x'), 'nope')).status, 403);
    assert.strictEqual((await hit(msg(111, 'x'), null)).status, 403);
    assert.strictEqual(rec.calls.length, 0);
  });
  await tt('stranger chat → 200 but nothing dispatched and no reply', async () => {
    assert.strictEqual((await hit(msg(999, 'x'))).status, 200); assert.strictEqual(rec.calls.length, 0);
  });
  await tt('non-text updates, edits and GET are ignored', async () => {
    await hit({ update_id: 1, message: { message_id: 1, chat: { id: 111 }, photo: [] } });
    await hit({ update_id: 2, edited_message: { message_id: 1, chat: { id: 111 }, text: 'x' } });
    assert.strictEqual((await hit(null, 'whsec', 'GET')).status, 200);
    assert.strictEqual(rec.calls.length, 0);
  });
  await tt('prompt is capped at 8000 characters', async () => {
    await hit(msg(111, 'a'.repeat(20000)));
    assert.strictEqual(JSON.parse(rec.calls[0].init.body).client_payload.prompt.length, 8000);
  });
  await tt('GitHub refuses the dispatch → still 200 to Telegram (no retry storm), user is told', async () => {
    rec.githubStatus = 401;
    const r = await hit(msg(111, 'x'));
    assert.strictEqual(r.status, 200);
    const told = rec.calls.find((c) => c.url.includes('api.telegram.org'));
    assert.ok(told && /HTTP 401/.test(JSON.parse(told.init.body).text));
  });
  globalThis.fetch = realFetch;

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
