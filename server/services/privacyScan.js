/**
 * Exposure scan engine (issue #2144, epic #2138).
 *
 * READ-ONLY probe of each people-search broker for the user's exposure, using
 * search vectors DERIVED FROM THE VAULT (scan-eligible records only — the vault
 * hard-excludes ssn/passport/etc.). Records a per-broker verdict in the case
 * ledger (`found | not_found | indirect_exposure | blocked`). Unreadable results
 * leave the ledger untouched. An antibot wall or rate limit records `blocked`.
 *
 * Two lanes: a plain HTTP GET of the broker's search URL first (most brokers
 * render static HTML), escalating to the SSRF-pinned real-Chrome fetch
 * (`fetchUrlMainText`) only when the page needs JS. Both lanes are SSRF-vetted.
 *
 * CONSENT: `runScanPass` / `scanBroker` refuse to probe ANY broker for a
 * subject without an ACTIVE `broker_scan` grant (privacySubjects.
 * assertSubjectConsent, #3658/#8332) — a local-only `pii_vault` grant does not
 * count, because the scan puts identity values into external broker URLs. The
 * guard lives in the service, not the UI, so a scheduled recheck or a direct API
 * call is refused exactly like a hidden button would be.
 *
 * AI policy: this whole pass runs ONLY from a user-triggered endpoint or a
 * user-created cron (never at boot). LLM-assisted namesake disambiguation, if
 * added, is therefore inside a sanctioned user-triggered pass — v1 uses a pure
 * heuristic (name + location-token co-occurrence), no LLM call.
 */

import { lookup } from 'dns/promises';
import { isSafeIngestUrl, isBlockedIngestHost } from '../lib/safeUrlFetch.js';
import { fetchPublicResponse } from '../lib/safeUrlFetch.js';
import { fetchUrlMainText } from './catalog/catalogIngestSources.js';
import { listScanEligibleValues } from './privacyVault.js';
import { listBrokers, listBrokerCases, recordScanVerdict } from './privacyBrokers.js';
import { resolveSubjectId, assertSubjectConsent, dispatchWithSubjectConsent } from './privacySubjects.js';
import { parseCityState } from '../lib/cityState.js';
import { htmlToText } from '../lib/htmlToText.js';

// Case states a scan pass may (re)touch: no case yet, or a settled SCAN verdict.
// Cases mid-opt-out (optout_in_progress…awaiting_processing), confirmed_removed,
// reappeared, and human_task_queued are OWNED by the opt-out/verification engine
// (Phase 6) — a raw scan verdict must never overwrite them, so the pass skips
// them (avoids an invalid-transition throw and preserves opt-out progress).
const RESCANNABLE_STATES = new Set(['unscanned', 'found', 'not_found', 'indirect_exposure', 'blocked']);

const HTTP_FETCH_TIMEOUT_MS = 15000;
// Below this HTML length (or with an explicit JS wall marker) the static fetch
// likely saw an SPA shell — escalate to the browser lane.
const JS_SHELL_MAX_LEN = 600;
const JS_WALL_MARKERS = ['enable javascript', 'please enable js', 'noscript', '__next_data__'];
const SEARCH_RESULTS = /\b(?:no (?:matching )?(?:results|records|matches|profiles|listings)|\d+ (?:matching )?results? found)\b/i;
// Antibot / hard-challenge markers — record `blocked`, never solve. Challenge-
// specific tokens only: a bare vendor name like "cloudflare" appears in CDN
// script URLs on legitimate 200 result pages and would false-positive.
const ANTIBOT_MARKERS = [
  'captcha', 'recaptcha', 'hcaptcha', 'px-captcha', 'unusual traffic',
  'are you a human', 'cf-browser-verification', 'cf-chl', 'challenge-platform',
  'just a moment', 'access denied', 'request blocked',
  'verify you are human', 'bot detection',
];

// ─── Search vectors (pure) ──────────────────────────────────────────────────

function splitName(fullName) {
  const tokens = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0], lastName: '' };
  return { firstName: tokens[0], lastName: tokens[tokens.length - 1] };
}

/**
 * Build broker search vectors from scan-eligible vault values (the output of
 * privacyVault.listScanEligibleValues). Pure — testable without a DB. Includes
 * `previous` addresses (a broker may still carry an old one). Sensitive types
 * never appear here because the vault excludes them from `use_for_scans`.
 */
