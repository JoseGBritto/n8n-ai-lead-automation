const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lead-logic');

const NOW = new Date('2026-11-02T12:00:00Z');
const good = {
  body: {
    name: '  María  Gómez ', email: 'Maria@AcmeLogistics.com', phone: '+54 9 299 555-1234', company: 'Acme Logistics',
    message: 'We need a customer portal for 300 clients, budget around USD 8,000, and we would like to start this week.',
  },
};

test('normalizeLead cleans fields and validates', () => {
  const { lead, valid } = L.normalizeLead(good, NOW);
  assert.equal(valid, true);
  assert.equal(lead.name, 'María Gómez');
  assert.equal(lead.email, 'maria@acmelogistics.com');
  assert.equal(lead.phone, '+5492995551234');
  assert.equal(lead.email_domain, 'acmelogistics.com');
  assert.match(lead.id, /^L20261102120000-maria$/);
});

test('normalizeLead accepts Spanish field names and flat bodies', () => {
  const { lead, valid } = L.normalizeLead({ nombre: 'Juan', correo: 'juan@gmail.com', mensaje: 'Necesito una web para mi pyme' }, NOW);
  assert.equal(valid, true);
  assert.equal(lead.name, 'Juan');
});

test('normalizeLead rejects bad input and honeypot spam', () => {
  const r = L.normalizeLead({ body: { name: '', email: 'nope', message: 'hi', website_url_hp: 'x' } }, NOW);
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors, ['name is required', 'a valid email is required', 'message is too short', 'spam']);
});

test('parseBudget understands common formats', () => {
  assert.equal(L.parseBudget('budget around USD 8,000'), 8000);
  assert.equal(L.parseBudget('we have $2.5k'), 2500);
  assert.equal(L.parseBudget('unos 1500 dólares'), 1500);
  assert.equal(L.parseBudget('u$s 700'), 700);
  assert.equal(L.parseBudget('no budget yet'), 0);
});

test('ruleScore rewards strong signals', () => {
  const { lead } = L.normalizeLead(good, NOW);
  const r = L.ruleScore(lead);
  assert.equal(r.score, 90); // everything except 'detailed message' (> 120 chars)
  assert.ok(r.reasons.includes('company email') && r.reasons.includes('urgent'));
  const weak = L.ruleScore(L.normalizeLead({ name: 'A', email: 'a@gmail.com', message: 'just looking around' }, NOW).lead);
  assert.equal(weak.score, 20);
});

test('buildAiRequest asks for JSON and never sends the email address', () => {
  const { lead } = L.normalizeLead(good, NOW);
  const req = L.buildAiRequest(lead, 'llama-3.1', 'a web agency');
  assert.equal(req.response_format.type, 'json_object');
  assert.equal(req.model, 'llama-3.1');
  assert.ok(!req.messages[1].content.includes('maria@'));
  assert.ok(req.messages[0].content.includes('a web agency'));
});

const ai = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

test('qualify blends AI and rules into a CRM row', () => {
  const { lead } = L.normalizeLead(good, NOW);
  const row = L.qualify(lead, ai({ fit_score: 90, intent: 'buy_now', budget_usd: 8000, urgency: 'high', service: 'Customer portal',
    summary: 'Logistics company needs a client portal', reply: 'Hi María, thanks for the details about your customer portal. ' + 'x'.repeat(30) }));
  assert.equal(row.score, 90); // 90*0.75 + 90*0.25
  assert.equal(row.tier, 'hot');
  assert.equal(row.qualified_by, 'ai+rules');
  assert.equal(row.status, 'new');
  assert.ok(row.reply.startsWith('Hi María'));
});

test('qualify falls back to rules when the AI fails or returns junk', () => {
  const { lead } = L.normalizeLead({ name: 'Juan Pérez', email: 'juan@gmail.com', mensaje: 'Hola, necesito una tienda online' }, NOW);
  for (const bad of [undefined, { error: { message: 'rate limit' } }, { choices: [{ message: { content: 'not json' } }] }]) {
    const row = L.qualify(lead, bad);
    assert.equal(row.qualified_by, 'rules');
    assert.equal(row.tier, 'cold');
    assert.ok(row.reply.startsWith('Hola Juan'));
  }
});

test('spam and job seekers are capped', () => {
  const { lead } = L.normalizeLead(good, NOW);
  const row = L.qualify(lead, ai({ fit_score: 95, intent: 'spam' }));
  assert.equal(row.score, 10);
  assert.equal(row.status, 'spam');
});

test('tiers', () => {
  assert.equal(L.tierFor(70), 'hot');
  assert.equal(L.tierFor(69), 'warm');
  assert.equal(L.tierFor(39), 'cold');
});

test('alertText summarises the lead for Slack', () => {
  const { lead } = L.normalizeLead(good, NOW);
  const text = L.alertText(L.qualify(lead, ai({ fit_score: 80, intent: 'buy_now', summary: 'Needs a portal', urgency: 'high' })));
  assert.match(text, /^🔥 \*HOT lead\* \(83\/100\): \*María Gómez\* — Acme Logistics/);
  assert.match(text, /maria@acmelogistics\.com · 📞 \+5492995551234/);
});

test('dueFollowUps picks only stale, open, non-cold leads and caps attempts', () => {
  const base = { status: 'new', email: 'a@b.co', tier: 'warm', name: 'Ana Ruiz', followups: 0 };
  const rows = [
    { ...base, id: 1, created_at: '2026-10-30T12:00:00Z' },                          // 3 days old -> due
    { ...base, id: 2, created_at: '2026-11-01T12:00:00Z' },                          // 1 day -> not yet
    { ...base, id: 3, created_at: '2026-10-20T12:00:00Z', followups: 2 },            // max reached
    { ...base, id: 4, created_at: '2026-10-20T12:00:00Z', status: 'won' },           // closed
    { ...base, id: 5, created_at: '2026-10-20T12:00:00Z', tier: 'cold' },            // cold
    { ...base, id: 6, created_at: '2026-10-20T12:00:00Z', followups: 1, last_contact: '2026-10-31T12:00:00Z' },
  ];
  const due = L.dueFollowUps(rows, NOW);
  assert.deepEqual(due.map((r) => r.id), [1, 6]);
  assert.equal(due[0].followups, 1);
  assert.equal(due[0].followup_subject, 'Quick follow-up on your request');
  assert.equal(due[1].followup_subject, 'Should I close your request?');
  assert.equal(due[0].last_contact, NOW.toISOString());
});
