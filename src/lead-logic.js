/**
 * Business logic used inside the n8n Code nodes.
 * scripts/build-workflows.js inlines these functions into the workflow JSON,
 * so the exact code that runs in n8n is the code covered by tests/lead-logic.test.js.
 */

const FREE_EMAIL_DOMAINS = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'live.com', 'proton.me', 'protonmail.com'];
const URGENT_WORDS = ['urgent', 'asap', 'this week', 'today', 'urgente', 'cuanto antes', 'esta semana', 'hoy'];
const BUDGET_RE = /(?:usd|us\$|\$|u\$s|eur|€)\s?(\d[\d.,]*)\s?(k)?|(\d[\d.,]*)\s?(k)?\s?(?:usd|dollars|dólares|dolares)/i;
const TIERS = [[70, 'hot'], [40, 'warm'], [0, 'cold']];

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Accepts the raw webhook body (form, Typeform, Webflow, Tally...) and returns a normalized lead or an error. */
function normalizeLead(raw, now) {
  const body = raw && raw.body ? raw.body : (raw || {});
  const pick = (...keys) => keys.map((k) => body[k]).find((v) => v != null && String(v).trim() !== '');
  const lead = {
    name: clean(pick('name', 'full_name', 'nombre'), 80),
    email: clean(pick('email', 'mail', 'correo'), 120).toLowerCase(),
    phone: clean(pick('phone', 'telefono', 'whatsapp'), 30).replace(/[^\d+]/g, ''),
    company: clean(pick('company', 'empresa', 'business'), 120),
    website: clean(pick('website', 'web', 'sitio'), 200),
    message: clean(pick('message', 'mensaje', 'details', 'comments'), 2000),
    source: clean(pick('source', 'utm_source'), 60) || 'website',
  };
  const errors = [];
  if (!lead.name) errors.push('name is required');
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(lead.email)) errors.push('a valid email is required');
  if (lead.message.length < 10) errors.push('message is too short');
  if (body.website_url_hp) errors.push('spam'); // honeypot field hidden in the form
  lead.id = 'L' + (now || new Date()).toISOString().replace(/\D/g, '').slice(0, 14) + '-' + lead.email.split('@')[0].slice(0, 6);
  lead.created_at = (now || new Date()).toISOString();
  lead.email_domain = lead.email.split('@')[1] || '';
  return { lead, valid: errors.length === 0, errors };
}

/** Builds the OpenAI-compatible request body for the qualification step. */
function buildAiRequest(lead, model, offer) {
  return {
    model: model || 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content:
        'You qualify inbound sales leads for this business: ' + (offer || 'a digital services agency') + '.\n' +
        'Return ONLY a JSON object with keys: fit_score (0-100 integer), intent ("buy_now"|"exploring"|"support"|"spam"|"job_seeker"|"other"), ' +
        'budget_usd (number or null), urgency ("high"|"medium"|"low"), service (short text), summary (max 25 words), ' +
        'reply (a warm, specific first reply of 60-110 words in the lead\'s language, signed "— The team", no placeholders, no prices).' },
      { role: 'user', content: JSON.stringify({ name: lead.name, company: lead.company, website: lead.website, email_domain: lead.email_domain, message: lead.message }) },
    ],
  };
}

/** Deterministic score used when the AI is unavailable, and as a sanity check. */
function ruleScore(lead) {
  const text = (lead.message || '').toLowerCase();
  let score = 20;
  const reasons = [];
  if (lead.email_domain && !FREE_EMAIL_DOMAINS.includes(lead.email_domain)) { score += 20; reasons.push('company email'); }
  if (lead.company) { score += 10; reasons.push('company given'); }
  if (lead.phone) { score += 10; reasons.push('phone given'); }
  if (text.length > 120) { score += 10; reasons.push('detailed message'); }
  const budget = parseBudget(text);
  if (budget >= 1000) { score += 20; reasons.push('budget >= 1k'); } else if (budget > 0) { score += 10; reasons.push('budget stated'); }
  if (URGENT_WORDS.some((w) => text.includes(w))) { score += 10; reasons.push('urgent'); }
  return { score: Math.min(score, 100), budget, reasons };
}

function parseBudget(text) {
  const m = String(text || '').match(BUDGET_RE);
  if (!m) return 0;
  const digits = (m[1] || m[3]).replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
  return Math.round(parseFloat(digits) * ((m[2] || m[4]) ? 1000 : 1)) || 0;
}

function tierFor(score) {
  return TIERS.find(([min]) => score >= min)[1];
}

