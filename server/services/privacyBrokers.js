/**
 * Data-broker database + case ledger (issue #2144, epic #2138).
 *
 * Storage: `db-primary` — machine-local, never federated, by product guarantee (see below).
 * Broker-case evidence identity is sealed with the vault key and erased on removal.
 *
 * `privacy_brokers` is the curated
 * (+ later BADBOOL / CA-registry) database of people-search brokers the
 * exposure-scan / opt-out engine works; `privacy_broker_cases` is the per-broker
 * ledger with a SERVICE-ENFORCED state machine. Machine-local — no federation,
 * no tombstones. NEVER federated, by decision rather than deferral: ADR
 * docs/decisions/2026-08-08-privacy-records-machine-local.md (#2148). The case
 * ledger is additionally single-writer — two peers working the same broker
 * would double-submit opt-outs against it.
 *
 * Boot policy (AGENTS.md — no cold-bootstrap network/LLM): NOTHING here runs at
 * server boot. The curated seed is loaded LAZILY from
 * data.reference/privacy/brokers.json on first read (`ensureSeeded`); the
 * `refreshBrokers()` network pull is user-triggered ONLY. Curated rows
 * (`source=curated`) are never clobbered by an auto refresh.
 *
 * This module also owns the PURE case state machine + recheck backoff
 * (exported for the scan/opt-out engines and unit tests) — the issue allows it
 * to live here rather than a separate privacyCaseStates.js.
 */

import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS } from '../lib/fileUtils.js';
import { isSafeHref } from '../lib/isSafeHref.js';
import { fetchPublicResponse } from '../lib/safeUrlFetch.js';
import { resolveSubjectId } from './privacySubjects.js';
import { encryptValue, decryptValue, ensureVaultKey } from '../lib/vaultCrypto.js';
import { toPgJson } from '../lib/pgJson.js';

// Cap on each registry fetch so a hung broker source can't stall a
// user-triggered refresh indefinitely (both fetchers run under Promise.all).
const BROKER_FETCH_TIMEOUT_MS = 15000;

// ─── Case state machine (pure) ──────────────────────────────────────────────

export const CASE_STATES = Object.freeze([
  'unscanned',
  'found', 'not_found', 'indirect_exposure', 'blocked',
  'optout_in_progress', 'submitted', 'verification_pending', 'awaiting_processing',
  'confirmed_removed', 'human_task_queued', 'reappeared',
]);

// Verdicts a scan pass may record on an `unscanned` (or re-scanned) case.
export const SCAN_VERDICTS = Object.freeze(['found', 'not_found', 'indirect_exposure', 'blocked']);

// Normal (non-special) transitions. `human_task_queued` (reachable from ANY
// state), `confirmed_removed` (rescan-verification ONLY), and `reappeared`
// (confirmed_removed + rescan ONLY) are handled as special cases in
// assertTransition — they are intentionally NOT listed here.
const STATE_TRANSITIONS = Object.freeze({
  unscanned: ['found', 'not_found', 'indirect_exposure', 'blocked'],
  // A re-scan of a settled verdict can change it.
  found: ['optout_in_progress', 'not_found', 'indirect_exposure', 'blocked'],
  indirect_exposure: ['optout_in_progress', 'found', 'not_found', 'blocked'],
  not_found: ['found', 'indirect_exposure', 'blocked'],
  blocked: ['found', 'not_found', 'indirect_exposure', 'optout_in_progress'],
  optout_in_progress: ['submitted'],
  submitted: ['verification_pending'],
  verification_pending: ['awaiting_processing'],
  awaiting_processing: ['human_task_queued', 'found'],
  // Post-removal / requeue paths resume opt-out work.
  human_task_queued: [
    'found', 'not_found', 'indirect_exposure', 'blocked',
    'optout_in_progress', 'submitted', 'verification_pending', 'awaiting_processing',
  ],
  reappeared: ['optout_in_progress'],
  confirmed_removed: [],
});

// State-dependent recheck backoff (days). `unscanned` → recheck immediately.
const RECHECK_BACKOFF_DAYS = Object.freeze({
  unscanned: 0,
  found: 1,
  indirect_exposure: 1,
  optout_in_progress: 1,
  submitted: 3,
  verification_pending: 3,
  awaiting_processing: 7,
  confirmed_removed: 30,
  not_found: 60,
  blocked: 14,
  human_task_queued: 14,
  reappeared: 1,
});

/**
 * Assert a case may move `from → to`. Throws a 400 ServerError on an invalid
 * transition. `viaRescan` gates the two verification-only targets:
 *  - `confirmed_removed` is reachable ONLY from a verifying re-scan (never from
 *    a submission confirmation page) — the design's hard rule.
 *  - `reappeared` is reachable ONLY from `confirmed_removed` via a re-scan hit.
 */
export function assertTransition(from, to, { viaRescan = false } = {}) {
  if (!CASE_STATES.includes(to)) {
    throw new ServerError(`Unknown case state "${to}"`, { status: 400, code: 'INVALID_CASE_STATE' });
  }
  if (!CASE_STATES.includes(from)) {
    throw new ServerError(`Unknown case state "${from}"`, { status: 400, code: 'INVALID_CASE_STATE' });
  }
  if (from === to) return; // idempotent re-stamp
  if (to === 'human_task_queued') return; // any state → human task digest
  if (to === 'confirmed_removed') {
    if (!viaRescan) {
      throw new ServerError(
        'confirmed_removed is only reachable from a verifying re-scan',
        { status: 400, code: 'CONFIRMED_REQUIRES_RESCAN' },
      );
    }
    if (!['verification_pending', 'awaiting_processing', 'human_task_queued'].includes(from)) {
      throw new ServerError(
        `Invalid transition ${from} → confirmed_removed`,
        { status: 400, code: 'INVALID_STATE_TRANSITION' },
      );
    }
    return;
  }
  if (to === 'reappeared') {
    if (from !== 'confirmed_removed' || !viaRescan) {
      throw new ServerError(
        'reappeared is only reachable from confirmed_removed via a re-scan hit',
        { status: 400, code: 'INVALID_STATE_TRANSITION' },
      );
    }
    return;
  }
  if (!(STATE_TRANSITIONS[from] || []).includes(to)) {
    throw new ServerError(
      `Invalid transition ${from} → ${to}`,
      { status: 400, code: 'INVALID_STATE_TRANSITION' },
    );
  }
}

