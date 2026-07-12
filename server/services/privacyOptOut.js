/**
 * Data-broker opt-out AUTOMATION engine (issue #2145, epic #2138).
 *
 * Drives broker CASES (privacyBrokers.js ledger) through removal on top of the
 * Phase 5 scan/case backbone. Two submission lanes + a verification loop + a
 * human-task digest + a user-configured recheck schedule (privacyRecheckScheduler.js):
 *
 *   - Web-form lane  → browserService (real Chrome over CDP, SSRF-pinned nav).
 *     Detects CAPTCHA / anti-bot walls and records `blocked` — NEVER defeats
 *     them. Auto-submit is OFF by default; the default surfaces the prepared
 *     request + playbook as a `human_task_queued` digest item.
 *   - Email lane     → renders a CCPA/CPRA/GDPR/generic rights-request template,
 *     recipient LOCKED to the broker record's declared address, into the
 *     messages drafts queue. Auto-send only behind the explicit settings toggle
 *     `privacy.recheck.autoApproveOptOutEmails` (default false).
 *   - Verification   → scans the synced Gmail inbox for broker confirmation
 *     mail, anti-phishing scores it (link domain must match the broker's own
 *     domains) before advancing `submitted → verification_pending`, and a
 *     verifying re-scan (not the confirmation page) is the ONLY path to
 *     `confirmed_removed`.
 *
 * HARD GUARDRAILS (autonomy never overrides — mirrors unbroker):
 *   - Disclosure is limited to the FIXED allowlist ∩ the broker's declared
 *     disclosure_fields. The engine refuses to emit anything outside
 *     {full_name,email,phone,city,state,dob,listing_url} regardless of what a
 *     form asks. SSN / passport / financial values can never reach a broker
 *     (they are never scan-eligible, so they never enter the payload).
 *   - No CAPTCHA / anti-bot bypass. Hard challenges → `blocked` → digest.
 *   - If a form demands more than planned mid-flow → the case goes to the digest,
 *     the engine never decides to disclose extra PII.
 *
 * AI-PROVIDER POLICY: nothing here runs at boot. `runOptOutPass()` executes ONLY
 * from a user-triggered route or a user-created cron. No LLM calls in v1 (the
 * lanes are template + heuristic driven).
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { PATHS } from '../lib/fileUtils.js';
import {
  listBrokers, getBroker, listBrokerCases, transitionCase,
} from './privacyBrokers.js';
import { listScanEligibleValues } from './privacyVault.js';
import { buildSearchVectors, probeBroker } from './privacyScan.js';
import { createDraft, approveDraft } from './messageDrafts.js';
import { listAccounts } from './messageAccounts.js';
import { getMessages } from './messageSync.js';
import { getSettings } from './settings.js';

// ─── Disclosure guardrail (pure) ────────────────────────────────────────────

// The FIXED least-disclosure allowlist — the engine never emits a field outside
// this set to a broker, whatever the broker's form or disclosure_fields asks.
export const DISCLOSURE_ALLOWLIST = Object.freeze([
  'full_name', 'email', 'phone', 'city', 'state', 'dob', 'listing_url',
]);

/**
 * Build the disclosure payload from scan-eligible vault values. Only the fixed
 * allowlist keys are ever populated. Sensitive types can't appear because the
 * vault excludes them from scan-eligibility. `city`/`state` are parsed from the
 * most recent CURRENT address (falls back to any address). Pure.
 * Returns `{ full_name, email, phone, city, state, dob }` (listing_url is
 * per-case, added from the case evidence at send time).
 */
export function buildDisclosurePayload(scanValues = []) {
  const vectors = buildSearchVectors(scanValues);
  const payload = {};
  if (vectors.names[0]?.full) payload.full_name = vectors.names[0].full;
  if (vectors.emails[0]) payload.email = vectors.emails[0];
  if (vectors.phones[0]) payload.phone = vectors.phones[0];
  // Prefer a current address for city/state; fall back to the first parsed one.
  const loc = vectors.locations.find((l) => l.status === 'current') || vectors.locations[0];
  if (loc?.city) payload.city = loc.city;
  if (loc?.state) payload.state = loc.state;
  // DOB is scan-eligible only if the user opted it in; parse from the raw values.
  const dob = scanValues.find((v) => v.type === 'dob' && typeof v.value === 'string' && v.value.trim());
  if (dob) payload.dob = dob.value.trim();
  return payload;
}

