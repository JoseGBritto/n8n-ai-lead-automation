#!/usr/bin/env node
/**
 * Generates the importable n8n workflows in /workflows from a readable definition.
 * The business logic in src/lead-logic.js is inlined into every Code node, so the code
 * that runs in n8n is exactly the code covered by the tests.
 *
 *   npm run build
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGIC = fs.readFileSync(path.join(ROOT, 'src', 'lead-logic.js'), 'utf8')
  .replace(/^module\.exports[\s\S]*$/m, '')
  .trim();
const HEADER = '// Generated from src/lead-logic.js by scripts/build-workflows.js — edit there, then run `npm run build`.\n';

let counter = 0;
const uid = (prefix) => `${prefix}-${String(++counter).padStart(4, '0')}-4a1b-9c2d-${'0'.repeat(12 - String(counter).length)}${counter}`;

function code(name, body, position) {
  return node(name, 'n8n-nodes-base.code', 2, position, { mode: 'runOnceForAllItems', jsCode: `${HEADER}${LOGIC}\n\n// ---- node logic ----\n${body.trim()}\n` });
}

function node(name, type, typeVersion, position, parameters, extra = {}) {
  return { id: uid('node'), name, type, typeVersion, position, parameters, ...extra };
}

function connect(pairs) {
  const connections = {};
  for (const [from, to, output = 0] of pairs) {
    connections[from] = connections[from] || { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: 'main', index: 0 });
  }
  return connections;
}

const sheetsDoc = { __rl: true, mode: 'url', value: "={{ $('Settings').first().json.crm_sheet_url }}" };
const sheetsTab = { __rl: true, mode: 'name', value: 'Leads' };
const cred = (type, name) => ({ [type]: { id: uid('cred').slice(0, 16), name } });

const ifEquals = (left, right, operation = 'equals', type = 'string') => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: uid('cond'), leftValue: left, rightValue: right, operator: { type, operation } }],
    combinator: 'and',
  },
  options: {},
});

const settings = (fields, position) => node('Settings', 'n8n-nodes-base.set', 3.4, position, {
  assignments: { assignments: fields.map(([name, value, type = 'string']) => ({ id: uid('set'), name, value, type })) },
  includeOtherFields: true,
  options: {},
});

// ------------------------------------------------------------------------------------------------
// 1) Lead intake: webhook → validate → AI qualification → CRM → instant reply + sales alert
// ------------------------------------------------------------------------------------------------
const intakeNodes = [
  node('New lead (webhook)', 'n8n-nodes-base.webhook', 2, [0, 300], {
    httpMethod: 'POST', path: 'new-lead', responseMode: 'responseNode', options: { allowedOrigins: '*' },
  }, { webhookId: 'b3f6c1de-2a41-4c8e-9f57-new-lead0001' }),
  settings([
    ['business_offer', 'a web development and automation studio that builds websites, online stores and internal tools'],
    ['ai_base_url', 'https://api.openai.com/v1'],
    ['ai_model', 'gpt-4o-mini'],
    ['crm_sheet_url', 'https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit'],
    ['sales_channel', '#sales'],
  ], [220, 300]),
  code('Validate & normalize', `
const out = [];
for (const item of $input.all()) {
  const cfg = item.json;
  const { lead, valid, errors } = normalizeLead(cfg);
  out.push({ json: { lead, valid, errors, ai_request: buildAiRequest(lead, cfg.ai_model, cfg.business_offer) } });
}
return out;`, [440, 300]),
  node('Valid?', 'n8n-nodes-base.if', 2.2, [660, 300], ifEquals('={{ $json.valid }}', true, 'true', 'boolean')),
  node('AI qualification', 'n8n-nodes-base.httpRequest', 4.2, [900, 200], {
    method: 'POST',
    url: "={{ $('Settings').first().json.ai_base_url }}/chat/completions",
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.ai_request) }}',
    options: { timeout: 30000 },
  }, { credentials: cred('httpHeaderAuth', 'AI provider (Authorization: Bearer)'), onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2 }),
  code('Score & build CRM row', `
// The AI response replaced the item, so recover the lead that produced it.
return $input.all().map((item, i) => {
  const lead = $('Validate & normalize').itemMatching(i).json.lead;
  return { json: qualify(lead, item.json) };
});`, [1120, 200]),
  node('Save to CRM (Google Sheets)', 'n8n-nodes-base.googleSheets', 4.5, [1340, 200], {
    operation: 'append', documentId: sheetsDoc, sheetName: sheetsTab,
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: {},
  }, { credentials: cred('googleSheetsOAuth2Api', 'Google Sheets account') }),
  node('Respond: thanks', 'n8n-nodes-base.respondToWebhook', 1.1, [1580, 40], {
    respondWith: 'json',
    responseBody: '={{ { "ok": true, "message": "Thanks! We received your request and will reply shortly." } }}',
    options: { responseCode: 200 },
  }),
  node('Not spam?', 'n8n-nodes-base.if', 2.2, [1580, 200],
    ifEquals("={{ $('Score & build CRM row').item.json.status }}", 'spam', 'notEquals')),
  node('Instant reply (Gmail)', 'n8n-nodes-base.gmail', 2.1, [1800, 200], {
    sendTo: "={{ $('Score & build CRM row').item.json.email }}",
    subject: "={{ 'Re: your request' + ($('Score & build CRM row').item.json.service ? ' — ' + $('Score & build CRM row').item.json.service : '') }}",
    emailType: 'text',
    message: "={{ $('Score & build CRM row').item.json.reply }}",
    options: { appendAttribution: false },
  }, { credentials: cred('gmailOAuth2', 'Gmail account') }),
  node('Hot or warm?', 'n8n-nodes-base.if', 2.2, [1580, 380],
    ifEquals("={{ $('Score & build CRM row').item.json.tier }}", 'cold', 'notEquals')),
  code('Format alert', `
return $input.all().map((item, i) => {
  const row = $('Score & build CRM row').itemMatching(i).json;
  return { json: { text: alertText(row) } };
});`, [1800, 380]),
  node('Alert sales (Slack)', 'n8n-nodes-base.slack', 2.2, [2020, 380], {
    select: 'channel',
    channelId: { __rl: true, mode: 'name', value: "={{ $('Settings').first().json.sales_channel }}" },
    text: '={{ $json.text }}',
    otherOptions: {},
  }, { credentials: cred('slackApi', 'Slack account') }),
  node('Respond: invalid', 'n8n-nodes-base.respondToWebhook', 1.1, [900, 420], {
    respondWith: 'json',
    responseBody: '={{ { "ok": false, "errors": $json.errors } }}',
    options: { responseCode: 422 },
  }),
];

const intake = {
  name: 'Lead intake — AI qualification, CRM, instant reply and sales alert',
  nodes: intakeNodes,
  connections: connect([
    ['New lead (webhook)', 'Settings'],
    ['Settings', 'Validate & normalize'],
    ['Validate & normalize', 'Valid?'],
    ['Valid?', 'AI qualification', 0],
    ['Valid?', 'Respond: invalid', 1],
    ['AI qualification', 'Score & build CRM row'],
    ['Score & build CRM row', 'Save to CRM (Google Sheets)'],
    ['Save to CRM (Google Sheets)', 'Respond: thanks'],
    ['Save to CRM (Google Sheets)', 'Not spam?'],
    ['Save to CRM (Google Sheets)', 'Hot or warm?'],
    ['Not spam?', 'Instant reply (Gmail)', 0],
    ['Hot or warm?', 'Format alert', 0],
    ['Format alert', 'Alert sales (Slack)'],
  ]),
  settings: { executionOrder: 'v1', errorWorkflow: 'LeadErrorAlert01' },
  pinData: {},
  active: false,
  id: 'LeadIntake000001',
  tags: [],
};

// ------------------------------------------------------------------------------------------------
// 2) Daily follow-ups for leads that have not answered
// ------------------------------------------------------------------------------------------------
const followNodes = [
  node('Every weekday 9:00', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 300], {
    rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * 1-5' }] },
  }),
  settings([['crm_sheet_url', 'https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit']], [220, 300]),
  node('Read CRM', 'n8n-nodes-base.googleSheets', 4.5, [440, 300], {
    operation: 'read', documentId: sheetsDoc, sheetName: sheetsTab, options: {},
  }, { credentials: cred('googleSheetsOAuth2Api', 'Google Sheets account'), alwaysOutputData: false }),
  code('Pick due follow-ups', `
const rows = $input.all().map((item) => item.json);
return dueFollowUps(rows, new Date()).map((row) => ({ json: row }));`, [660, 300]),
  node('Send follow-up (Gmail)', 'n8n-nodes-base.gmail', 2.1, [880, 300], {
    sendTo: '={{ $json.email }}',
    subject: '={{ $json.followup_subject }}',
    emailType: 'text',
    message: '={{ $json.followup_body }}',
    options: { appendAttribution: false },
  }, { credentials: cred('gmailOAuth2', 'Gmail account') }),
  code('Prepare CRM update', `
return $input.all().map((item, i) => {
  const row = $('Pick due follow-ups').itemMatching(i).json;
  return { json: { id: row.id, followups: row.followups, last_contact: row.last_contact } };
});`, [1100, 300]),
  node('Update CRM row', 'n8n-nodes-base.googleSheets', 4.5, [1320, 300], {
    operation: 'update', documentId: sheetsDoc, sheetName: sheetsTab,
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['id'], schema: [] },
    options: {},
  }, { credentials: cred('googleSheetsOAuth2Api', 'Google Sheets account') }),
];

const followUp = {
  name: 'Lead follow-ups — daily reminders until the lead answers',
  nodes: followNodes,
  connections: connect([
    ['Every weekday 9:00', 'Settings'], ['Settings', 'Read CRM'], ['Read CRM', 'Pick due follow-ups'],
    ['Pick due follow-ups', 'Send follow-up (Gmail)'], ['Send follow-up (Gmail)', 'Prepare CRM update'],
    ['Prepare CRM update', 'Update CRM row'],
  ]),
  settings: { executionOrder: 'v1', errorWorkflow: 'LeadErrorAlert01' },
  pinData: {}, active: false, id: 'LeadFollowUp0001', tags: [],
};

// ------------------------------------------------------------------------------------------------
// 3) Error alert: tells the team in Slack if any of the workflows fails
// ------------------------------------------------------------------------------------------------
const errorAlert = {
  name: 'Lead automation — error alert',
  nodes: [
    node('When a workflow fails', 'n8n-nodes-base.errorTrigger', 1, [0, 300], {}),
    node('Notify team (Slack)', 'n8n-nodes-base.slack', 2.2, [240, 300], {
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: '#sales' },
      text: "={{ '⚠️ Workflow *' + $json.workflow.name + '* failed at node *' + $json.execution.lastNodeExecuted + '*: ' + $json.execution.error.message + '\\n' + ($json.execution.url || '') }}",
      otherOptions: {},
    }, { credentials: cred('slackApi', 'Slack account') }),
  ],
  connections: connect([['When a workflow fails', 'Notify team (Slack)']]),
  settings: { executionOrder: 'v1' },
  pinData: {}, active: false, id: 'LeadErrorAlert01', tags: [],
};

const out = { '01-lead-intake.json': intake, '02-lead-follow-ups.json': followUp, '03-error-alert.json': errorAlert };
for (const [file, wf] of Object.entries(out)) {
  fs.writeFileSync(path.join(ROOT, 'workflows', file), JSON.stringify(wf, null, 2) + '\n');
  console.log(`workflows/${file}: ${wf.nodes.length} nodes`);
}