/**
 * The manual (non-rescan, human-initiable) target states legally reachable from
 * `state`, derived from the SAME rules `assertTransition` enforces so the two
 * can't drift. Folds in the special cases: `human_task_queued` is reachable from
 * ANY state (queue-a-human), while `confirmed_removed` and `reappeared` are
 * rescan-only and therefore intentionally EXCLUDED — a person can't initiate
 * them from the UI (only a verifying re-scan can). Drops the idempotent
 * self-transition. Returned in canonical `CASE_STATES` order.
 *
 * This is the authoritative list the client action strips filter against, so the
 * UI structurally cannot offer an illegal transition (the original blocked →
 * submitted bug) and cannot drift from the server's state machine.
 */
export function allowedTransitionsFor(state) {
  const reachable = new Set(STATE_TRANSITIONS[state] || []);
  reachable.add('human_task_queued'); // any state → human-task digest
  reachable.delete(state);            // no idempotent self-transition
  reachable.delete('confirmed_removed'); // rescan-only, not human-initiable
  reachable.delete('reappeared');        // rescan-only, not human-initiable
  return CASE_STATES.filter((s) => reachable.has(s));
}

/** ISO timestamp for the next recheck given the state (state-dependent backoff). */
export function computeNextRecheckAt(state, now = new Date()) {
  const days = RECHECK_BACKOFF_DAYS[state] ?? 14;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Broker rows ────────────────────────────────────────────────────────────

const BROKER_COLUMNS = `id, name, urls, optout, tier, disclosure_fields,
  cluster_parent, prefer_suppression, antibot, source, confidence,
  to_char(last_verified, 'YYYY-MM-DD') AS last_verified, enabled,
  created_at, updated_at`;

function rowToBroker(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    // Previously imported rows may still contain feed-supplied automation.
    urls: row.source === 'curated' ? (row.urls ?? {}) : discoveredHome(row.urls?.home),
    optout: row.source === 'curated' ? (row.optout ?? {}) : {},
    tier: row.tier,
    disclosureFields: row.disclosure_fields ?? [],
    clusterParent: row.cluster_parent,
    preferSuppression: row.prefer_suppression,
    antibot: row.antibot,
    source: row.source,
    confidence: row.confidence,
    lastVerified: row.last_verified ?? null,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Slug an auto-discovered broker name into a stable id token.
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const discoveredHome = (url) => isSafeHref(url) ? { home: url } : {};

// A broker record from any source, normalized to the row shape. Defensive:
// tolerates a sparse auto-discovered entry (BADBOOL / CA registry).
function normalizeBroker(b) {
  return {
    id: String(b.id),
    name: b.name ?? b.id,
    urls: b.urls ?? {},
    optout: b.optout ?? {},
    tier: Number.isInteger(b.tier) ? b.tier : 2,
    disclosureFields: Array.isArray(b.disclosure_fields) ? b.disclosure_fields
      : (Array.isArray(b.disclosureFields) ? b.disclosureFields : []),
    clusterParent: b.cluster_parent ?? b.clusterParent ?? null,
    preferSuppression: b.prefer_suppression ?? b.preferSuppression ?? false,
    antibot: b.antibot ?? false,
    source: b.source ?? 'curated',
    confidence: b.confidence ?? 'documented',
    lastVerified: b.last_verified ?? b.lastVerified ?? null,
    enabled: b.enabled !== false,
  };
}

// Upsert one broker; when `onlyIfNotCurated` is set the DO UPDATE is skipped for
// a row already marked curated (the refresh never clobbers field-verified data).
// When `onlyIfCurated` is set, the DO UPDATE is only performed for curated rows.
async function upsertBroker(client, b, { onlyIfNotCurated = false, onlyIfCurated = false } = {}) {
  let guard = '';
  if (onlyIfNotCurated) guard = `WHERE privacy_brokers.source <> 'curated'`;
  else if (onlyIfCurated) guard = `WHERE privacy_brokers.source = 'curated'`;

  await client.query(
    `INSERT INTO privacy_brokers
       (id, name, urls, optout, tier, disclosure_fields, cluster_parent,
        prefer_suppression, antibot, source, confidence, last_verified, enabled,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, urls = EXCLUDED.urls, optout = EXCLUDED.optout,
       tier = EXCLUDED.tier, disclosure_fields = EXCLUDED.disclosure_fields,
       cluster_parent = EXCLUDED.cluster_parent,
       prefer_suppression = EXCLUDED.prefer_suppression, antibot = EXCLUDED.antibot,
       source = EXCLUDED.source, confidence = EXCLUDED.confidence,
       last_verified = EXCLUDED.last_verified, enabled = privacy_brokers.enabled,
       updated_at = NOW()
     ${guard}`,
    [
      b.id, b.name, toPgJson(b.urls), toPgJson(b.optout), b.tier,
      b.disclosureFields, b.clusterParent, b.preferSuppression, b.antibot,
      b.source, b.confidence, b.lastVerified, b.enabled,
    ],
  );
}

/** Read the shipped curated seed. Exported for tests. */
export async function loadCuratedSeed() {
  const path = join(PATHS.root, 'data.reference', 'privacy', 'brokers.json');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return Array.isArray(parsed.brokers) ? parsed.brokers.map(normalizeBroker) : [];
}

/**
 * Seed the curated brokers idempotently. Parents (no cluster_parent) are
 * inserted first so a child's self-FK is satisfiable. Curated rows always
 * upsert (so a shipped correction propagates).
 */
export async function seedCuratedBrokers() {
  const brokers = await loadCuratedSeed();
  const ordered = [...brokers].sort((a, b) => (a.clusterParent ? 1 : 0) - (b.clusterParent ? 1 : 0));
  await withTransaction(async (client) => {
    for (const b of ordered) await upsertBroker(client, b, { onlyIfCurated: true });
  });
  console.log(`🗂️ Seeded ${ordered.length} curated privacy brokers`);
  return { seeded: ordered.length };
}

let seedPromise = null;

// Lazy first-use seed — syncs curated brokers on initial use after server boot / upgrade.
export async function ensureSeeded() {
  if (!seedPromise) {
    seedPromise = seedCuratedBrokers().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  await seedPromise;
}

export function resetEnsureSeededForTests() {
  seedPromise = null;
}

export async function listBrokers({ enabled } = {}) {
  await ensureSeeded();
  const clauses = [];
  const params = [];
  if (typeof enabled === 'boolean') { params.push(enabled); clauses.push(`enabled = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  // Cluster parents first (a parent suppression covers its children), then name.
  const { rows } = await query(
    `SELECT ${BROKER_COLUMNS} FROM privacy_brokers ${where}
     ORDER BY (cluster_parent IS NOT NULL), name ASC`,
    params,
  );
  return rows.map(rowToBroker);
}

export async function getBroker(id) {
  const { rows } = await query(`SELECT ${BROKER_COLUMNS} FROM privacy_brokers WHERE id = $1`, [id]);
  return rowToBroker(rows[0]);
}

/**
 * Toggle a broker's `enabled` flag (Brokers-tab per-broker on/off, #2146). A
 * disabled broker is skipped by the scan + opt-out passes. Returns the updated
 * broker row (404 if the id is unknown).
 */
export async function setBrokerEnabled(id, enabled) {
  const { rows } = await query(
    `UPDATE privacy_brokers SET enabled = $1, updated_at = NOW() WHERE id = $2 RETURNING ${BROKER_COLUMNS}`,
    [enabled, id],
  );
  if (!rows[0]) throw new ServerError('Broker not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`🗂️ Broker ${id}: enabled → ${enabled}`);
  return rowToBroker(rows[0]);
}

function registryRows(csv) {
  const rows = [];
  let row = [];
  // Match quoted cells before delimiters so commas and newlines inside a field
  // cannot shift a search or opt-out URL into the website column.
  const cell = /(?:[ \t]*"((?:[^"]|"")*)"[ \t]*|([^",\r\n]*))(,|\r\n?|\n|$)/gy;
  for (const [, quoted, plain, delimiter] of csv.matchAll(cell)) {
    row.push(quoted === undefined ? plain.trim() : quoted.replaceAll('""', '"').trim());
    if (delimiter === ',') continue;
    if (row.some(Boolean)) rows.push(row);
    row = [];
  }
  return rows;
}

// Parse the CA Data Broker Registry CSV (id/name-bearing rows) defensively.
// Returns [] on any shape we can't recognize rather than throwing.
export function parseCaRegistryCsv(csv) {
  if (typeof csv !== 'string' || !csv.trim()) return [];
  const [head, ...rows] = registryRows(csv.trim());
  if (!head) return [];
  const header = head.map((h) => h.toLowerCase());
  const nameIdx = header.findIndex((h) => h.includes('name') || h === 'business');
  const urlIdx = header.findIndex((h) => /^(?:(?:business|broker|company) )?(?:website(?: url)?|url)$/.test(h));
  if (nameIdx === -1) return [];
  return rows.map((cols) => {
    const name = cols[nameIdx];
    if (!name) return null;
    return normalizeBroker({
      id: `ca-${slugify(name)}`,
      name,
      urls: discoveredHome(cols[urlIdx]),
      source: 'ca_registry',
      confidence: 'auto',
    });
  }).filter(Boolean);
}

// Parse the BADBOOL people-search list (a JSON array of {id?,name,url?} entries).
export function parseBadboolList(payload) {
  const arr = Array.isArray(payload) ? payload : (Array.isArray(payload?.brokers) ? payload.brokers : []);
  return arr.map((b) => {
    const name = b?.name || b?.id;
    if (!name) return null;
    return normalizeBroker({
      id: b.id || slugify(name),
      name,
      urls: discoveredHome(b.url || b.urls?.home),
      source: 'badbool',
      confidence: 'auto',
    });
  }).filter(Boolean);
}

// Default network fetchers — injected so tests never hit the network AND boot
// never does either (refreshBrokers is user-triggered only).
const BADBOOL_URL = 'https://raw.githubusercontent.com/bugbounty-zz/data-broker-list/main/brokers.json';
const CA_REGISTRY_URL = 'https://cppa.ca.gov/data_broker_registry.csv';

// A transport or HTTP failure THROWS: an empty list means the source answered
// with no brokers, never that it was unreachable (refreshBrokers reports each
// source's outcome so a failed download cannot read as fetched-and-empty).
async function fetchSource(url) {
  const res = await fetchPublicResponse(url, {
    timeoutMs: BROKER_FETCH_TIMEOUT_MS,
    blockPrivate: true,
    throwOnUnsafe: true,
  });
  if (!res) throw new Error('Broker feed fetch failed or redirect was blocked');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function defaultFetchBadbool() {
  const res = await fetchSource(BADBOOL_URL);
  return parseBadboolList(await res.json());
}

async function defaultFetchCaRegistry() {
  const res = await fetchSource(CA_REGISTRY_URL);
  return parseCaRegistryCsv(await res.text());
}

// Test hook: the real downloaders, exercised against a stubbed pinned fetch.
export const _sourceFetchers = { badbool: defaultFetchBadbool, caRegistry: defaultFetchCaRegistry };

// Run one source fetcher to a { ok, count, error } outcome; rows are [] on failure.
async function runSource(fetcher) {
  try {
    const rows = await fetcher();
    if (!Array.isArray(rows)) throw new Error('Unexpected response shape');
    return { rows, outcome: { ok: true, count: rows.length, error: null } };
  } catch (err) {
    return { rows: [], outcome: { ok: false, count: 0, error: err?.message || 'Fetch failed' } };
  }
}

/**
 * USER-TRIGGERED refresh: pull the BADBOOL people-search list + the CA Data
 * Broker Registry and upsert them with `source`/`confidence: auto`. NEVER
 * overwrites a curated row (the ON CONFLICT guard skips `source=curated`).
 * Fetchers are injectable for tests and throw on failure; each source's
 * outcome is returned as `{ ok, count, error }` so one failed download still
 * upserts the other. NOT called at boot.
 */
export async function refreshBrokers({ fetchBadbool = defaultFetchBadbool, fetchCaRegistry = defaultFetchCaRegistry } = {}) {
  await ensureSeeded();
  const [badboolRun, caRegistryRun] = await Promise.all([runSource(fetchBadbool), runSource(fetchCaRegistry)]);
  const badbool = badboolRun.rows;
  const caRegistry = caRegistryRun.rows;
  // Normalize + tag every fetched entry per lane (defensive — an injected/raw
  // fetcher may return a sparse shape, and a refreshed broker is ALWAYS an auto
  // source, never curated). `clusterParent: null` because auto brokers never
  // join a curated cluster (avoids a dangling self-FK to a non-existent parent).
  // De-dupe by id: a broker on both lists is inserted once.
  const tag = (arr, source) => arr
    .filter((b) => b?.id)
    .map((b) => ({
      ...normalizeBroker(b),
      urls: discoveredHome(b.url || b.urls?.home),
      optout: {},
      clusterParent: null,
      source,
      confidence: 'auto',
    }));
  const byId = new Map();
  for (const b of [...tag(badbool, 'badbool'), ...tag(caRegistry, 'ca_registry')]) {
    if (!byId.has(b.id)) byId.set(b.id, b);
  }
  let added = 0;
  await withTransaction(async (client) => {
    for (const b of byId.values()) {
      const before = await client.query(`SELECT 1 FROM privacy_brokers WHERE id = $1`, [b.id]);
      await upsertBroker(client, b, { onlyIfNotCurated: true });
      if (before.rowCount === 0) added += 1;
    }
  });
  const failed = [badboolRun, caRegistryRun].filter((r) => !r.outcome.ok).length;
  console.log(`🔄 Broker refresh: ${badbool.length} badbool + ${caRegistry.length} ca_registry → ${added} new, curated preserved${failed ? `, ${failed} source(s) failed` : ''}`);
  return {
    fetched: byId.size,
    added,
    sources: { badbool: badboolRun.outcome, caRegistry: caRegistryRun.outcome },
  };
}

// ─── Case ledger ────────────────────────────────────────────────────────────

const CASE_COLUMNS = `id, subject_id, broker_id, state, found, evidence, disclosed_fields,
  channel, reason, next_recheck_at, created_at, updated_at`;

// ─── Identity-bearing case evidence (#8333) ─────────────────────────────────
//
// A scan's evidence names the person it matched: the legal name and city/state
// it found, and the broker search/listing URLs built from them. Those copies
// must not sit in plaintext JSONB beside the encrypted vault (or in every
// pg_dump of it), so they live in a sealed envelope under `sealed_identity`,
// encrypted with the vault's own key (lib/vaultCrypto.js). Everything else in
// `evidence` (match_basis, lane, playbook, verification metadata…) stays
// plain — it identifies the broker and the workflow, not the person.
//
// Envelope: `{ v: 1, ciphertext: 'v1:<iv>:<tag>:<ct>', listing_count }`. The
// ciphertext is JSON of the identity fields; `listing_count` is a
// non-identifying tally so the case list can say "2 listings" without a
// decrypt. The envelope is dropped wholesale on an explicit erase, on
// `confirmed_removed`, and when the vault record it was derived from is
// deleted.

export const IDENTITY_EVIDENCE_KEYS = Object.freeze(['matched_name', 'matched_location', 'search_url', 'listing_urls', 'verification_url']);
const SEALED_EVIDENCE_KEY = 'sealed_identity';
const EVIDENCE_ENVELOPE_VERSION = 1;
// Every key that must be gone from a row whose identity evidence is erased.
const ERASABLE_EVIDENCE_KEYS = Object.freeze([...IDENTITY_EVIDENCE_KEYS, SEALED_EVIDENCE_KEY]);

// Legacy rows kept the confirmation link in plaintext at evidence.verification.url.
// `#-` on a missing path is a no-op, so this is safe on every row.
const STRIP_VERIFICATION_URL = `(evidence - $1::text[]) #- '{verification,url}'`;

const hasIdentityValue = (v) => (Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== ''));

/**
 * Split raw evidence into its plain (non-identifying) part and the identity
 * fields that carry a value. A caller-supplied `sealed_identity` is never
 * trusted as input — the only envelope a write keeps is the one already stored.
 */
function splitEvidence(evidence) {
  const plain = {};
  const identity = {};
  const source = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {};
  for (const [key, value] of Object.entries(source)) {
    if (key === SEALED_EVIDENCE_KEY) continue;
    if (key === 'verification' && value && typeof value === 'object' && !Array.isArray(value)) {
      // The broker confirmation link carries single-use tokens and often the
      // user's email/name, so it is sealed; messageId/score stay plain.
      const { url, ...rest } = value;
      if (typeof url === 'string' && url) identity.verification_url = url;
      plain.verification = rest;
    } else if (IDENTITY_EVIDENCE_KEYS.includes(key)) {
      if (hasIdentityValue(value)) identity[key] = value;
    } else {
      plain[key] = value;
    }
  }
  return { plain, identity };
}

/**
 * The evidence object to PERSIST: plain fields + (optionally) the sealed
 * envelope. Identity fields present in `evidence` are sealed fresh (a new scan
 * replaces the old match); when there are none, `existingEnvelope` is kept so
 * a lifecycle transition that only restates workflow metadata doesn't silently
 * drop the scan's search link. `clearIdentity` drops identity outright.
 * `mergeExistingIdentity` (lifecycle transitions) layers the new identity keys
 * over the opened existing envelope instead of replacing it, so adding
 * `verification_url` keeps the matched name/search/listing links.
 */
async function prepareEvidenceForStorage(evidence, { existingEnvelope = null, clearIdentity = false, mergeExistingIdentity = false } = {}) {
  const { plain, identity: fresh } = splitEvidence(evidence);
  if (clearIdentity) return plain;
  if (Object.keys(fresh).length === 0) {
    return existingEnvelope ? { ...plain, [SEALED_EVIDENCE_KEY]: existingEnvelope } : plain;
  }
  await ensureVaultKey();
  const identity = mergeExistingIdentity && existingEnvelope ? { ...openEvidenceEnvelope(existingEnvelope), ...fresh } : fresh;
  const envelope = {
    v: EVIDENCE_ENVELOPE_VERSION,
    ciphertext: encryptValue(JSON.stringify(identity)),
    listing_count: Array.isArray(identity.listing_urls) ? identity.listing_urls.length : 0,
  };
  return { ...plain, [SEALED_EVIDENCE_KEY]: envelope };
}

/** Decrypt a stored envelope → the identity fields. Throws on an unknown version or tampering. */
function openEvidenceEnvelope(envelope) {
  if (!envelope) return {};
  if (envelope.v !== EVIDENCE_ENVELOPE_VERSION || typeof envelope.ciphertext !== 'string') {
    throw new ServerError('Unsupported broker case evidence envelope', { status: 500, code: 'EVIDENCE_ENVELOPE_UNSUPPORTED' });
  }
  return JSON.parse(decryptValue(envelope.ciphertext));
}

// Legacy-row conversion runs once per process (single-flight), before the
// first ledger read returns anything. A failure leaves the flag unset, so the
// read that triggered it fails loudly and the next read retries.
let evidenceSealed = false;
let evidenceSealFlight = null;

/**
 * Seal any case row still holding plaintext identity evidence (rows written
 * before #8333). Idempotent: a converted row no longer matches the key probe.
 * One transaction — either every matched row is converted or none is.
 */
async function sealLegacyCaseEvidence() {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, evidence FROM privacy_broker_cases WHERE evidence ?| $1::text[] OR evidence->'verification' ? 'url' FOR UPDATE`,
      [IDENTITY_EVIDENCE_KEYS],
    );
    for (const row of rows) {
      const evidence = parseEvidence(row.evidence);
      const stored = await prepareEvidenceForStorage(evidence, { existingEnvelope: evidence[SEALED_EVIDENCE_KEY] ?? null, mergeExistingIdentity: true });
      await client.query(`UPDATE privacy_broker_cases SET evidence = $1 WHERE id = $2`, [toPgJson(stored), row.id]);
    }
    if (rows.length) console.log(`🔐 Sealed identity evidence on ${rows.length} legacy broker case(s)`);
    return { converted: rows.length };
  });
}

async function ensureCaseEvidenceSealed() {
  if (evidenceSealed) return;
  if (!evidenceSealFlight) {
    evidenceSealFlight = sealLegacyCaseEvidence()
      .then(() => { evidenceSealed = true; })
      .finally(() => { evidenceSealFlight = null; });
  }
  await evidenceSealFlight;
}

export function __resetCaseEvidenceSealForTests() {
  evidenceSealed = false;
  evidenceSealFlight = null;
}

function parseEvidence(raw) {
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw && typeof raw === 'object' ? raw : {};
}

function rowToCase(row) {
  if (!row) return null;
  const storedEvidence = parseEvidence(row.evidence);
  const envelope = storedEvidence[SEALED_EVIDENCE_KEY] ?? null;
  return {
    id: row.id,
    subjectId: row.subject_id,
    brokerId: row.broker_id,
    state: row.state,
    // Server-derived legal manual moves for this state — the client action
    // strips render only actions whose target is in this list (issue #2417).
    allowedTransitions: allowedTransitionsFor(row.state),
    found: row.found ?? null,
    // Non-identifying evidence only — identity fields are never projected,
    // even from a row the legacy conversion hasn't reached yet.
    evidence: splitEvidence(storedEvidence).plain,
    // Summary of the sealed identity evidence (null once erased). Revealing it
    // is the explicit `revealCaseEvidence` action.
    identityEvidence: envelope ? { sealed: true, listingCount: envelope.listing_count ?? 0 } : null,
    disclosedFields: row.disclosed_fields ?? [],
    channel: row.channel ?? null,
    reason: row.reason ?? null,
    nextRecheckAt: row.next_recheck_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Present only on the joined list query.
    ...(row.broker_name !== undefined ? { brokerName: row.broker_name } : {}),
    ...(row.tier !== undefined ? { brokerTier: row.tier } : {}),
  };
}

/**
 * The identity fields a stored row's envelope holds, for SERVER-SIDE engine use
 * (the opt-out planner's listing URLs, the digest's manual-check link). A
 * decrypt failure (rotated/missing key, tampering) degrades to `null` with a
 * warning rather than failing the whole pass — the explicit reveal action is
 * where that failure surfaces to the user.
 */
function readIdentityForEngine(row) {
  const envelope = parseEvidence(row.evidence)[SEALED_EVIDENCE_KEY];
  if (!envelope) return null;
  try {
    return openEvidenceEnvelope(envelope);
  } catch (err) {
    console.warn(`⚠️ Broker case ${row.id}: sealed identity evidence unreadable (${err.message})`);
    return null;
  }
}

/**
 * List a subject's cases. `includeIdentity` is for in-process engines only
 * (opt-out planner, digest): it attaches the decrypted identity fields as
 * `identity` on each case. Route handlers never pass it — the API projection
 * carries only `identityEvidence` (a summary) and the reveal action decrypts.
 */
export async function listBrokerCases({ state, subjectId, includeIdentity = false } = {}) {
  await ensureCaseEvidenceSealed();
  // Always scoped to ONE subject (defaulting to `self`): two household members
  // hold independent cases against the same broker, and the opt-out engine must
  // never plan a submission for one using the other's ledger.
  const params = [resolveSubjectId(subjectId)];
  const clauses = ['c.subject_id = $1'];
  if (state) { params.push(state); clauses.push(`c.state = $${params.length}`); }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const { rows } = await query(
    `SELECT c.id, c.subject_id, c.broker_id, c.state, c.found, c.evidence, c.disclosed_fields,
            c.channel, c.reason, c.next_recheck_at, c.created_at, c.updated_at,
            b.name AS broker_name, b.tier
     FROM privacy_broker_cases c
     JOIN privacy_brokers b ON b.id = c.broker_id
     ${where}
     ORDER BY b.name ASC`,
    params,
  );
  if (!includeIdentity) return rows.map(rowToCase);
  return rows.map((row) => ({ ...rowToCase(row), identity: readIdentityForEngine(row) }));
}

export async function getCaseForBroker(brokerId, { subjectId } = {}) {
  await ensureCaseEvidenceSealed();
  const { rows } = await query(
    `SELECT ${CASE_COLUMNS} FROM privacy_broker_cases WHERE broker_id = $1 AND subject_id = $2`,
    [brokerId, resolveSubjectId(subjectId)],
  );
  return rowToCase(rows[0]);
}

// Every candidate name/location participates in the page classification, even
// when the URL only contains the first. Lock vault rows before any case row,
// matching the erase path. xmin is an in-flight row version, never persisted.
async function lockCurrentScanSources(client, subjectId, sources) {
  if (!sources?.length) return false;
  const { rowCount } = await client.query(
    `SELECT v.id FROM privacy_vault_records v
     JOIN unnest($2::uuid[], $3::text[]) AS source(id, version)
       ON v.id = source.id AND v.xmin::text = source.version
     WHERE v.subject_id = $1 AND v.use_for_scans AND v.type IN ('legal_name', 'address')
     ORDER BY v.id FOR SHARE OF v`,
    [subjectId, sources.map(s => s.id), sources.map(s => s.version)],
  );
  return rowCount === sources.length;
}

const staleScanResult = () => ({ skipped: true, reason: 'stale_scan_sources' });

/**
 * Record a scan verdict on a broker's case — creates the case if absent, else
 * transitions the existing case. Enforces the state machine (a re-scan sets
 * `viaRescan`). Returns the case row, or a skip when its scan sources changed.
 */
export async function recordScanVerdict(brokerId, verdict, { evidence = {}, found = null, now = new Date(), subjectId, scanSources } = {}) {
  if (!SCAN_VERDICTS.includes(verdict)) {
    throw new ServerError(`Not a scan verdict: "${verdict}"`, { status: 400, code: 'INVALID_SCAN_VERDICT' });
  }
  const resolvedSubjectId = resolveSubjectId(subjectId);
  // A fresh scan REPLACES the identity match (a re-scan that no longer finds a
  // listing must not keep the old one), so no existing envelope is carried.
  return withTransaction(async (client) => {
    if (!(await lockCurrentScanSources(client, resolvedSubjectId, scanSources))) return staleScanResult();
    const storedEvidence = toPgJson(await prepareEvidenceForStorage(evidence));
    const broker = await client.query(`SELECT id FROM privacy_brokers WHERE id = $1`, [brokerId]);
    if (!broker.rows[0]) throw new ServerError('Broker not found', { status: 404, code: 'NOT_FOUND' });
    // Keyed on the (broker, subject) pair — the ledger's unique index moved to
    // that pair in #3658 so each household member gets their own case row.
    const existing = await client.query(
      `SELECT id, state FROM privacy_broker_cases WHERE broker_id = $1 AND subject_id = $2 FOR UPDATE`,
      [brokerId, resolvedSubjectId],
    );
    const nextRecheck = computeNextRecheckAt(verdict, now);
    if (!existing.rows[0]) {
      assertTransition('unscanned', verdict);
      const id = randomUUID();
      try {
        await client.query('SAVEPOINT sp_insert_scan_verdict');
        const { rows } = await client.query(
          `INSERT INTO privacy_broker_cases
             (id, subject_id, broker_id, state, found, evidence, next_recheck_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
           RETURNING ${CASE_COLUMNS}`,
          [id, resolvedSubjectId, brokerId, verdict, found, storedEvidence, nextRecheck],
        );
        await client.query('RELEASE SAVEPOINT sp_insert_scan_verdict');
        console.log(`🔎 Broker ${brokerId}: new case → ${verdict} (subject=${resolvedSubjectId})`);
        return rowToCase(rows[0]);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT sp_insert_scan_verdict');
        if (err.code === '23505') {
          const raceExisting = await client.query(
            `SELECT id, state FROM privacy_broker_cases WHERE broker_id = $1 AND subject_id = $2 FOR UPDATE`,
            [brokerId, resolvedSubjectId],
          );
          if (raceExisting.rows[0]) {
            assertTransition(raceExisting.rows[0].state, verdict, { viaRescan: true });
            const { rows } = await client.query(
              `UPDATE privacy_broker_cases
               SET state = $1, found = $2, evidence = $3, next_recheck_at = $4, updated_at = NOW()
               WHERE id = $5 RETURNING ${CASE_COLUMNS}`,
              [verdict, found, storedEvidence, nextRecheck, raceExisting.rows[0].id],
            );
            console.log(`🔎 Broker ${brokerId}: case ${raceExisting.rows[0].state} → ${verdict} (subject=${resolvedSubjectId})`);
            return rowToCase(rows[0]);
          }
        }
        throw err;
      }
    }
    // Re-scan of an existing case. A settled verdict flipping is a rescan.
    assertTransition(existing.rows[0].state, verdict, { viaRescan: true });
    const { rows } = await client.query(
      `UPDATE privacy_broker_cases
       SET state = $1, found = $2, evidence = $3, next_recheck_at = $4, updated_at = NOW()
       WHERE id = $5 RETURNING ${CASE_COLUMNS}`,
      [verdict, found, storedEvidence, nextRecheck, existing.rows[0].id],
    );
    console.log(`🔎 Broker ${brokerId}: case ${existing.rows[0].state} → ${verdict} (subject=${resolvedSubjectId})`);
    return rowToCase(rows[0]);
  });
}

/**
 * Transition a case by id through the opt-out lifecycle (submitted, etc.).
 * Enforces the state machine + stamps `next_recheck_at`. `patch` may carry
 * `channel`, `reason`, `disclosedFields`, `evidence`, and a `viaRescan` flag
 * (verification-only targets). Used by the Phase 6 opt-out engine.
 *
 * Evidence (#8333): identity fields in `patch.evidence` are sealed; without
 * any, the case's existing sealed envelope is carried forward. Reaching
 * `confirmed_removed` ERASES the identity envelope — the listing is gone, so
 * the only remaining copy of the matched name/location/URLs is ours — while the
 * plain verdict metadata, state, and timestamps are kept.
 */
export async function transitionCase(caseId, toState, patch = {}) {
  const { viaRescan = false, now = new Date() } = patch;
  return withTransaction(async (client) => {
    if (viaRescan && toState === 'reappeared' && !(await lockCurrentScanSources(client, resolveSubjectId(patch.subjectId), patch.scanSources))) {
      return staleScanResult();
    }
    const existing = await client.query(
      `SELECT id, state, evidence FROM privacy_broker_cases WHERE id = $1 FOR UPDATE`, [caseId],
    );
    if (!existing.rows[0]) throw new ServerError('Case not found', { status: 404, code: 'NOT_FOUND' });
    // A delayed mailbox read must not write evidence onto a reopened case's next request.
    if (patch.expectedDraftId && (existing.rows[0].state !== patch.expectedState
      || parseEvidence(existing.rows[0].evidence).draftId !== patch.expectedDraftId)) {
      return { skipped: true, reason: 'optout_request_changed' };
    }
    assertTransition(existing.rows[0].state, toState, { viaRescan });
    const sets = ['state = $1', 'next_recheck_at = $2', 'updated_at = NOW()'];
    const params = [toState, computeNextRecheckAt(toState, now)];
    const add = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    // A transition onto a verdict state implies the ledger's `found` flag
    // (e.g. the blocked-case manual "I'm listed" → found), unless the caller
    // supplied an explicit patch.found. indirect_exposure stays null: a
    // name-only match is an unknown, not a confirmed listing.
    const impliedFound = { found: true, not_found: false, indirect_exposure: null };
    const foundValue = patch.found !== undefined ? patch.found
      : (toState in impliedFound ? impliedFound[toState] : undefined);
    if (foundValue !== undefined) add('found', foundValue);
    if (patch.channel !== undefined) add('channel', patch.channel);
    if (patch.reason !== undefined) add('reason', patch.reason);
    if (patch.disclosedFields !== undefined) add('disclosed_fields', patch.disclosedFields);
    const clearIdentity = toState === 'confirmed_removed';
    if (patch.evidence !== undefined || clearIdentity) {
      const stored = parseEvidence(existing.rows[0].evidence);
      add('evidence', toPgJson(await prepareEvidenceForStorage(patch.evidence ?? stored, {
        existingEnvelope: stored[SEALED_EVIDENCE_KEY] ?? null, clearIdentity, mergeExistingIdentity: true,
      })));
    }
    params.push(caseId);
    const { rows } = await client.query(
      `UPDATE privacy_broker_cases SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${CASE_COLUMNS}`,
      params,
    );
    if (clearIdentity) {
      const { eraseCaseDrafts } = await import('./privacyDraftErasure.js');
      await eraseCaseDrafts(caseId, parseEvidence(existing.rows[0].evidence).draftId);
    }
    console.log(`📋 Case ${caseId}: ${existing.rows[0].state} → ${toState}`);
    return rowToCase(rows[0]);
  });
}

/**
 * Explicit per-case evidence ERASE (#8333): drop the sealed identity envelope
 * (and any legacy plaintext identity field) from one case, keeping its state,
 * verdict metadata, and timestamps. Idempotent — erasing an already-clear case
 * returns it unchanged apart from `updated_at`. 404 if the case is unknown.
 */
export async function clearCaseIdentityEvidence(caseId) {
  const { rows } = await query(
    `UPDATE privacy_broker_cases SET evidence = ${STRIP_VERIFICATION_URL}, updated_at = NOW()
     WHERE id = $2 RETURNING ${CASE_COLUMNS}`,
    [ERASABLE_EVIDENCE_KEYS, caseId],
  );
  if (!rows[0]) throw new ServerError('Case not found', { status: 404, code: 'NOT_FOUND' });
  const { eraseCaseDrafts } = await import('./privacyDraftErasure.js');
  await eraseCaseDrafts(caseId, rowToCase(rows[0]).evidence?.draftId);
  console.log(`🗑️ Case ${caseId}: identity evidence erased`);
  return rowToCase(rows[0]);
}

/**
 * Erase the identity evidence on EVERY case of a subject — called when a vault
 * record that feeds scan vectors is deleted, so the name/location the user just
 * removed from the vault doesn't survive in the case ledger (or its backups).
 * The next scan re-derives search links from whatever the vault still holds.
 * Accepts the caller's transaction client so the erase commits with the delete.
 */
export async function clearSubjectIdentityEvidence(subjectId, { client = null } = {}) {
  const run = client ? (sql, params) => client.query(sql, params) : query;
  const { rowCount } = await run(
    `UPDATE privacy_broker_cases SET evidence = ${STRIP_VERIFICATION_URL}, updated_at = NOW()
     WHERE subject_id = $2 AND (evidence ?| $1::text[] OR evidence->'verification' ? 'url')`,
    [ERASABLE_EVIDENCE_KEYS, resolveSubjectId(subjectId)],
  );
  if (rowCount) console.log(`🗑️ Erased identity evidence on ${rowCount} broker case(s) (subject=${resolveSubjectId(subjectId)})`);
  return { cleared: rowCount ?? 0 };
}

/**
 * The ONE user-facing decrypt path for case evidence: the case drawer's
 * search/listing links. Returns `{ caseId, sealed, evidence }` where
 * `evidence` holds the identity fields (empty once erased). Logs the id only.
 */
export async function revealCaseEvidence(caseId) {
  await ensureCaseEvidenceSealed();
  const { rows } = await query(`SELECT id, evidence FROM privacy_broker_cases WHERE id = $1`, [caseId]);
  if (!rows[0]) throw new ServerError('Case not found', { status: 404, code: 'NOT_FOUND' });
  const envelope = parseEvidence(rows[0].evidence)[SEALED_EVIDENCE_KEY];
  if (!envelope) return { caseId, sealed: false, evidence: {} };
  const identity = openEvidenceEnvelope(envelope);
  console.log(`🔓 Revealed broker case evidence ${caseId}`);
  return { caseId, sealed: true, evidence: identity };
}

/**
 * Force a case due for recheck NOW (Brokers-tab manual "Re-check" control,
 * #2146): stamp `next_recheck_at` in the past so the next scan/opt-out pass
 * picks it up regardless of its backoff. Read-only otherwise — does not change
 * the case state. Returns the updated case row (404 if unknown).
 */
export async function forceRecheckCase(caseId, { now = new Date() } = {}) {
  const { rows } = await query(
    `UPDATE privacy_broker_cases SET next_recheck_at = $1, updated_at = NOW()
     WHERE id = $2 RETURNING ${CASE_COLUMNS}`,
    [new Date(now.getTime() - 1000).toISOString(), caseId],
  );
  if (!rows[0]) throw new ServerError('Case not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`📋 Case ${caseId}: forced due for recheck`);
  return rowToCase(rows[0]);
}

/**
 * Aggregate readout for the scan/status endpoint + Brokers UI: total enabled
 * brokers, case counts per state, and how many cases are due for a recheck.
 * Seeds lazily so a fresh install reports the full curated broker count.
 */
export async function getScanStatus({ now = new Date(), subjectId } = {}) {
  await ensureSeeded();
  const resolvedSubjectId = resolveSubjectId(subjectId);
  const [brokerCount, byState, due] = await Promise.all([
    // The broker DATABASE is shared across subjects (it is a catalog, not
    // per-person data) — only the CASE counts are subject-scoped.
    query(`SELECT COUNT(*)::int AS n FROM privacy_brokers WHERE enabled = TRUE`),
    query(
      `SELECT state, COUNT(*)::int AS n FROM privacy_broker_cases
       WHERE subject_id = $1 GROUP BY state`,
      [resolvedSubjectId],
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM privacy_broker_cases
       WHERE subject_id = $1 AND (next_recheck_at IS NULL OR next_recheck_at <= $2)`,
      [resolvedSubjectId, now.toISOString()],
    ),
  ]);
  const caseCounts = {};
  for (const row of byState.rows) caseCounts[row.state] = row.n;
  return {
    enabledBrokers: brokerCount.rows[0].n,
    subjectId: resolvedSubjectId,
    caseCounts,
    dueForRecheck: due.rows[0].n,
  };
}
