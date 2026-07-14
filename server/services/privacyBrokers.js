/**
 * Data-broker database + case ledger (issue #2144, epic #2138).
 *
 * db-primary Postgres per docs/STORAGE.md: `privacy_brokers` is the curated
 * (+ later BADBOOL / CA-registry) database of people-search brokers the
 * exposure-scan / opt-out engine works; `privacy_broker_cases` is the per-broker
 * ledger with a SERVICE-ENFORCED state machine. Machine-local — no federation,
 * no tombstones (same deferred scope as the vault, #2148).
 *
 * Boot policy (CLAUDE.md — no cold-bootstrap network/LLM): NOTHING here runs at
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
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';

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
  awaiting_processing: [],
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
    urls: row.urls ?? {},
    optout: row.optout ?? {},
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
async function upsertBroker(client, b, { onlyIfNotCurated = false } = {}) {
  const guard = onlyIfNotCurated ? `WHERE privacy_brokers.source <> 'curated'` : '';
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
       last_verified = EXCLUDED.last_verified, enabled = EXCLUDED.enabled,
       updated_at = NOW()
     ${guard}`,
    [
      b.id, b.name, JSON.stringify(b.urls), JSON.stringify(b.optout), b.tier,
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
    for (const b of ordered) await upsertBroker(client, b);
  });
  console.log(`🗂️ Seeded ${ordered.length} curated privacy brokers`);
  return { seeded: ordered.length };
}

// Lazy first-use seed — never at boot. Only seeds an empty table.
async function ensureSeeded() {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM privacy_brokers`);
  if (rows[0].n === 0) await seedCuratedBrokers();
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

// Parse the CA Data Broker Registry CSV (id/name-bearing rows) defensively.
// Returns [] on any shape we can't recognize rather than throwing.
export function parseCaRegistryCsv(csv) {
  if (typeof csv !== 'string' || !csv.trim()) return [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const nameIdx = header.findIndex((h) => h.includes('name') || h.includes('business'));
  const urlIdx = header.findIndex((h) => h.includes('url') || h.includes('website'));
  if (nameIdx === -1) return [];
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const name = (cols[nameIdx] || '').trim().replace(/^"|"$/g, '');
    if (!name) return null;
    const website = urlIdx !== -1 ? (cols[urlIdx] || '').trim().replace(/^"|"$/g, '') : '';
    return normalizeBroker({
      id: `ca-${slugify(name)}`,
      name,
      urls: website ? { home: website } : {},
      source: 'ca_registry',
      confidence: 'auto',
    });
  }).filter(Boolean);
}

// Parse the BADBOOL people-search list (a JSON array of {id?,name,url?} entries).
export function parseBadboolList(payload) {
  const arr = Array.isArray(payload) ? payload : (Array.isArray(payload?.brokers) ? payload.brokers : []);
  return arr.map((b) => {
    const name = b.name || b.id;
    if (!name) return null;
    return normalizeBroker({
      id: b.id || slugify(name),
      name,
      urls: b.url ? { home: b.url } : (b.urls || {}),
      optout: b.optout || {},
      source: 'badbool',
      confidence: 'auto',
    });
  }).filter(Boolean);
}

// Default network fetchers — injected so tests never hit the network AND boot
// never does either (refreshBrokers is user-triggered only).
const BADBOOL_URL = 'https://raw.githubusercontent.com/bugbounty-zz/data-broker-list/main/brokers.json';
const CA_REGISTRY_URL = 'https://cppa.ca.gov/data_broker_registry.csv';

async function defaultFetchBadbool() {
  const res = await fetchWithTimeout(BADBOOL_URL, {}, BROKER_FETCH_TIMEOUT_MS).catch(() => null);
  if (!res || !res.ok) return [];
  return parseBadboolList(await res.json().catch(() => null));
}

async function defaultFetchCaRegistry() {
  const res = await fetchWithTimeout(CA_REGISTRY_URL, {}, BROKER_FETCH_TIMEOUT_MS).catch(() => null);
  if (!res || !res.ok) return [];
  return parseCaRegistryCsv(await res.text().catch(() => ''));
}

/**
 * USER-TRIGGERED refresh: pull the BADBOOL people-search list + the CA Data
 * Broker Registry and upsert them with `source`/`confidence: auto`. NEVER
 * overwrites a curated row (the ON CONFLICT guard skips `source=curated`).
 * Fetchers are injectable for tests. NOT called at boot.
 */
export async function refreshBrokers({ fetchBadbool = defaultFetchBadbool, fetchCaRegistry = defaultFetchCaRegistry } = {}) {
  await ensureSeeded();
  const [badbool, caRegistry] = await Promise.all([
    fetchBadbool().catch(() => []),
    fetchCaRegistry().catch(() => []),
  ]);
  // Normalize + tag every fetched entry per lane (defensive — an injected/raw
  // fetcher may return a sparse shape, and a refreshed broker is ALWAYS an auto
  // source, never curated). `clusterParent: null` because auto brokers never
  // join a curated cluster (avoids a dangling self-FK to a non-existent parent).
  // De-dupe by id: a broker on both lists is inserted once.
  const tag = (arr, source) => arr
    .map(normalizeBroker)
    .filter((b) => b?.id)
    .map((b) => ({ ...b, clusterParent: null, source, confidence: 'auto' }));
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
  console.log(`🔄 Broker refresh: ${badbool.length} badbool + ${caRegistry.length} ca_registry → ${added} new, curated preserved`);
  return { fetched: byId.size, added, sources: { badbool: badbool.length, caRegistry: caRegistry.length } };
}

