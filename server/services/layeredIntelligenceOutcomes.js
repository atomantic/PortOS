/**
 * Layered Intelligence outcome store — closes the loop's feedback gap (#2428).
 *
 * The LI reasoner files improvement proposals as tracker issues but historically
 * never read back whether those proposals were merged, rejected, or abandoned —
 * so it proposed in a vacuum, re-suggesting scopes with a 0% adoption rate. This
 * store records every filed proposal and reconciles its outcome from the live
 * tracker state, so `computeOutcomesReport` (in layeredIntelligence.js) can feed
 * merge-rate statistics back into the reasoning prompt.
 *
 * Storage: a `createCollectionStore` collection at `data/cos/li-outcomes/`, one
 * record per (app, slug). Per-record write queue → concurrent apps' outcomes
 * never clobber each other. Records auto-gc after CLOSED_SUPPRESSION_MS (30 days)
 * so the store stays bounded — the same window the dedup guard already uses.
 *
 * Runs OUTSIDE the request lifecycle (scheduler tick / agent completion), so per
 * the CLAUDE.md no-try/catch rule the LI hooks own the async boundary; these
 * helpers stay defensive (a failed read/write degrades to a recorded no-op) and
 * are gated behind the `sources.outcomes` config toggle by their callers.
 */

import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { createCollectionStore } from '../lib/collectionStore.js';
import { normalizeSlug, deriveOutcome, PROPOSAL_OUTCOMES, CLOSED_SUPPRESSION_MS } from './layeredIntelligence.js';

// The report/retention window. Reuses the dedup suppression window so a proposal
// stays in the outcome report exactly as long as it still suppresses re-proposal —
// the two "LI remembers this" windows move in lockstep.
export const OUTCOME_RETENTION_MS = CLOSED_SUPPRESSION_MS;

// The collection's on-disk layout version. Bump only via a migration that
// changes the record directory shape (there is none yet).
export const LI_OUTCOMES_SCHEMA_VERSION = 1;

/**
 * Normalize one on-disk outcome record. Drops anything without a usable
 * appId+slug (the identity), coerces the outcome to a known value or null, and
 * defaults the timestamps. Returning null makes collectionStore treat the row as
 * invalid (loadOne → null), so a hand-corrupted file can't poison the report.
 */
export function sanitizeOutcomeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const appId = typeof raw.appId === 'string' ? raw.appId.trim() : '';
  const slug = normalizeSlug(raw.slug);
  if (!appId || !slug) return null;
  const outcome = PROPOSAL_OUTCOMES.includes(raw.outcome) ? raw.outcome : null;
  return {
    appId,
    slug,
    tracker: typeof raw.tracker === 'string' ? raw.tracker : null,
    issueRef: typeof raw.issueRef === 'string' ? raw.issueRef : (raw.issueRef != null ? String(raw.issueRef) : null),
    scope: typeof raw.scope === 'string' ? raw.scope : null,
    filedAt: typeof raw.filedAt === 'string' ? raw.filedAt : null,
    outcome,
    outcomeAt: outcome && typeof raw.outcomeAt === 'string' ? raw.outcomeAt : null,
    outcomeReason: outcome && typeof raw.outcomeReason === 'string' ? raw.outcomeReason : null
  };
}

// Composite record id — one row per (app, slug). appId matches the app-id regex
// (`[A-Za-z0-9_-]+`) and slug is normalized kebab, so the joined id is always a
// valid collectionStore id; sliced to the store's 128-char ceiling defensively.
function outcomeId(appId, slug) {
  return `${appId}--${slug}`.slice(0, 128);
}

let _store = null;
/**
 * Lazily construct the singleton outcome collection store. Lazy so the module
 * graph doesn't build a store (and touch PATHS) at import time; the boot-time
 * verifier in server/index.js and the LI hooks both call this.
 */
export function outcomesStore() {
  if (!_store) {
    _store = createCollectionStore({
      dir: join(PATHS.cos, 'li-outcomes'),
      type: 'li-outcomes',
      schemaVersion: LI_OUTCOMES_SCHEMA_VERSION,
      sanitizeRecord: sanitizeOutcomeRecord
    });
  }
  return _store;
}

// `saveOne` writes the per-record file but never the type-level index.json (the
// slot that stamps schemaVersion). Since this store ships with no migration to
// create it, stamp it on the first write so the boot verifier reports the real
// version and a future schemaVersion bump can detect existing v1 data. Guarded
// per store instance (WeakSet) so it runs once per process, not on every record.
const _stamped = new WeakSet();
async function ensureTypeIndex(store) {
  if (_stamped.has(store)) return;
  _stamped.add(store);
  await store.saveTypeIndex({}).catch(() => { _stamped.delete(store); });
}

