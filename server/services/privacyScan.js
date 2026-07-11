/**
 * Exposure scan engine (issue #2144, epic #2138).
 *
 * READ-ONLY probe of each people-search broker for the user's exposure, using
 * search vectors DERIVED FROM THE VAULT (scan-eligible records only — the vault
 * hard-excludes ssn/passport/etc.). Records a per-broker verdict in the case
 * ledger (`found | not_found | indirect_exposure | blocked`); a 404 is
 * INCONCLUSIVE (leaves the case unscanned) and an antibot wall records `blocked`
 * — NEVER bypassed (no CAPTCHA/anti-bot defeat, per the design's hard rule).
 *
 * Two lanes: a plain HTTP GET of the broker's search URL first (most brokers
 * render static HTML), escalating to the SSRF-pinned real-Chrome fetch
 * (`fetchUrlMainText`) only when the page needs JS. Both lanes are SSRF-vetted.
 *
 * AI policy: this whole pass runs ONLY from a user-triggered endpoint or a
 * user-created cron (never at boot). LLM-assisted namesake disambiguation, if
 * added, is therefore inside a sanctioned user-triggered pass — v1 uses a pure
 * heuristic (name + location-token co-occurrence), no LLM call.
 */

import { lookup } from 'dns/promises';
import { isSafeIngestUrl, isBlockedIngestHost } from '../lib/catalogValidation.js';
import { fetchUrlMainText } from './catalogIngestSources.js';
import { listScanEligibleValues } from './privacyVault.js';
import { listBrokers, listBrokerCases, recordScanVerdict } from './privacyBrokers.js';

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

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/**
 * Parse an address value into { city, state } best-effort. Handles the common
 * "123 Main St, Portland, OR 97201" and "Portland, OR" shapes; returns nulls
 * when it can't find a 2-letter state token.
 */
export function parseCityState(address) {
  if (typeof address !== 'string' || !address.trim()) return { city: null, state: null };
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  let state = null;
  let city = null;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const tokens = parts[i].split(/\s+/);
    const stTok = tokens.find((t) => US_STATES.has(t.toUpperCase()));
    if (stTok) {
      state = stTok.toUpperCase();
      // City is the comma-part immediately before the state part (or the part's
      // leading tokens if state shares the part).
      if (i > 0) city = parts[i - 1];
      else if (tokens.length > 1) city = tokens.slice(0, tokens.indexOf(stTok)).join(' ') || null;
      break;
    }
  }
  return { city: city || null, state };
}

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
  for (const v of scanValues) {
    if (!v || typeof v.value !== 'string' || !v.value.trim()) continue;
    if (v.type === 'legal_name') names.push({ full: v.value.trim(), ...splitName(v.value) });
    else if (v.type === 'email') emails.push(v.value.trim());
    else if (v.type === 'phone') phones.push(v.value.trim());
    else if (v.type === 'address') {
      const { city, state } = parseCityState(v.value);
      if (city || state) locations.push({ city, state, status: v.status ?? 'current' });
    }
  }
  return { names, emails, phones, locations };
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

function looksLikeJsShell(html) {
  if (!html || html.length < JS_SHELL_MAX_LEN) return true;
  const h = html.toLowerCase();
  return JS_WALL_MARKERS.some((m) => h.includes(m));
}

/**
 * Classify a fetched broker page against the search vectors. Pure.
 *  - HTTP 404 → INCONCLUSIVE (verdict null): the case stays `unscanned`.
 *  - antibot wall (or a 403) → `blocked` (never bypassed).
 *  - name + a location token (city/state) co-occur → `found`.
 *  - name alone → `indirect_exposure` (a listing may exist but the match is
 *    weaker — namesake risk).
 *  - otherwise → `not_found`.
 * `broker.antibot` tips a short/blank page toward `blocked` rather than
 * `not_found` (the wall likely hid the result).
 */