/**
 * The fields this case may disclose to THIS broker: the fixed allowlist ∩ the
 * broker's declared disclosure_fields ∩ the fields we actually hold a value for.
 * `listing_url` is included only when the case has a captured listing URL. Pure.
 */
export function computeDisclosedFields(broker, payload, { listingUrls = [] } = {}) {
  const declared = Array.isArray(broker?.disclosureFields) ? broker.disclosureFields : [];
  const have = new Set(Object.keys(payload || {}));
  if (listingUrls.length) have.add('listing_url');
  return DISCLOSURE_ALLOWLIST.filter((f) => declared.includes(f) && have.has(f));
}

/** Human-readable one-line-per-field summary of the disclosed identifiers. Pure. */
export function renderDisclosedSummary(disclosedFields, payload, { listingUrls = [] } = {}) {
  const LABELS = {
    full_name: 'Full name', email: 'Email', phone: 'Phone',
    city: 'City', state: 'State', dob: 'Date of birth', listing_url: 'Listing URL',
  };
  return disclosedFields
    .filter((f) => f !== 'listing_url')
    .map((f) => `- ${LABELS[f]}: ${payload[f]}`)
    .concat(listingUrls.map((u) => `- ${LABELS.listing_url}: ${u}`))
    .join('\n');
}

// ─── Lane selection (pure) ──────────────────────────────────────────────────

/**
 * Choose the submission lane for a broker. `email` when the broker declares an
 * email channel and (its method is email OR we prefer the email lane for an
 * anti-bot-walled site with an email fallback). `web_form` when there's an
 * opt-out URL. Otherwise `human` (fax / phone / mail / gov-ID → digest). Pure.
 */
export function chooseLane(broker) {
  const optout = broker?.optout || {};
  const hasEmail = typeof optout.email === 'string' && optout.email.includes('@');
  const hasUrl = typeof optout.url === 'string' && /^https?:\/\//i.test(optout.url);
  if (optout.method === 'email') return hasEmail ? 'email' : 'human';
  // An anti-bot-walled form with an email fallback goes the email route (a web
  // submission would just hit the wall → blocked).
  if (broker?.antibot && hasEmail) return 'email';
  if (hasUrl) return 'web_form';
  if (hasEmail) return 'email';
  return 'human';
}

/**
 * Which template a broker's email lane uses. CCPA/CPRA for a CA-registry or
 * CCPA-noted broker, GDPR when the notes mention it, else generic. Pure — the
 * caller passes the disclosure payload so a CA-address subject prefers CCPA.
 */
export function chooseEmailTemplate(broker, payload = {}) {
  const notes = `${broker?.optout?.notes || ''}`.toLowerCase();
  if (notes.includes('gdpr')) return 'gdpr';
  if (notes.includes('cpra')) return 'cpra';
  if (notes.includes('ccpa') || broker?.source === 'ca_registry' || payload.state === 'CA') return 'ccpa';
  return 'generic';
}

// ─── Email template rendering ───────────────────────────────────────────────

const TEMPLATE_NAMES = Object.freeze(['ccpa', 'cpra', 'gdpr', 'generic']);
const templateCache = new Map();

async function loadTemplate(name) {
  const key = TEMPLATE_NAMES.includes(name) ? name : 'generic';
  if (templateCache.has(key)) return templateCache.get(key);
  const path = join(PATHS.root, 'data.reference', 'privacy', 'email-templates', `${key}.txt`);
  const raw = await readFile(path, 'utf8');
  templateCache.set(key, raw);
  return raw;
}

