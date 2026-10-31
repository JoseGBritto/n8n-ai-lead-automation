// Runs the Code nodes exactly as they are stored in the generated workflow JSON,
// with small stand-ins for n8n's $input and $() helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', f), 'utf8'));
const intake = load('01-lead-intake.json');
const follow = load('02-lead-follow-ups.json');
const errorWf = load('03-error-alert.json');

function runCode(workflow, nodeName, inputItems, otherNodes = {}) {
  const node = workflow.nodes.find((n) => n.name === nodeName);
  assert.ok(node, `node ${nodeName} exists`);
  const $input = { all: () => inputItems.map((json) => ({ json })) };
  const $ = (name) => ({
    itemMatching: (i) => ({ json: otherNodes[name][i] }),
    first: () => ({ json: otherNodes[name][0] }),
    all: () => otherNodes[name].map((json) => ({ json })),
  });
  return new Function('$input', '$', node.parameters.jsCode)($input, $).map((i) => i.json);
}

for (const wf of [intake, follow, errorWf]) {
  test(`${wf.name}: structure is valid`, () => {
    const names = wf.nodes.map((n) => n.name);
    assert.equal(new Set(names).size, names.length, 'node names are unique');
    assert.equal(new Set(wf.nodes.map((n) => n.id)).size, names.length, 'node ids are unique');
    for (const [from, { main }] of Object.entries(wf.connections)) {
      assert.ok(names.includes(from), `connection source ${from}`);
      for (const branch of main) for (const c of branch) assert.ok(names.includes(c.node), `connection target ${c.node}`);
    }
    const connected = new Set([...Object.keys(wf.connections), ...Object.values(wf.connections).flatMap((c) => c.main.flat().map((x) => x.node))]);
    for (const n of names) assert.ok(connected.has(n), `${n} is connected`);
    assert.match(wf.id, /^[A-Za-z0-9]{16}$/);
  });
}

test('intake: only the error workflow referenced exists', () => {
  assert.equal(intake.settings.errorWorkflow, errorWf.id);
  assert.equal(follow.settings.errorWorkflow, errorWf.id);
});

const settings = { business_offer: 'a web studio', ai_model: 'gpt-4o-mini' };

test('intake: Validate & normalize node', () => {
  const [ok, bad] = runCode(intake, 'Validate & normalize', [
    { ...settings, body: { name: 'Lucía Fernández', email: 'lucia@bodegaandes.com.ar', message: 'Necesitamos una tienda online para vender vinos, presupuesto u$s 3000.' } },
    { ...settings, body: { name: '', email: 'x', message: '' } },
  ]);
  assert.equal(ok.valid, true);
  assert.equal(ok.ai_request.messages[0].content.includes('a web studio'), true);
  assert.equal(bad.valid, false);
});

test('intake: Score & build CRM row node pairs AI output with its lead', () => {
  const validated = runCode(intake, 'Validate & normalize', [
    { ...settings, body: { name: 'Lucía Fernández', email: 'lucia@bodegaandes.com.ar', message: 'Necesitamos una tienda online para vender vinos, presupuesto u$s 3000.' } },
  ]);
  const aiOutput = { choices: [{ message: { content: JSON.stringify({ fit_score: 85, intent: 'buy_now', budget_usd: 3000, urgency: 'medium',
    service: 'Online store', summary: 'Winery wants an online store', reply: 'Hola Lucía, gracias por contarnos sobre la tienda online de la bodega. ' + 'x'.repeat(20) }) } }] };
  const [row] = runCode(intake, 'Score & build CRM row', [aiOutput], { 'Validate & normalize': validated });
  assert.equal(row.email, 'lucia@bodegaandes.com.ar');
  assert.equal(row.tier, 'hot');
  assert.equal(row.service, 'Online store');

  const [fallback] = runCode(intake, 'Score & build CRM row', [{ error: { message: 'timeout' } }], { 'Validate & normalize': validated });
  assert.equal(fallback.qualified_by, 'rules');

  const [alert] = runCode(intake, 'Format alert', [{}], { 'Score & build CRM row': [row] });
  assert.match(alert.text, /HOT lead/);
});

test('follow-ups: Pick due follow-ups + Prepare CRM update nodes', () => {
  const old = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  const rows = [
    { id: 'L1', name: 'Ana', email: 'a@x.co', tier: 'hot', status: 'new', followups: '0', created_at: old, last_contact: '' },
    { id: 'L2', name: 'Beto', email: 'b@x.co', tier: 'warm', status: 'won', followups: '0', created_at: old, last_contact: '' },
  ];
  const due = runCode(follow, 'Pick due follow-ups', rows);
  assert.deepEqual(due.map((r) => r.id), ['L1']);
  const [update] = runCode(follow, 'Prepare CRM update', [{ id: 'gmail-msg-id' }], { 'Pick due follow-ups': due });
  assert.deepEqual(Object.keys(update), ['id', 'followups', 'last_contact']);
  assert.equal(update.followups, 1);
});

test('intake: the visitor is answered before the slow steps, and bots get a silent 200', () => {
  const targets = (from, output) => (intake.connections[from].main[output] || []).map((c) => c.node);
  assert.deepEqual(targets('Valid?', 0), ['Respond: thanks', 'AI qualification']);
  assert.deepEqual(targets('Valid?', 1), ['Bot (honeypot)?']);
  assert.deepEqual(targets('Bot (honeypot)?', 0), ['Respond: thanks']);
  assert.deepEqual(targets('Bot (honeypot)?', 1), ['Respond: invalid']);
  const sheets = intake.nodes.find((n) => n.name === 'Save to CRM (Google Sheets)');
  assert.equal(sheets.parameters.options.cellFormat, 'RAW');
  assert.ok(!targets('Save to CRM (Google Sheets)', 0).includes('Respond: thanks'));
});

test('every workflow starts with an editable Settings node', () => {
  for (const wf of [intake, follow, errorWf]) assert.ok(wf.nodes.some((n) => n.name === 'Settings'), wf.name);
});
