/**
 * Postgres-backed round-trip for the data-broker database + case ledger
 * (issue #2144). Skips cleanly when no DB is reachable (CI, fresh checkout);
 * runs the seed/refresh/ledger surface when one is. Cleans up only the auto
 * (non-curated) brokers + cases it creates — the curated seed is idempotent and
 * left in place. Runs via `npm run test:db` (→ portos_test) ONLY; db.js guards
 * refuse writes to a non-test DB.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';

// A valid vault key BEFORE privacyVault is imported so the runScanPass test can
// create a scan-eligible name without touching the repo's real .env.
const originalKey = process.env.PRIVACY_VAULT_KEY;
process.env.PRIVACY_VAULT_KEY = 'd'.repeat(64);

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'privacy_brokers') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'privacy_brokers table not present';
  }
}

if (!dbReady) console.log(`⏭️  privacyBrokers.db.test.js skipped: ${skipReason}`);

describe.skipIf(!dbReady)('privacy brokers DB round-trip', () => {
  let svc;
  let scan;
  let vault;
  const autoBrokerIds = ['test-auto-alpha', 'ca-test-beta-inc'];
  const createdVaultIds = [];
  const vaultTableWasEmpty = false;
  const testStart = new Date().toISOString();

  beforeAll(async () => {
    svc = await import('./privacyBrokers.js');
    scan = await import('./privacyScan.js');
    vault = await import('./privacyVault.js');
  });

  afterAll(async () => {
    for (const id of createdVaultIds) {
      await query(`DELETE FROM privacy_vault_records WHERE id = $1`, [id]).catch(() => {});
    }
    await query(`DELETE FROM privacy_consents WHERE scope = 'pii_vault' AND granted_at >= $1`, [testStart]).catch(() => {});
    for (const id of autoBrokerIds) {
      await query(`DELETE FROM privacy_broker_cases WHERE broker_id = $1`, [id]).catch(() => {});
      await query(`DELETE FROM privacy_brokers WHERE id = $1`, [id]).catch(() => {});
    }
    // Drop the curated brokers' cases this suite created so a re-run starts clean.
    await query(`DELETE FROM privacy_broker_cases`).catch(() => {});
    await close();
    if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
    else process.env.PRIVACY_VAULT_KEY = originalKey;
  });

  it('seeds the curated brokers idempotently with the cluster wired up', async () => {
    const first = await svc.seedCuratedBrokers();
    const { rows: c1 } = await query(`SELECT COUNT(*)::int AS n FROM privacy_brokers WHERE source = 'curated'`);
    await svc.seedCuratedBrokers(); // second run must not duplicate
    const { rows: c2 } = await query(`SELECT COUNT(*)::int AS n FROM privacy_brokers WHERE source = 'curated'`);
    expect(first.seeded).toBeGreaterThan(0);
    expect(c2[0].n).toBe(c1[0].n);

    const parent = await svc.getBroker('peopleconnect');
    expect(parent.preferSuppression).toBe(true);
    const child = await svc.getBroker('truthfinder');
    expect(child.clusterParent).toBe('peopleconnect');
  });

  it('refresh adds auto brokers and NEVER clobbers a curated row', async () => {
    const before = await svc.getBroker('spokeo');
    expect(before.source).toBe('curated');

    const res = await svc.refreshBrokers({
      // A collision on the curated `spokeo` id (must be ignored) + one genuinely
      // new auto broker.
      fetchBadbool: async () => [
        { id: 'spokeo', name: 'HIJACKED', source: 'badbool', confidence: 'auto' },
        { id: 'test-auto-alpha', name: 'Test Auto Alpha', url: 'https://alpha.example' },
      ],
      fetchCaRegistry: async () => [
        { id: 'ca-test-beta-inc', name: 'Beta Inc', urls: { home: 'https://beta.example' }, source: 'ca_registry', confidence: 'auto' },
      ],
    });
    expect(res.added).toBe(2);

    const afterSpokeo = await svc.getBroker('spokeo');
    expect(afterSpokeo.name).toBe(before.name); // curated name preserved
    expect(afterSpokeo.source).toBe('curated');

    const auto = await svc.getBroker('test-auto-alpha');
    expect(auto).toMatchObject({ name: 'Test Auto Alpha', source: 'badbool', confidence: 'auto' });
  });

  it('records a scan verdict, stamps next_recheck_at, and enforces the state machine', async () => {
    const now = new Date('2026-07-08T00:00:00.000Z');
    // Fresh verdict on a curated broker.
    const kase = await svc.recordScanVerdict('test-auto-alpha', 'found', {
      evidence: { match_basis: 'name+location', listing_urls: ['https://alpha.example/jane'] },
      found: true, now,
    });
    expect(kase.state).toBe('found');
    // found → +1 day recheck.
    expect(new Date(kase.nextRecheckAt).toISOString()).toBe('2026-07-09T00:00:00.000Z');
    // rowToCase serializes the server-derived legal manual moves (issue #2417);
    // a found case can always be queued as a human task, never re-stamped itself.
    expect(kase.allowedTransitions).toContain('human_task_queued');
    expect(kase.allowedTransitions).not.toContain('found');

    // Lifecycle forward via transitionCase.
    const submitted = await svc.transitionCase(kase.id, 'optout_in_progress');
    expect(submitted.state).toBe('optout_in_progress');
    const s2 = await svc.transitionCase(kase.id, 'submitted', { channel: 'web_form', now });
    expect(s2.state).toBe('submitted');
    expect(new Date(s2.nextRecheckAt).toISOString()).toBe('2026-07-11T00:00:00.000Z'); // +3d

    // confirmed_removed is refused from a submission path (no rescan).
    await expect(svc.transitionCase(kase.id, 'confirmed_removed'))
      .rejects.toMatchObject({ code: 'CONFIRMED_REQUIRES_RESCAN' });

    // Reach awaiting_processing, then confirm via a verifying rescan.
    await svc.transitionCase(kase.id, 'verification_pending');
    await svc.transitionCase(kase.id, 'awaiting_processing');
    const removed = await svc.transitionCase(kase.id, 'confirmed_removed', { viaRescan: true, now });
    expect(removed.state).toBe('confirmed_removed');
    expect(new Date(removed.nextRecheckAt).toISOString()).toBe('2026-08-07T00:00:00.000Z'); // +30d
  });

  it('a manual transition onto a verdict state syncs the ledger found flag', async () => {
    const now = new Date('2026-07-08T00:00:00.000Z');
    // ca-test-beta-inc: its case is untouched by the lifecycle test above
    // (test-auto-alpha's case ends at confirmed_removed, which blocked can't
    // be recorded over).
    const kase = await svc.recordScanVerdict('ca-test-beta-inc', 'blocked', {
      evidence: { match_basis: 'antibot_wall', search_url: 'https://beta.example/jane' }, now,
    });
    expect(kase.found).toBe(null);
    // The blocked-case "I'm listed" manual verdict implies found: true.
    const confirmed = await svc.transitionCase(kase.id, 'found');
    expect(confirmed.found).toBe(true);
    // And a manual not_found implies found: false; explicit patch still wins.
    const dismissed = await svc.transitionCase(kase.id, 'not_found');
    expect(dismissed.found).toBe(false);
  });

  it('runScanPass scans due brokers, records verdicts, and skips opt-out-owned cases', async () => {
    // A scan-eligible name so buildSearchVectors is non-empty.
    const nameRec = await vault.createVaultRecord({ type: 'legal_name', label: 'Legal name', value: 'Jane Q Publictest' });
    createdVaultIds.push(nameRec.id);
    const addrRec = await vault.createVaultRecord({ type: 'address', label: 'Home', value: '1 Oak Ave, Portland, OR 97201' });
    createdVaultIds.push(addrRec.id);

    // Every broker's static page returns a no-match body → not_found verdicts.
    const fetchImpl = async () => ({ status: 200, text: async () => 'No results found for that search. '.repeat(40) });
    const summary = await scan.runScanPass({ fetchImpl, browserFetch: async () => null, urlSafe: async () => true });
    expect(summary.scanned).toBeGreaterThan(0);
    expect(summary.verdicts.not_found).toBeGreaterThan(0);

    // The confirmed_removed case (opt-out-owned) from the previous test must be
    // untouched — the pass never overwrites it with a raw scan verdict.
    const owned = await svc.getCaseForBroker('test-auto-alpha');
    expect(owned.state).toBe('confirmed_removed');
  });

  it('reports scan status counts', async () => {
    const status = await svc.getScanStatus();
    expect(status.enabledBrokers).toBeGreaterThan(0);
    expect(typeof status.caseCounts).toBe('object');
    expect(typeof status.dueForRecheck).toBe('number');
  });
});