export function classifyScanResult({ status, html = '', vectors = {}, broker = {} }) {
  if (status === 404) return { verdict: null, inconclusive: true, evidence: { match_basis: 'http_404' } };
  if (status === 403 || containsAntibot(html)) {
    return { verdict: 'blocked', evidence: { match_basis: 'antibot_wall', http_status: status } };
  }
  if (status && status >= 500) return { verdict: null, inconclusive: true, evidence: { match_basis: `http_${status}` } };

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
  if (broker.antibot && looksLikeJsShell(html)) {
    return { verdict: 'blocked', evidence: { match_basis: 'antibot_shell' } };
  }
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

// Plain HTTP GET lane. Returns { status, html } or null on network failure.
async function httpFetchLane(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_FETCH_TIMEOUT_MS);
  const res = await fetchImpl(url, {
    signal: controller.signal,
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortOS-PrivacyScan/1.0)' },
  }).catch(() => null);
  clearTimeout(timer);
  if (!res) return null;
  const html = await res.text().catch(() => '');
  return { status: res.status, html };
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
  fetchImpl = fetch, browserFetch = fetchUrlMainText, urlSafe = isScanUrlSafe,
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

  const result = await httpFetchLane(url, fetchImpl);
  let html = result?.html ?? '';
  let status = result?.status ?? null;

  // Escalate to the pinned browser lane when the static fetch saw a JS shell,
  // OR hit a bot wall (403/antibot markers). A real-Chrome fetch is a
  // legitimate client that passes many PASSIVE bot checks — an interactive
  // challenge in the browsed page still classifies as `blocked` below (never
  // solved). On a wall, only adopt substantive browsed content: a shell-length
  // browsed page would otherwise flip a real wall into a false `not_found`.
  // 404/5xx stay out of the wall gate even when the error page carries an
  // incidental antibot token — those statuses are inconclusive by contract
  // (classifyScanResult), and escalating them could adopt a substantive error
  // page as a definitive not_found.
  const walled = result && (status === 403 || (status < 400 && containsAntibot(html)));
  const jsShell = result && !walled && status >= 200 && status < 400 && looksLikeJsShell(html);
  if (walled || jsShell) {
    const browsed = await browserFetch(url).catch(() => null);
    if (browsed?.text) {
      if (jsShell || !looksLikeJsShell(browsed.text)) {
        html = browsed.text;
        status = 200;
      } else {
        // Wall + shell-length browsed text: adopt only when it carries a
        // positive name signal — a concise page naming the person is a real
        // result, while a short page without it is indistinguishable from a
        // challenge shell and must stay `blocked` (never become not_found).
        const peek = classifyScanResult({ status: 200, html: browsed.text, vectors, broker });
        if (peek.verdict === 'found' || peek.verdict === 'indirect_exposure') {
          html = browsed.text;
          status = 200;
        }
      }
    }
  }

  if (!result && !html) {
    // Total network failure — inconclusive.
    return { skipped: true, reason: 'fetch_failed' };
  }

  const classified = classifyScanResult({ status, html, vectors, broker });
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
 * read-only probeBroker that then writes the ledger verdict. `deps` are
 * injectable so tests never hit the network/browser:
 *   - `fetchImpl` (default global fetch) — the HTTP lane.
 *   - `browserFetch` (default fetchUrlMainText) — the JS-required escalation.
 * Returns the recorded case, or `{ skipped: true, reason }` when the broker has
 * no usable search URL (blind scan not possible) or the URL is unsafe.
 */
export async function scanBroker(broker, vectors, {
  fetchImpl = fetch, browserFetch = fetchUrlMainText, urlSafe = isScanUrlSafe, now = new Date(),
} = {}) {
  const probed = await probeBroker(broker, vectors, { fetchImpl, browserFetch, urlSafe });
  if (probed.skipped) return { skipped: true, reason: probed.reason };
  const kase = await recordScanVerdict(broker.id, probed.verdict, {
    evidence: probed.evidence, found: probed.found ?? null, now,
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
export async function runScanPass({ concurrency = 3, fetchImpl = fetch, browserFetch = fetchUrlMainText, urlSafe = isScanUrlSafe, now = new Date() } = {}) {
  const scanValues = await listScanEligibleValues();
  const vectors = buildSearchVectors(scanValues);
  if ((vectors.names || []).length === 0) {
    console.log('🔎 Scan pass aborted: no scan-eligible name in the vault');
    return { scanned: 0, verdicts: {}, skipped: 0, brokers: 0, reason: 'no_scan_vectors' };
  }
  const allBrokers = await listBrokers({ enabled: true });
  // Skip brokers whose case is owned by the opt-out engine, or whose settled
  // verdict isn't yet due for a recheck — the pass is idempotent + cheap to
  // re-run because of this filter.
  const casesByBroker = new Map((await listBrokerCases()).map((c) => [c.brokerId, c]));
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
    const results = await Promise.all(batch.map((b) => scanBroker(b, vectors, { fetchImpl, browserFetch, urlSafe, now })));
    for (const r of results) {
      if (r?.skipped) { skipped += 1; continue; }
      if (r?.state) { verdicts[r.state] = (verdicts[r.state] || 0) + 1; scanned += 1; }
    }
  }
  console.log(`🔎 Scan pass complete: ${scanned} verdicts, ${skipped} skipped across ${brokers.length} brokers`);
  return { scanned, verdicts, skipped, brokers: brokers.length };
}