/** Fill `{{token}}` placeholders. Pure. Unknown tokens collapse to ''. */
export function fillTemplate(raw, tokens) {
  return String(raw).replace(/\{\{(\w+)\}\}/g, (_, k) => (tokens[k] ?? ''));
}

/**
 * Render an opt-out email into `{ subject, body }`. The first "Subject:" line of
 * the template becomes the subject; the remainder is the body. Recipient is NOT
 * decided here — the caller locks it to the broker's declared address.
 */
export async function renderOptOutEmail({ broker, payload, disclosedFields, listingUrls = [], now = new Date(), templateLoader = loadTemplate }) {
  const templateName = chooseEmailTemplate(broker, payload);
  const raw = await templateLoader(templateName);
  const disclosedSummary = renderDisclosedSummary(disclosedFields, payload, { listingUrls });
  const listingSection = listingUrls.length
    ? `The specific listing(s) to remove:\n${listingUrls.map((u) => `  ${u}`).join('\n')}\n`
    : '';
  const filled = fillTemplate(raw, {
    fullName: payload.full_name || 'the requesting individual',
    brokerName: broker?.name || broker?.id || 'the data broker',
    disclosedSummary,
    listingSection,
    requestDate: now.toISOString().slice(0, 10),
  });
  const lines = filled.split('\n');
  const subjectLine = lines.find((l) => l.toLowerCase().startsWith('subject:'));
  const subject = subjectLine ? subjectLine.replace(/^subject:\s*/i, '').trim() : `Opt-out request — ${broker?.name || broker?.id}`;
  const body = lines.filter((l) => l !== subjectLine).join('\n').trim();
  return { subject, body, templateName };
}

// ─── Verification anti-phishing scoring (pure) ──────────────────────────────