/** Merges the AI answer (or its failure) with the rule score into one CRM row. */
function qualify(lead, aiResponse) {
  const rules = ruleScore(lead);
  let ai = null;
  try {
    const content = aiResponse && aiResponse.choices && aiResponse.choices[0].message.content;
    ai = content ? JSON.parse(content) : null;
  } catch (e) { ai = null; }

  const aiScore = ai && Number.isFinite(Number(ai.fit_score)) ? Math.max(0, Math.min(100, Math.round(Number(ai.fit_score)))) : null;
  // AI decides, but the rules can pull an obviously strong lead up (and spam always goes to 0)
  let score = aiScore == null ? rules.score : Math.round(aiScore * 0.75 + rules.score * 0.25);
  if (ai && (ai.intent === 'spam' || ai.intent === 'job_seeker')) score = Math.min(score, 10);

  const tier = tierFor(score);
  const firstName = lead.name.split(' ')[0];
  const fallbackReply = /[áéíóúñ¿¡]|hola|necesito|quiero/i.test(lead.message)
    ? `Hola ${firstName}, ¡gracias por escribirnos! Recibimos tu consulta y una persona del equipo te va a responder en menos de 24 horas hábiles con los próximos pasos.\n\n— El equipo`
    : `Hi ${firstName}, thanks for reaching out! We received your message and a member of our team will get back to you within one business day with next steps.\n\n— The team`;

  return {
    id: lead.id,
    created_at: lead.created_at,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    website: lead.website,
    source: lead.source,
    message: lead.message,
    score,
    tier,
    intent: (ai && ai.intent) || 'unknown',
    budget_usd: (ai && Number(ai.budget_usd)) || rules.budget || '',
    urgency: (ai && ai.urgency) || (rules.reasons.includes('urgent') ? 'high' : 'low'),
    service: (ai && ai.service) || '',
    summary: (ai && ai.summary) || lead.message.slice(0, 140),
    reply: (ai && typeof ai.reply === 'string' && ai.reply.length > 40) ? ai.reply : fallbackReply,
    qualified_by: ai ? 'ai+rules' : 'rules',
    status: tier === 'cold' && ai && ai.intent === 'spam' ? 'spam' : 'new',
    followups: 0,
    last_contact: '',
  };
}

/** Text for the sales alert (Slack mrkdwn). */
function alertText(row) {
  const icon = { hot: '🔥', warm: '🌤️', cold: '🧊' }[row.tier];
  return `${icon} *${row.tier.toUpperCase()} lead* (${row.score}/100): *${row.name}*${row.company ? ' — ' + row.company : ''}\n` +
    `${row.summary}\n` +
    `Budget: ${row.budget_usd ? 'USD ' + row.budget_usd : 'n/a'} · Urgency: ${row.urgency} · Intent: ${row.intent}\n` +
    `✉️ ${row.email}${row.phone ? ' · 📞 ' + row.phone : ''}`;
}

/** Picks CRM rows that need a follow-up email today. */
function dueFollowUps(rows, now, opts) {
  const o = Object.assign({ afterHours: 48, maxFollowups: 2 }, opts);
  const nowMs = (now || new Date()).getTime();
  return rows.filter((r) => {
    if (r.status !== 'new' || !r.email || r.tier === 'cold') return false;
    const count = Number(r.followups || 0);
    if (count >= o.maxFollowups) return false;
    const last = new Date(r.last_contact || r.created_at).getTime();
    return Number.isFinite(last) && nowMs - last >= o.afterHours * 3600 * 1000;
  }).map((r) => Object.assign({}, r, {
    followups: Number(r.followups || 0) + 1,
    last_contact: new Date(nowMs).toISOString(),
    followup_subject: Number(r.followups || 0) === 0 ? 'Quick follow-up on your request' : 'Should I close your request?',
    followup_body: Number(r.followups || 0) === 0
      ? `Hi ${String(r.name).split(' ')[0]},\n\nJust checking you saw our reply about "${r.service || 'your project'}". Would a 15-minute call this week help? Reply with a time that suits you.\n\n— The team`
      : `Hi ${String(r.name).split(' ')[0]},\n\nI haven't heard back, so I'll close your request for now. If the timing is better later, just reply to this email and we'll pick it up.\n\n— The team`,
  }));
}

module.exports = { normalizeLead, buildAiRequest, ruleScore, parseBudget, tierFor, qualify, alertText, dueFollowUps, FREE_EMAIL_DOMAINS };
