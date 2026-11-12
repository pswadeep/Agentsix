#!/usr/bin/env node
// Builds workflows/multi-agent-orchestrator.json from the readable sources in workflows/src/.
// Usage: node scripts/build_workflow.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, 'workflows', 'src', f), 'utf8');
const LIB = read('lib.js');
const withLib = (f) => LIB + '\n// ============================ NODE LOGIC ============================\n' + read(f);

const uid = (s) => {
  const h = crypto.createHash('md5').update('multi-agent-council:' + s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const codeNode = (name, file, position, notes) => ({
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: withLib(file) },
  id: uid(name),
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
  notes,
  notesInFlow: false,
});

const sticky = (name, content, position, width, height, color) => ({
  parameters: { content, height, width, color },
  id: uid(name),
  name,
  type: 'n8n-nodes-base.stickyNote',
  typeVersion: 1,
  position,
});

const nodes = [
  sticky(
    'Overview',
    '## Multi-Agent Council\n' +
      '**Master** = Claude A (plans + combines, failover Claude B).\n' +
      '**Workers** = research → Gemini A · quick → Gemini B · code → ChatGPT A · writing → ChatGPT B · analysis → Claude B.\n' +
      '**Reviewer** = Claude B.\n\n' +
      'Inputs: Telegram (polled every 5 s, no public URL needed) and the localhost page (webhook).\n' +
      'Outputs: Telegram reply + localhost feed.\n\n' +
      'All keys, models and role routing come from environment variables (.env) — nothing secret lives in this workflow.\n' +
      'Activate the workflow (toggle top-right) so the triggers run.',
    [-700, -420], 560, 250, 4
  ),
  {
    parameters: { rule: { interval: [{ field: 'seconds', secondsInterval: 5 }] } },
    id: uid('Every 5s'),
    name: 'Every 5s',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [-640, -80],
  },
  codeNode('Poll Telegram', 'poll_telegram.js', [-400, -80], 'Telegram getUpdates polling. Emits one item per authorised message.'),
  {
    parameters: { httpMethod: 'POST', path: 'agents-prompt', responseMode: 'responseNode', options: {} },
    id: uid('Web Prompt'),
    name: 'Web Prompt',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [-640, 200],
    webhookId: uid('webhook-agents-prompt'),
  },
  codeNode('Validate Web Request', 'validate_web.js', [-420, 200], 'Checks x-webhook-secret and the prompt.'),
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: uid('cond-valid'),
            leftValue: '={{ $json.valid }}',
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: uid('Valid?'),
    name: 'Valid?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [-200, 200],
  },
  {
    parameters: {
      respondWith: 'json',
      responseBody: '={{ { "accepted": true, "jobId": $json.jobId } }}',
      options: { responseCode: 202 },
    },
    id: uid('Respond 202'),
    name: 'Respond 202',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [20, 160],
  },
  {
    parameters: {
      respondWith: 'json',
      responseBody: '={{ { "accepted": false, "error": $json.reason } }}',
      options: { responseCode: 401 },
    },
    id: uid('Respond 401'),
    name: 'Respond 401',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [20, 340],
  },
  codeNode('Master: Plan', 'master_plan.js', [300, 40], 'Claude A decides: answer directly, or design the worker workflow (roles + tasks).'),
  codeNode('Workers: Execute', 'run_workers.js', [560, 40], 'Runs all planned tasks in parallel. Each role has a failover chain across the 6 agents.'),
  codeNode('Master: Combine', 'master_combine.js', [820, 40], 'Claude A merges worker results into one answer.'),
  codeNode('Reviewer: QA', 'review.js', [1080, 40], 'Claude B checks the draft. Disable with REVIEW_ENABLED=false.'),
  codeNode('Deliver: Telegram + Localhost', 'deliver.js', [1340, 40], 'Sends the reply to Telegram and publishes to the localhost feed.'),
];

const link = (node, index = 0) => ({ node, type: 'main', index });
const connections = {
  'Every 5s': { main: [[link('Poll Telegram')]] },
  'Poll Telegram': { main: [[link('Master: Plan')]] },
  'Web Prompt': { main: [[link('Validate Web Request')]] },
  'Validate Web Request': { main: [[link('Valid?')]] },
  'Valid?': { main: [[link('Respond 202')], [link('Respond 401')]] },
  'Respond 202': { main: [[link('Master: Plan')]] },
  'Master: Plan': { main: [[link('Workers: Execute')]] },
  'Workers: Execute': { main: [[link('Master: Combine')]] },
  'Master: Combine': { main: [[link('Reviewer: QA')]] },
  'Reviewer: QA': { main: [[link('Deliver: Telegram + Localhost')]] },
};

const workflow = {
  id: 'MultiAgentCnl001', // the CLI importer (n8n import:workflow) requires an id
  name: 'Multi-Agent Council (Master + 5 Workers)',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    saveExecutionProgress: false,
  },
  pinData: {},
  meta: { templateCredsSetupCompleted: true },
  tags: [],
};

const outFile = path.join(root, 'workflows', 'multi-agent-orchestrator.json');
fs.writeFileSync(outFile, JSON.stringify(workflow, null, 2) + '\n');
console.log('wrote', path.relative(root, outFile), '(' + nodes.length + ' nodes)');