export function buildSearchVectors(scanValues = []) {
  const names = [];
  const emails = [];
  const phones = [];
  const locations = [];
  const sources = [];
  for (const v of scanValues) {
    if (!v || typeof v.value !== 'string' || !v.value.trim()) continue;
    if (v.type === 'legal_name') {
      names.push({ full: v.value.trim(), ...splitName(v.value) });
      sources.push({ id: v.id, version: v.version });
    } else if (v.type === 'email') emails.push(v.value.trim());
    else if (v.type === 'phone') phones.push(v.value.trim());
    else if (v.type === 'address') {
      const { city, state } = parseCityState(v.value);
      if (!city && !state) continue;
      locations.push({ city, state, status: v.status ?? 'current' });
      sources.push({ id: v.id, version: v.version });
    }
  }
  return { names, emails, phones, locations, sources };
}

const enc = (s) => encodeURIComponent(String(s ?? '').trim());

/**
 * Fill a broker search-URL template ({firstName}{lastName}{city}{state} tokens)
 * from one name + optional location. Returns null when the template lacks the
 * name tokens it needs. Pure.
 */
export function fillSearchUrl(template, { name, location } = {}) {
  if (typeof template !== 'string' || !template) return null;
  const first = name?.firstName || '';
  const last = name?.lastName || '';
  if (!first && !last) return null;
  return template
    .replace(/\{firstName\}/g, enc(first))
    .replace(/\{lastName\}/g, enc(last))
    .replace(/\{city\}/g, enc(location?.city || ''))
    .replace(/\{state\}/g, enc(location?.state || ''));
}

// ─── Verdict classification (pure) ──────────────────────────────────────────

function containsAntibot(html) {
  const h = html.toLowerCase();
  return ANTIBOT_MARKERS.some((m) => h.includes(m));
}

/**
 * Classify a fetched broker page against the search vectors. Pure.
 *  - HTTP 403/429 or an antibot wall → `blocked`.
 *  - Other statuses without a complete result body → inconclusive.
 *  - name + a location token (city/state) co-occur → `found`.
 *  - name alone → `indirect_exposure` (a listing may exist but the match is
 *    weaker — namesake risk).
 *  - unreadable JS shell → inconclusive (blocked for a known antibot broker).
 *  - readable search results without a match → `not_found`.
 */
export function classifyScanResult({ status, html = '', vectors = {}, broker = {} }) {
  if (status === 429) return { verdict: 'blocked', evidence: { match_basis: 'http_429', http_status: status } };
  if (status === 403 || (status === 200 && containsAntibot(html))) {
    return { verdict: 'blocked', evidence: { match_basis: 'antibot_wall', http_status: status } };
  }
  // Require a complete response: a 206 partial body cannot establish absence.
  if (status !== 200) return { verdict: null, inconclusive: true, evidence: { match_basis: `http_${status ?? 'unknown'}` } };

  const h = html.toLowerCase();
  const names = vectors.names || [];
  const locations = vectors.locations || [];
  const nameHit = names.find((n) => n.full && h.includes(n.full.toLowerCase()));
  if (nameHit) {
    const locHit = locations.find((l) => (l.city && h.includes(l.city.toLowerCase())) || (l.state && h.includes(l.state.toLowerCase())));
    if (locHit) {
      return {
        verdict: 'found',
        found: true,
        evidence: { match_basis: 'name+location', matched_name: nameHit.full, matched_location: locHit.city || locHit.state },
      };
    }
    return { verdict: 'indirect_exposure', found: null, evidence: { match_basis: 'name_only', matched_name: nameHit.full } };
  }
  // Check rendered copy rather than counting the scripts and markup in a shell.
  const pageText = htmlToText(html, { collapseSpaces: true });
  const hasResults = SEARCH_RESULTS.test(pageText);
  if (JS_WALL_MARKERS.some((m) => h.includes(m)) || (!hasResults && pageText.length < JS_SHELL_MAX_LEN)) {
    if (broker.antibot) return { verdict: 'blocked', evidence: { match_basis: 'antibot_shell' } };
    return { verdict: null, inconclusive: true, evidence: { match_basis: 'js_shell' } };
  }
  if (!hasResults) return { verdict: null, inconclusive: true, evidence: { match_basis: 'unrecognized_results' } };
  return { verdict: 'not_found', found: false, evidence: { match_basis: 'no_match' } };
}