/**
 * Record a freshly-filed proposal (outcome unknown). Idempotent per (app, slug):
 * a re-file overwrites the row with a fresh `filedAt` and clears the outcome, so
 * a re-opened proposal is tracked from its newest filing. Best-effort — a write
 * failure logs and returns false rather than throwing into the LI hook.
 */
export async function recordFiledProposal({ appId, slug, tracker = null, issueRef = null, scope = null, now = Date.now() } = {}, store = outcomesStore()) {
  const normSlug = normalizeSlug(slug);
  if (!appId || !normSlug) return false;
  const record = {
    appId,
    slug: normSlug,
    tracker,
    issueRef: issueRef != null ? String(issueRef) : null,
    scope,
    filedAt: new Date(now).toISOString(),
    outcome: null,
    outcomeAt: null,
    outcomeReason: null
  };
  await ensureTypeIndex(store);
  const ok = await store.saveOne(outcomeId(appId, normSlug), record).then(() => true, (err) => {
    console.error(`❌ Layered Intelligence: failed to record outcome for ${appId}/${normSlug}: ${err.message}`);
    return false;
  });
  return ok;
}

/**
 * Load this app's outcome records, GC-ing stale ones from disk so the store stays
 * bounded. GC mirrors the dedup window (isIssueWithinDedupWindow): an UNRESOLVED
 * record (outcome still null) is kept indefinitely — like an open issue — so a
 * proposal that stays open past the window can still be learned once it finally
 * closes. A RESOLVED record expires OUTCOME_RETENTION_MS after its resolution
 * (outcomeAt), not its filing, so a long-open-then-merged proposal isn't dropped
 * the moment it resolves. Returns survivors sorted newest-filed-first. Never throws.
 */
export async function listOutcomes({ appId, now = Date.now() } = {}, store = outcomesStore()) {
  if (!appId) return [];
  const all = await store.loadAll().catch(() => []);
  const mine = all.filter(r => r && r.appId === appId);
  const kept = [];
  for (const r of mine) {
    if (r.outcome) {
      const resolvedMs = Date.parse(r.outcomeAt) || Date.parse(r.filedAt) || NaN;
      if (Number.isFinite(resolvedMs) && (now - resolvedMs) > OUTCOME_RETENTION_MS) {
        await store.deleteOne(outcomeId(r.appId, r.slug)).catch(() => {});
        continue;
      }
    }
    kept.push(r);
  }
  return kept.sort((a, b) => (Date.parse(b.filedAt) || 0) - (Date.parse(a.filedAt) || 0));
}

/**
 * Reconcile outcome records against a FRESH tracker read. For each stored record,
 * find the matching existing issue (by slug) and, when the tracker now reports it
 * closed, persist the derived outcome (`merged` / `rejected` / `abandoned`). Open
 * issues never resolve — or flip back — a record. A record whose stored outcome
 * DIFFERS from what the live closed state derives is reclassified (#2620): this
 * self-heals records persisted under the old any-close-is-merged mapping (e.g.
 * `merged` with a duplicate-close reason) instead of letting them inflate the
 * merge rate until they expire, and it tracks a reopened-then-re-closed issue's
 * latest fate. Returns the number of records updated. Never throws — a
 * per-record write failure is swallowed so one bad row can't abort the whole
 * reconciliation.
 */
export async function reconcileOutcomes({ appId, existingIssues = [], now = Date.now() } = {}, store = outcomesStore()) {
  if (!appId || !Array.isArray(existingIssues) || existingIssues.length === 0) return 0;
  // Index existing issues by normalized slug for O(1) lookup.
  const bySlug = new Map();
  for (const issue of existingIssues) {
    const slug = normalizeSlug(issue?.slug);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, issue);
  }
  const records = await listOutcomes({ appId, now }, store);
  let updated = 0;
  for (const r of records) {
    const issue = bySlug.get(r.slug);
    if (!issue) continue;
    const outcome = deriveOutcome(issue);
    if (!outcome || outcome === r.outcome) continue;
    const next = {
      ...r,
      outcome,
      outcomeAt: issue.closedAt || r.outcomeAt || new Date(now).toISOString(),
      outcomeReason: issue.stateReason || 'auto-derived from tracker state'
    };
    const ok = await store.saveOne(outcomeId(appId, r.slug), next).then(() => true, () => false);
    if (ok) updated += 1;
  }
  return updated;
}