// ─── Case ledger ────────────────────────────────────────────────────────────

const CASE_COLUMNS = `id, broker_id, state, found, evidence, disclosed_fields,
  channel, reason, next_recheck_at, created_at, updated_at`;

function rowToCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    brokerId: row.broker_id,
    state: row.state,
    // Server-derived legal manual moves for this state — the client action
    // strips render only actions whose target is in this list (issue #2417).
    allowedTransitions: allowedTransitionsFor(row.state),
    found: row.found ?? null,
    evidence: row.evidence ?? {},
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

export async function listBrokerCases({ state } = {}) {
  const clauses = [];
  const params = [];
  if (state) { params.push(state); clauses.push(`c.state = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT c.id, c.broker_id, c.state, c.found, c.evidence, c.disclosed_fields,
            c.channel, c.reason, c.next_recheck_at, c.created_at, c.updated_at,
            b.name AS broker_name, b.tier
     FROM privacy_broker_cases c
     JOIN privacy_brokers b ON b.id = c.broker_id
     ${where}
     ORDER BY b.name ASC`,
    params,
  );
  return rows.map(rowToCase);
}

export async function getCaseForBroker(brokerId) {
  const { rows } = await query(
    `SELECT ${CASE_COLUMNS} FROM privacy_broker_cases WHERE broker_id = $1`, [brokerId],
  );
  return rowToCase(rows[0]);
}

/**
 * Record a scan verdict on a broker's case — creates the case if absent, else
 * transitions the existing case. Enforces the state machine (a re-scan sets
 * `viaRescan`). Every write stamps `next_recheck_at`. Returns the case row.
 */
export async function recordScanVerdict(brokerId, verdict, { evidence = {}, found = null, now = new Date() } = {}) {
  if (!SCAN_VERDICTS.includes(verdict)) {
    throw new ServerError(`Not a scan verdict: "${verdict}"`, { status: 400, code: 'INVALID_SCAN_VERDICT' });
  }
  return withTransaction(async (client) => {
    const broker = await client.query(`SELECT id FROM privacy_brokers WHERE id = $1`, [brokerId]);
    if (!broker.rows[0]) throw new ServerError('Broker not found', { status: 404, code: 'NOT_FOUND' });
    const existing = await client.query(
      `SELECT id, state FROM privacy_broker_cases WHERE broker_id = $1 FOR UPDATE`, [brokerId],
    );
    const nextRecheck = computeNextRecheckAt(verdict, now);
    if (!existing.rows[0]) {
      assertTransition('unscanned', verdict);
      const id = randomUUID();
      const { rows } = await client.query(
        `INSERT INTO privacy_broker_cases
           (id, broker_id, state, found, evidence, next_recheck_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         RETURNING ${CASE_COLUMNS}`,
        [id, brokerId, verdict, found, JSON.stringify(evidence), nextRecheck],
      );
      console.log(`🔎 Broker ${brokerId}: new case → ${verdict}`);
      return rowToCase(rows[0]);
    }
    // Re-scan of an existing case. A settled verdict flipping is a rescan.
    assertTransition(existing.rows[0].state, verdict, { viaRescan: true });
    const { rows } = await client.query(
      `UPDATE privacy_broker_cases
       SET state = $1, found = $2, evidence = $3, next_recheck_at = $4, updated_at = NOW()
       WHERE broker_id = $5 RETURNING ${CASE_COLUMNS}`,
      [verdict, found, JSON.stringify(evidence), nextRecheck, brokerId],
    );
    console.log(`🔎 Broker ${brokerId}: case ${existing.rows[0].state} → ${verdict}`);
    return rowToCase(rows[0]);
  });
}

/**
 * Transition a case by id through the opt-out lifecycle (submitted, etc.).
 * Enforces the state machine + stamps `next_recheck_at`. `patch` may carry
 * `channel`, `reason`, `disclosedFields`, `evidence`, and a `viaRescan` flag
 * (verification-only targets). Used by the Phase 6 opt-out engine.
 */
export async function transitionCase(caseId, toState, patch = {}) {
  const { viaRescan = false, now = new Date() } = patch;
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT id, state FROM privacy_broker_cases WHERE id = $1 FOR UPDATE`, [caseId],
    );
    if (!existing.rows[0]) throw new ServerError('Case not found', { status: 404, code: 'NOT_FOUND' });
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
    if (patch.evidence !== undefined) add('evidence', JSON.stringify(patch.evidence));
    params.push(caseId);
    const { rows } = await client.query(
      `UPDATE privacy_broker_cases SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${CASE_COLUMNS}`,
      params,
    );
    console.log(`📋 Case ${caseId}: ${existing.rows[0].state} → ${toState}`);
    return rowToCase(rows[0]);
  });
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
export async function getScanStatus({ now = new Date() } = {}) {
  await ensureSeeded();
  const [brokerCount, byState, due] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM privacy_brokers WHERE enabled = TRUE`),
    query(`SELECT state, COUNT(*)::int AS n FROM privacy_broker_cases GROUP BY state`),
    query(
      `SELECT COUNT(*)::int AS n FROM privacy_broker_cases
       WHERE next_recheck_at IS NULL OR next_recheck_at <= $1`,
      [now.toISOString()],
    ),
  ]);
  const caseCounts = {};
  for (const row of byState.rows) caseCounts[row.state] = row.n;
  return {
    enabledBrokers: brokerCount.rows[0].n,
    caseCounts,
    dueForRecheck: due.rows[0].n,
  };
}
