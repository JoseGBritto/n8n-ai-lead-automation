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
  assert.match(lead.id, /^L20261102120000-maria-[a-z0-9]{1,4}$/);
  assert.notEqual(lead.id, L.normalizeLead(good, NOW).lead.id, 'ids are unique even in the same second');
});

test('normalizeLead accepts Spanish field names and flat bodies', () => {
  const { lead, valid } = L.normalizeLead({ nombre: 'Juan', correo: 'juan@gmail.com', mensaje: 'Necesito una web para mi pyme' }, NOW);
  assert.equal(valid, true);
  assert.equal(lead.name, 'Juan');
});

test('normalizeLead rejects bad input and honeypot spam', () => {
  const r = L.normalizeLead({ body: { name: '', email: 'nope', message: 'hi' } }, NOW);
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors, ['name is required', 'a valid email is required', 'message is too short']);
  const bot = L.normalizeLead({ body: { ...good.body, website_url_hp: 'http://spam.example' } }, NOW);
  assert.equal(bot.valid, false);
  assert.equal(bot.bot, true);
  assert.deepEqual(bot.errors, []); // nothing tells the bot it was caught
});

test('parseBudget understands common formats', () => {
  assert.equal(L.parseBudget('budget around USD 8,000'), 8000);
  assert.equal(L.parseBudget('we have USD 2.5k'), 2500);
  assert.equal(L.parseBudget('tenemos $500.000 pesos'), 0); // a bare $ may be pesos
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
  assert.equal(due[1].followup_subject, 'Should we close your request?');
  assert.ok(due[1].followup_body.includes("We haven't heard back"));
  assert.equal(due[0].last_contact, NOW.toISOString());
});


test('Tally, Typeform and Webflow payloads are understood', () => {
  const tally = { body: { eventType: 'FORM_RESPONSE', data: { fields: [
    { key: 'question_1', label: 'Full name', type: 'INPUT_TEXT', value: 'Ana Ruiz' },
    { key: 'question_2', label: 'Email', type: 'INPUT_EMAIL', value: 'ana@ruizstudio.com' },
    { key: 'question_3', label: 'Company name', type: 'INPUT_TEXT', value: 'Ruiz Studio' },
    { key: 'question_4', label: 'Tell us about your project', type: 'TEXTAREA', value: 'We need an online booking system for our studio.' },
  ] } } };
  const typeform = { body: { event_type: 'form_response', form_response: {
    definition: { fields: [{ id: 'f1', title: 'What is your name?', type: 'short_text' }, { id: 'f2', title: 'Your email', type: 'email' },
      { id: 'f3', title: 'Phone number', type: 'phone_number' }, { id: 'f4', title: 'What do you need?', type: 'long_text' }] },
    answers: [{ type: 'text', text: 'Tom Baker', field: { id: 'f1', type: 'short_text' } },
      { type: 'email', email: 'tom@bakerco.com', field: { id: 'f2', type: 'email' } },
      { type: 'phone_number', phone_number: '+14155550100', field: { id: 'f3', type: 'phone_number' } },
      { type: 'text', text: 'A chatbot that answers questions about our bakery orders.', field: { id: 'f4', type: 'long_text' } }],
  } } };
  const webflow = { body: { triggerType: 'form_submission', payload: { name: 'Contact', data: {
    Name: 'Lucía Fernández', Email: 'lucia@bodegaandes.com.ar', Message: 'Necesitamos una tienda online para vender vinos.' } } } };
  const a = L.normalizeLead(tally, NOW);
  assert.equal(a.valid, true);
  assert.equal(a.lead.name, 'Ana Ruiz');
  assert.equal(a.lead.company, 'Ruiz Studio');
  const b = L.normalizeLead(typeform, NOW);
  assert.equal(b.valid, true);
  assert.equal(b.lead.phone, '+14155550100');
  assert.match(b.lead.message, /chatbot/);
  const c = L.normalizeLead(webflow, NOW);
  assert.equal(c.valid, true);
  assert.equal(c.lead.lang, 'es');
});

test('urgency ignores negations and Spanish detection uses whole words', () => {
  assert.equal(L.isUrgent('This is urgent, we launch today'), true);
  assert.equal(L.isUrgent('Not urgent, just exploring'), false);
  assert.equal(L.isUrgent('no es urgente'), false);
  assert.equal(L.isSpanish('Hi, Nicholas here'), false);
  assert.equal(L.isSpanish('Hola, necesito una web'), true);
});

test('follow-ups are written in the lead\'s language', () => {
  const old = '2026-10-28T12:00:00Z';
  const [es] = L.dueFollowUps([{ id: 'L9', name: 'Lucía Fernández', email: 'l@x.co', tier: 'hot', status: 'new', lang: 'es', followups: 0, created_at: old }], NOW);
  assert.equal(es.followup_subject, 'Seguimiento de tu consulta');
  assert.match(es.followup_body, /^Hola Lucía,/);
  assert.match(es.followup_body, /— El equipo$/);
});
