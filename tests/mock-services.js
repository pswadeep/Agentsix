// Mock Anthropic / OpenAI / Gemini / Telegram APIs for offline testing and for end-to-end runs against a real n8n.
// node tests/mock-services.js [port]     (default 4010)
// Control endpoints:  POST /__test/reset | /__test/fail {agents:[..], status} | /__test/enqueue {chat_id,text}
//                     GET  /__test/sent  | /__test/calls
'use strict';
const http = require('http');

const KEY_TO_AGENT = {
  'key-claude-a': 'claude_a', 'key-claude-b': 'claude_b',
  'key-chatgpt-a': 'chatgpt_a', 'key-chatgpt-b': 'chatgpt_b',
  'key-gemini-a': 'gemini_a', 'key-gemini-b': 'gemini_b',
};

function createMock() {
  const state = { failing: {}, calls: [], sent: [], updates: [], nextUpdateId: 1000, webhookPosts: [] };
  const reset = () => { state.failing = {}; state.calls = []; state.sent = []; state.updates = []; state.webhookPosts = []; };

  const brain = (agent, system, prompt) => {
    if (/You are MASTER, the orchestrator/.test(system)) {
      if (/\bhello\b/i.test(prompt)) return JSON.stringify({ mode: 'direct', answer: 'Hi! The council is online.' });
      if (/MALFORMED/.test(prompt)) return '{"mode":"delegate","tasks":[';
      return JSON.stringify({
        mode: 'delegate',
        summary: 'research the topic, write a code sample, draft the explanation',
        tasks: [
          { id: 't1', role: 'research', title: 'Background research', instruction: 'Summarise background on: ' + prompt },
          { id: 't2', role: 'code', title: 'Code sample', instruction: 'Write a short code sample for: ' + prompt },
          { id: 't3', role: 'writing', title: 'Explanation', instruction: 'Write a friendly explanation for: ' + prompt },
        ],
        combine: 'Lead with the explanation, then research, then code.',
      });
    }
    if (/You are MASTER\. Your worker agents/.test(system)) {
      const blocks = (prompt.match(/### \[/g) || []).length;
      return 'FINAL ANSWER (merged ' + blocks + ' worker results by ' + agent + '). ' + 'Lorem ipsum dolor sit amet. '.repeat(14) + '\n\n' + prompt.split('Worker results:\n')[1].slice(0, 400);
    }
    if (/You are REVIEWER/.test(system)) {
      return (prompt.split('Draft answer:\n')[1] || '') + '\n[reviewed by ' + agent + ']';
    }
    const role = (system.match(/Your role: (\w+)/) || [])[1] || 'worker';
    return 'WORKER OUTPUT role=' + role + ' agent=' + agent + ' :: ' + prompt.split('Your task')[1].slice(0, 120);
  };

  const readJson = (req) => new Promise((resolve) => {
    const c = []; req.on('data', (d) => c.push(d));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch (e) { resolve({}); } });
  });
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readJson(req) : {};
    const p = url.pathname;

    // ---- control
    if (p === '/__test/reset') { reset(); return json(res, 200, { ok: true }); }
    if (p === '/__test/fail') { state.failing = {}; (body.agents || []).forEach((a) => (state.failing[a] = body.status || 429)); return json(res, 200, state.failing); }
    if (p === '/__test/enqueue') { state.updates.push({ update_id: state.nextUpdateId++, message: { message_id: 1, chat: { id: body.chat_id }, text: body.text } }); return json(res, 200, { ok: true }); }
    if (p === '/__test/reset-sent') { state.sent = []; return json(res, 200, { ok: true }); }
    if (p === '/__test/sent') return json(res, 200, state.sent);
    if (p === '/__test/calls') return json(res, 200, state.calls);
    if (p === '/__test/webhook') return json(res, 200, state.webhookPosts);

    // ---- stand-in for the n8n webhook (used when testing the localhost server in isolation)
    if (p === '/webhook/agents-prompt') { state.webhookPosts.push({ headers: req.headers, body }); return json(res, 202, { accepted: true }); }

    // ---- Telegram
    const tg = p.match(/^\/bot([^/]+)\/(\w+)$/);
    if (tg) {
      const method = tg[2];
      if (method === 'deleteWebhook') return json(res, 200, { ok: true, result: true });
      if (method === 'getUpdates') {
        const offset = Number(body.offset || 0);
        if (offset) state.updates = state.updates.filter((u) => u.update_id >= offset); // like Telegram: confirmed updates are dropped
        const out = state.updates.filter((u) => u.update_id >= offset);
        return json(res, 200, { ok: true, result: out });
      }
      if (method === 'sendMessage') { state.sent.push({ chat_id: String(body.chat_id), text: body.text }); return json(res, 200, { ok: true, result: { message_id: 1 } }); }
      return json(res, 404, { ok: false, description: 'unknown method' });
    }

    // ---- AI vendors
    let agent, system, prompt, wrap;
    if (p === '/v1/messages') {
      agent = KEY_TO_AGENT[req.headers['x-api-key']];
      system = body.system || ''; prompt = (body.messages || [])[0].content;
      wrap = (t) => ({ content: [{ type: 'text', text: t }] });
    } else if (p === '/v1/responses') {
      agent = KEY_TO_AGENT[String(req.headers.authorization || '').replace('Bearer ', '')];
      system = body.instructions || ''; prompt = body.input;
      wrap = (t) => ({ output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: t }] }] });
    } else if (/^\/v1beta\/models\/.+:generateContent$/.test(p)) {
      agent = KEY_TO_AGENT[req.headers['x-goog-api-key']];
      system = body.systemInstruction.parts[0].text; prompt = body.contents[0].parts[0].text;
      wrap = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });
    } else {
      return json(res, 404, { error: 'no route ' + p });
    }

    state.calls.push({ agent, path: p });
    if (!agent) return json(res, 401, { error: { message: 'invalid api key sk-LEAKEDKEY123456789 provided' } });
    if (state.failing[agent]) return json(res, state.failing[agent], { error: { message: 'simulated failure for ' + agent } });
    return json(res, 200, wrap(brain(agent, system, prompt)));
  });

  return { server, state, reset };
}

module.exports = { createMock, KEY_TO_AGENT };

if (require.main === module) {
  const port = Number(process.argv[2]) || 4010;
  const { server } = createMock();
  server.listen(port, '127.0.0.1', () => console.log('mock services on http://127.0.0.1:' + port));
}