// Extract every http(s) link host from an email body.
function extractLinkHosts(text) {
  const hosts = new Set();
  const re = /https?:\/\/([^/\s"'>)]+)/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(String(text || ''))) !== null) {
    hosts.add(m[1].toLowerCase().replace(/^www\./, ''));
  }
  return [...hosts];
}

// The broker's own domains, from its urls.* + optout.url + optout.email.
export function brokerDomains(broker) {
  const domains = new Set();
  const addUrl = (u) => {
    if (typeof u !== 'string') return;
    const host = extractLinkHosts(u)[0];
    if (host) domains.add(host.replace(/^www\./, ''));
  };
  for (const u of Object.values(broker?.urls || {})) addUrl(u);
  addUrl(broker?.optout?.url);
  const email = broker?.optout?.email;
  if (typeof email === 'string' && email.includes('@')) {
    domains.add(email.split('@')[1].toLowerCase().replace(/^www\./, ''));
  }
  return [...domains];
}

// Registrable-ish suffix match: the link host equals a broker domain or is a
// subdomain of it (foo.spokeo.com matches spokeo.com).
function hostMatchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Score a candidate inbox message as a genuine broker confirmation. A message
 * is trusted ONLY when it carries a link whose host matches one of the broker's
 * declared domains (anti-phishing) AND its text reads like a confirmation.
 * Returns `{ isConfirmation, hasVerificationLink, verificationUrl, score, reason }`.
 * Pure.
 */
export function scoreVerificationEmail(message, broker) {
  const domains = brokerDomains(broker);
  const text = `${message?.subject || ''}\n${message?.body || message?.snippet || ''}`;
  const lower = text.toLowerCase();
  const links = extractLinkHosts(text);
  const bodyForUrls = `${message?.body || message?.snippet || ''}`;
  const urlMatches = (String(bodyForUrls).match(/https?:\/\/[^\s"'>)]+/gi) || []);

  const matchingUrl = urlMatches.find((u) => {
    const host = extractLinkHosts(u)[0];
    return host && domains.some((d) => hostMatchesDomain(host, d));
  }) || null;
  const domainMatch = links.some((h) => domains.some((d) => hostMatchesDomain(h, d)));

  const confirmWords = ['confirm', 'verify', 'verification', 'opt-out', 'opt out', 'removal', 'suppress', 'unsubscribe', 'request received'];
  const looksLikeConfirmation = confirmWords.some((w) => lower.includes(w));
  const verificationWords = ['click', 'confirm your', 'verify your', 'to complete', 'confirmation link'];
  const hasVerificationLink = Boolean(matchingUrl) && verificationWords.some((w) => lower.includes(w));

  let score = 0;
  if (domainMatch) score += 0.6;
  if (looksLikeConfirmation) score += 0.3;
  if (hasVerificationLink) score += 0.1;

  return {
    isConfirmation: domainMatch && looksLikeConfirmation,
    hasVerificationLink,
    verificationUrl: hasVerificationLink ? matchingUrl : null,
    score: Math.round(score * 100) / 100,
    reason: !domainMatch ? 'no_domain_match' : (!looksLikeConfirmation ? 'not_confirmation_text' : 'ok'),
  };
}

// ─── Lane executors (side-effecting; injectable) ────────────────────────────

/**
 * WEB-FORM lane. Default-safe: prepares the request and queues it as a human
 * task with the playbook + prepared disclosure, UNLESS auto-submit is enabled.
 * When enabled, it SSRF-pin-navigates the opt-out URL, detects an anti-bot wall
 * (→ `blocked`, never defeated) and otherwise records `submitted` with screenshot
 * evidence. A form that demands more than planned mid-flow → `human_task_queued`
 * (never discloses extra PII). Deps injectable so the run loop is testable.
 */
export async function webFormLane(broker, kase, { disclosedFields, payload, listingUrls, autoSubmit = false, probe = null, now = new Date() }) {
  const optoutUrl = broker?.optout?.url;
  const evidence = {
    lane: 'web_form', optout_url: optoutUrl || null,
    playbook: broker?.optout?.playbook || [], disclosed: disclosedFields,
  };
  // Default (auto-submit off): surface as a human task — the user runs the
  // playbook with the prepared identifiers. Honest, and never touches a CAPTCHA.
  if (!autoSubmit || !optoutUrl) {
    await transitionCase(kase.id, 'human_task_queued', {
      channel: 'web_form', disclosedFields, evidence: { ...evidence, requires: 'manual_submit' },
      reason: !optoutUrl ? 'no_optout_url' : 'auto_submit_disabled', now,
    });
    return { caseId: kase.id, lane: 'web_form', outcome: 'human_task_queued' };
  }
  // Auto-submit path: probe the page (injectable — real impl drives CDP).
  const result = probe ? await probe(optoutUrl, { broker, disclosedFields, payload, listingUrls }).catch((e) => ({ outcome: 'error', error: e?.message })) : { outcome: 'unavailable' };
  if (result.outcome === 'blocked') {
    // `blocked` is only reachable from a settled SCAN verdict (found / indirect /
    // not_found). A `reappeared` case can't transition straight to blocked, so it
    // goes to the digest as a human task with the wall reason instead — same
    // net effect (a person must act), and it never trips the state machine.
    const canBlock = ['found', 'indirect_exposure', 'not_found'].includes(kase.state);
    const to = canBlock ? 'blocked' : 'human_task_queued';
    await transitionCase(kase.id, to, { channel: 'web_form', reason: 'antibot_wall', evidence: { ...evidence, ...result.evidence }, now });
    return { caseId: kase.id, lane: 'web_form', outcome: to };
  }
  if (result.outcome === 'submitted') {
    await transitionCase(kase.id, 'optout_in_progress', { channel: 'web_form', disclosedFields, evidence, now });
    const submitted = await transitionCase(kase.id, 'submitted', { channel: 'web_form', evidence: { ...evidence, screenshot: result.screenshot || null, confirmation: result.confirmation || null }, now });
    return { caseId: kase.id, lane: 'web_form', outcome: 'submitted', case: submitted };
  }
  // Unexpected extra challenge / unavailable → human digest, no extra disclosure.
  await transitionCase(kase.id, 'human_task_queued', { channel: 'web_form', disclosedFields, evidence: { ...evidence, requires: 'manual_submit', probe: result.outcome }, reason: result.outcome === 'error' ? 'probe_error' : 'needs_human', now });
  return { caseId: kase.id, lane: 'web_form', outcome: 'human_task_queued' };
}

/**
 * EMAIL lane. Renders the rights-request template, LOCKS the recipient to the
 * broker's declared address, and creates a `draft` in the messages queue.
 * Auto-approve+send only when `autoApprove` (settings toggle) is on. Transitions
 * the case `optout_in_progress → submitted`. Deps injectable.
 */
export async function emailLane(broker, kase, {
  disclosedFields, payload, listingUrls = [], autoApprove = false, now = new Date(),
  accountsProvider = listAccounts, draftCreator = createDraft, draftApprover = approveDraft, sender = null,
}) {
  const to = broker?.optout?.email;
  if (typeof to !== 'string' || !to.includes('@')) {
    await transitionCase(kase.id, 'human_task_queued', { channel: 'email', reason: 'no_broker_email', now });
    return { caseId: kase.id, lane: 'email', outcome: 'human_task_queued' };
  }
  const accounts = await accountsProvider();
  const account = accounts.find((a) => a.type === 'gmail') ?? accounts[0];
  if (!account) {
    await transitionCase(kase.id, 'human_task_queued', { channel: 'email', reason: 'no_message_account', now });
    return { caseId: kase.id, lane: 'email', outcome: 'human_task_queued' };
  }
  const { subject, body, templateName } = await renderOptOutEmail({ broker, payload, disclosedFields, listingUrls, now });
  const draft = await draftCreator({
    accountId: account.id,
    to: [to], // recipient LOCKED to the broker's declared address
    subject,
    body,
    generatedBy: 'privacy-optout',
    sendVia: account.type === 'gmail' ? 'api' : 'playwright',
  });

  await transitionCase(kase.id, 'optout_in_progress', { channel: 'email', disclosedFields, evidence: { lane: 'email', to, template: templateName, draftId: draft.id, disclosed: disclosedFields }, now });

  let sent = false;
  if (autoApprove) {
    // Standing-authorization auto-send (settings opt-in). Approve then dispatch.
    await draftApprover(draft.id);
    if (sender) {
      const res = await sender(draft.id).catch((e) => ({ success: false, error: e?.message }));
      sent = Boolean(res?.success);
    }
  }
  const submitted = await transitionCase(kase.id, 'submitted', {
    channel: 'email',
    evidence: { lane: 'email', to, template: templateName, draftId: draft.id, autoApproved: autoApprove, sent, disclosed: disclosedFields },
    now,
  });
  return { caseId: kase.id, lane: 'email', outcome: 'submitted', draftId: draft.id, autoApproved: autoApprove, sent, case: submitted };
}

// ─── Planner (pure) ─────────────────────────────────────────────────────────

// States the opt-out pass acts on for a NEW submission. `found`/`indirect_exposure`
// are the actionable exposures; a `reappeared` case (re-listed after removal) is
// re-worked too.
const SUBMITTABLE = new Set(['found', 'indirect_exposure', 'reappeared']);
// States whose verification the pass polls forward.
const VERIFY_POLL = new Set(['submitted', 'verification_pending', 'awaiting_processing']);

/**
 * Order the actionable cases: cluster PARENTS first (one suppression covers the
 * children), then `found` before `indirect_exposure`, then by broker name. Pure.
 * `casesWithBroker` is `[{ case, broker }]`.
 */
export function planOptOutActions(casesWithBroker = []) {
  const submit = casesWithBroker.filter(({ case: c }) => SUBMITTABLE.has(c.state));
  const verify = casesWithBroker.filter(({ case: c }) => VERIFY_POLL.has(c.state));
  const stateRank = { found: 0, reappeared: 0, indirect_exposure: 1 };
  submit.sort((a, b) => {
    const pa = a.broker?.clusterParent ? 1 : 0;
    const pb = b.broker?.clusterParent ? 1 : 0;
    if (pa !== pb) return pa - pb; // parents (no clusterParent) first
    const ra = stateRank[a.case.state] ?? 2;
    const rb = stateRank[b.case.state] ?? 2;
    if (ra !== rb) return ra - rb;
    return String(a.broker?.name || '').localeCompare(String(b.broker?.name || ''));
  });
  return { submit, verify };
}

// ─── Verification pass ──────────────────────────────────────────────────────

/**
 * Poll the synced inbox for a broker confirmation for each `submitted` case and
 * advance it to `verification_pending` (anti-phishing gated). Then a verifying
 * re-scan of `verification_pending`/`awaiting_processing` cases decides
 * `confirmed_removed` (not_found) — the ONLY path to that state — leaving a
 * still-listed case in place. Deps injectable (no network in tests).
 */
export async function runVerificationPass({
  now = new Date(), messagesProvider = getMessages, removalProbe = probeBroker, probeDeps = {},
} = {}) {
  const cases = await listBrokerCases();
  const advanced = [];
  const confirmed = [];
  // 1. submitted → verification_pending when a trusted confirmation email exists.
  const submitted = cases.filter((c) => c.state === 'submitted');
  if (submitted.length) {
    const inbox = await messagesProvider({ limit: 200 }).catch(() => ({ messages: [] }));
    const messages = inbox?.messages || [];
    for (const c of submitted) {
      const broker = await getBroker(c.brokerId);
      if (!broker) continue;
      const hit = messages.map((m) => ({ m, s: scoreVerificationEmail(m, broker) })).find(({ s }) => s.isConfirmation);
      if (hit) {
        await transitionCase(c.id, 'verification_pending', {
          channel: c.channel || undefined,
          evidence: { ...(c.evidence || {}), verification: { messageId: hit.m.id, url: hit.s.verificationUrl, score: hit.s.score } },
          now,
        });
        advanced.push({ caseId: c.id, brokerId: c.brokerId, verificationUrl: hit.s.verificationUrl });
      }
    }
  }
  // 2. verifying re-scan → confirmed_removed (not_found only) for verification_pending/awaiting_processing.
  const toVerify = (await listBrokerCases()).filter((c) => c.state === 'verification_pending' || c.state === 'awaiting_processing');
  if (toVerify.length) {
    const scanValues = await listScanEligibleValues();
    const vectors = buildSearchVectors(scanValues);
    for (const c of toVerify) {
      const broker = await getBroker(c.brokerId);
      if (!broker) continue;
      // READ-ONLY probe (no ledger write) — a raw scan verdict is gated out of
      // opt-out-owned states, so probeBroker classifies the CURRENT listing
      // without touching the case. `not_found` is the ONLY path to confirmed.
      const probed = await removalProbe(broker, vectors, probeDeps).catch(() => null);
      if (probed && !probed.skipped && probed.verdict === 'not_found') {
        await transitionCase(c.id, 'confirmed_removed', { viaRescan: true, evidence: { ...(c.evidence || {}), verifiedRemovedAt: now.toISOString() }, now });
        confirmed.push({ caseId: c.id, brokerId: c.brokerId });
      }
    }
  }
  console.log(`✅ Verification pass: ${advanced.length} advanced, ${confirmed.length} confirmed removed`);
  return { advanced, confirmed };
}

// ─── Main run loop ──────────────────────────────────────────────────────────

/**
 * Run one opt-out pass. USER-TRIGGERED (route) or USER-SCHEDULED (cron) ONLY.
 * Order (per design): refresh already handled by scan; here we (1) submit
 * `found` cluster-parents-first via the chosen lane, (2) email `indirect_exposure`,
 * (3) poll verifications, (4) leave `blocked`/`human_task_queued` for the digest.
 *
 * Reads submission autonomy from settings (`privacy.recheck.autoApproveOptOutEmails`,
 * `privacy.recheck.autoSubmitWebForms`, both default OFF). Deps injectable.
 */
export async function runOptOutPass({
  now = new Date(), settingsProvider = getSettings, deps = {}, runVerification = true,
} = {}) {
  const settings = await settingsProvider();
  const recheck = settings?.privacy?.recheck || {};
  const autoApprove = recheck.autoApproveOptOutEmails === true;
  const autoSubmit = recheck.autoSubmitWebForms === true;

  const scanValues = await listScanEligibleValues();
  const payload = buildDisclosurePayload(scanValues);
  if (!payload.full_name) {
    console.log('📋 Opt-out pass aborted: no scan-eligible name in the vault');
    return { submitted: [], skipped: 0, verification: null, reason: 'no_disclosure_identity' };
  }

  const [brokers, cases] = await Promise.all([listBrokers({ enabled: true }), listBrokerCases()]);
  const brokerById = new Map(brokers.map((b) => [b.id, b]));
  const casesWithBroker = cases
    .map((c) => ({ case: c, broker: brokerById.get(c.brokerId) }))
    .filter((x) => x.broker);
  const { submit } = planOptOutActions(casesWithBroker);

  const submitted = [];
  let skipped = 0;
  for (const { case: kase, broker } of submit) {
    const listingUrls = Array.isArray(kase.evidence?.listing_urls) ? kase.evidence.listing_urls : [];
    const disclosedFields = computeDisclosedFields(broker, payload, { listingUrls });
    const lane = chooseLane(broker);
    if (lane === 'human') {
      await transitionCase(kase.id, 'human_task_queued', { reason: 'human_only_channel', channel: broker.optout?.method || 'unknown', now });
      submitted.push({ caseId: kase.id, brokerId: broker.id, lane: 'human', outcome: 'human_task_queued' });
      continue;
    }
    if (disclosedFields.filter((f) => f !== 'listing_url').length === 0) {
      // Nothing safe to disclose — don't submit an empty request.
      skipped += 1;
      continue;
    }
    const result = lane === 'email'
      ? await emailLane(broker, kase, { disclosedFields, payload, listingUrls, autoApprove, now, ...(deps.email || {}) })
      : await webFormLane(broker, kase, { disclosedFields, payload, listingUrls, autoSubmit, now, ...(deps.webForm || {}) });
    submitted.push({ brokerId: broker.id, ...result });
  }

  const verification = runVerification
    ? await runVerificationPass({ now, ...(deps.verification || {}) })
    : null;

  console.log(`📋 Opt-out pass: ${submitted.length} actioned, ${skipped} skipped (autoApprove=${autoApprove}, autoSubmit=${autoSubmit})`);
  return { submitted, skipped, verification, autonomy: { autoApprove, autoSubmit } };
}

// ─── Human-task digest ──────────────────────────────────────────────────────

/**
 * Aggregate the cases that need a human: `human_task_queued` (auto-submit off,
 * fax/phone/gov-ID channels, mid-flow surprises) and `blocked` (anti-bot walls).
 * Each item carries the broker, the reason, the prepared disclosure, and the
 * playbook so the UI digest is an actionable checklist. Read-only.
 */
export async function getOptOutDigest() {
  const [human, blocked] = await Promise.all([
    listBrokerCases({ state: 'human_task_queued' }),
    listBrokerCases({ state: 'blocked' }),
  ]);
  const toItem = (c) => ({
    caseId: c.id,
    brokerId: c.brokerId,
    brokerName: c.brokerName,
    state: c.state,
    // Passed through from listBrokerCases' rowToCase (server-derived legal
    // manual moves) so the digest action strip filters the same as the drawer.
    allowedTransitions: c.allowedTransitions,
    reason: c.reason || null,
    channel: c.channel || null,
    disclosedFields: c.disclosedFields || [],
    optoutUrl: c.evidence?.optout_url || null,
    // Filled broker-search URL for blocked cases — lets the digest offer
    // "check manually in your browser" (the sanctioned path past a bot wall).
    searchUrl: c.evidence?.search_url || null,
    playbook: c.evidence?.playbook || [],
    nextRecheckAt: c.nextRecheckAt,
  });
  const items = [...human.map(toItem), ...blocked.map(toItem)];
  return {
    total: items.length,
    humanTasks: human.length,
    blocked: blocked.length,
    items,
  };
}