// ─── Fetch lanes ────────────────────────────────────────────────────────────

// SSRF-vet a broker URL before the HTTP lane touches it (mirrors the catalog
// ingest gate; the browser lane vets internally via fetchUrlMainText).
async function isScanUrlSafe(target) {
  if (!isSafeIngestUrl(target)) return false;
  const { hostname } = new URL(target);
  const isIpLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (isIpLiteral) return true;
  const resolved = await lookup(hostname).catch(() => null);
  return !(resolved?.address && isBlockedIngestHost(resolved.address));
}

// Fetch failures are inconclusive. A withdrawn grant or erased subject stops the pass.
export function onBrokerFetchFailure(error) {
  if (error?.code === 'SUBJECT_CONSENT_REQUIRED' || error?.code === 'SUBJECT_NOT_FOUND') throw error;
  return null;
}

// Plain HTTP GET lane. Returns { status, html } or null on network failure.
async function httpFetchLane(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortOS-PrivacyScan/1.0)' },
    });
    if (!res) return null;
    const html = await res.text();
    return { status: res.status, html };
  } catch (error) {
    return onBrokerFetchFailure(error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * READ-ONLY probe of ONE broker for exposure — fetch + classify, NO ledger
 * write. Returns `{ verdict, found, evidence, url }` or `{ skipped, reason }`.
 * Shared by scanBroker (which then records) and the opt-out verification
 * re-scan (privacyOptOut.runVerificationPass) which must classify a broker's
 * CURRENT listing WITHOUT overwriting an opt-out-owned case's ledger state.
 * `deps` injectable so tests/verification never hit the network.
 */
export async function probeBroker(broker, vectors, {
  fetchImpl, browserFetch, urlSafe = isScanUrlSafe, subjectId, verifyingRemoval = false,
} = {}) {
  const template = broker?.urls?.search;
  const name = (vectors.names || [])[0];
  const location = (vectors.locations || [])[0];
  if (!template || !name) {
    return { skipped: true, reason: !template ? 'no_search_url' : 'no_name_vector' };
  }
  const url = fillSearchUrl(template, { name, location });
  if (!url || !(await urlSafe(url))) {
    return { skipped: true, reason: 'unsafe_or_unfillable_url' };
  }

  const scope = verifyingRemoval ? 'broker_optout' : 'broker_scan';
  const dispatchRequest = start => dispatchWithSubjectConsent(subjectId, { scope, action: 'broker exposure probe' }, start);
  // The pinned transport checks each hop after DNS, including redirects.
  const result = await httpFetchLane(url, (target, options) => fetchImpl
    ? dispatchRequest(() => fetchImpl(target, options))
    : fetchPublicResponse(target, { ...options, timeoutMs: HTTP_FETCH_TIMEOUT_MS, blockPrivate: true, throwOnUnsafe: false, dispatchRequest }));
  if (!result) return { skipped: true, reason: 'fetch_failed' };

  let classified = classifyScanResult({ ...result, vectors, broker });
  // Only the existing wall and JS rendering cases can use the browser lane.
  // A rate limit is a request to back off. If rendering yields no verdict,
  // keep the original blocked or inconclusive result.
  const needsBrowser = result.status === 403 || (result.status === 200 &&
    (classified.verdict === 'blocked' || classified.evidence.match_basis === 'js_shell'));
  if (needsBrowser) {
    const browsed = await dispatchRequest(() => browserFetch
      ? browserFetch(url)
      : fetchUrlMainText(url, { dispatchRequest })).catch(onBrokerFetchFailure);
    if (browsed) {
      const rendered = classifyScanResult({ status: browsed.status, html: browsed.text, vectors, broker });
      if (rendered.verdict) classified = rendered;
    }
  }

  // search_url lets the UI offer "check manually in your browser" on blocked
  // cases — the human IS the sanctioned path past an antibot wall.
  const evidence = { ...classified.evidence, search_url: url, listing_urls: classified.verdict === 'found' ? [url] : [] };
  if (classified.inconclusive || !classified.verdict) {
    return { skipped: true, reason: classified.evidence?.match_basis || 'inconclusive', verdict: null, evidence };
  }
  return { verdict: classified.verdict, found: classified.found ?? null, evidence, url };
}

/**
 * Scan ONE broker for exposure and record the verdict. Thin wrapper over the
 * read-only probeBroker that then writes the ledger verdict. Re-asserts the
 * subject's consent even though runScanPass already did: this is an exported
 * entry point, so a direct caller (route, agent, single-broker recheck) must not
 * be able to reach a ledger write around the gate. `deps` are
 * injectable so tests never hit the network/browser:
 *   - `fetchImpl` (default DNS-pinned fetch) — the HTTP lane.
 *   - `browserFetch` (default fetchUrlMainText) — the JS-required escalation.
 * Returns the recorded case, or `{ skipped: true, reason }` when the broker has
 * no usable search URL (blind scan not possible) or the URL is unsafe.
 */
export async function scanBroker(broker, vectors, {
  fetchImpl, browserFetch, urlSafe = isScanUrlSafe, now = new Date(),
  subjectId,
} = {}) {
  const resolvedSubjectId = resolveSubjectId(subjectId);
  await assertSubjectConsent(resolvedSubjectId, { scope: 'broker_scan', action: `broker exposure scan (${broker?.id})` });
  const probed = await probeBroker(broker, vectors, { fetchImpl, browserFetch, urlSafe, subjectId: resolvedSubjectId });
  if (probed.skipped) return { skipped: true, reason: probed.reason };
  const kase = await recordScanVerdict(broker.id, probed.verdict, {
    evidence: probed.evidence, found: probed.found ?? null, scanSources: vectors.sources, now, subjectId: resolvedSubjectId,
  });
  return kase;
}

/**
 * Run a full scan pass over enabled brokers using vault-derived vectors. Read-
 * only + idempotent (safe to re-run). Sequential with modest concurrency.
 * USER-TRIGGERED only (route / user cron) — never at boot.
 *
 * Returns a summary { scanned, verdicts: {<verdict>: n}, skipped, brokers }.
 */
export async function runScanPass({ concurrency = 3, fetchImpl, browserFetch, urlSafe = isScanUrlSafe, now = new Date(), subjectId } = {}) {
  // CONSENT GATE — BEFORE any vault read or broker fetch. A subject without an
  // active `broker_scan` grant is refused outright (403); the UI hiding the Scan
  // button is not sufficient, since a cron/API/agent caller reaches this same
  // function.
  const resolvedSubjectId = resolveSubjectId(subjectId);
  await assertSubjectConsent(resolvedSubjectId, { scope: 'broker_scan', action: 'broker exposure scan' });
  const scanValues = await listScanEligibleValues({ subjectId: resolvedSubjectId });
  const vectors = buildSearchVectors(scanValues);
  if ((vectors.names || []).length === 0) {
    console.log('🔎 Scan pass aborted: no scan-eligible name in the vault');
    return { scanned: 0, verdicts: {}, skipped: 0, brokers: 0, subjectId: resolvedSubjectId, reason: 'no_scan_vectors' };
  }
  const allBrokers = await listBrokers({ enabled: true });
  // Skip brokers whose case is owned by the opt-out engine, or whose settled
  // verdict isn't yet due for a recheck — the pass is idempotent + cheap to
  // re-run because of this filter.
  const casesByBroker = new Map((await listBrokerCases({ subjectId: resolvedSubjectId })).map((c) => [c.brokerId, c]));
  const nowMs = now.getTime();
  const brokers = allBrokers.filter((b) => {
    const kase = casesByBroker.get(b.id);
    if (!kase) return true; // never scanned
    if (!RESCANNABLE_STATES.has(kase.state)) return false; // opt-out-owned
    return !kase.nextRecheckAt || new Date(kase.nextRecheckAt).getTime() <= nowMs; // due
  });
  const verdicts = {};
  let scanned = 0;
  let skipped = 0;

  // Small concurrency pool — brokers are independent, but keep it modest so we
  // don't hammer many hosts at once.
  for (let i = 0; i < brokers.length; i += concurrency) {
    const batch = brokers.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((b) => scanBroker(b, vectors, { fetchImpl, browserFetch, urlSafe, now, subjectId: resolvedSubjectId })));
    for (const r of results) {
      if (r?.skipped) { skipped += 1; continue; }
      if (r?.state) { verdicts[r.state] = (verdicts[r.state] || 0) + 1; scanned += 1; }
    }
  }
  console.log(`🔎 Scan pass complete: ${scanned} verdicts, ${skipped} skipped across ${brokers.length} brokers`);
  return { scanned, verdicts, skipped, brokers: brokers.length, subjectId: resolvedSubjectId };
}
