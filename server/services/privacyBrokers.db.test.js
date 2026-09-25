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
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

const runDb = requireDbOrSkip('services/privacyBrokers.db.test', dbReady, skipReason);

describe.skipIf(!runDb)('privacy brokers DB round-trip', () => {
  let svc;
  let scan;
  let vault;
  const autoBrokerIds = [
    'test-auto-alpha', 'ca-test-beta-inc', 'test-auto-upgrade',
    'test-evidence-seal', 'test-evidence-erase', 'test-evidence-legacy', 'test-evidence-vault',
  ];
  const createdVaultIds = [];
  const vaultTableWasEmpty = false;
  const testStart = new Date().toISOString();

  beforeAll(async () => {
    svc = await import('./privacyBrokers.js');
    scan = await import('./privacyScan.js');
    vault = await import('./privacyVault.js');
    // The scan pass needs an explicit broker_scan grant (#8332) — the seeded
    // `self` row holds only local-vault consent. Removed in afterAll.
    const subjects = await import('./privacySubjects.js');
    await subjects.recordConsent({ scope: 'broker_scan', method: 'self', note: 'privacyBrokers.db.test' });
  });

  afterAll(async () => {
    for (const id of createdVaultIds) {
      await query(`DELETE FROM privacy_vault_records WHERE id = $1`, [id]).catch(() => {});
    }
    await query(`DELETE FROM privacy_consents WHERE scope IN ('pii_vault', 'broker_scan') AND granted_at >= $1`, [testStart]).catch(() => {});
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

  it('ensureSeeded updates curated brokers on version upgrade while preserving user settings and auto sources (#4019)', async () => {
    svc.resetEnsureSeededForTests();
    // 1. Disable a curated broker to verify user-modified setting is preserved
    await svc.setBrokerEnabled('spokeo', false);

    // 2. Insert a dummy non-curated broker to verify auto sources are preserved
    await query(
      `INSERT INTO privacy_brokers (id, name, urls, optout, tier, disclosure_fields, source, confidence, enabled, created_at, updated_at)
       VALUES ('test-auto-upgrade', 'Auto Upgrade', '{}', '{}', 2, '{}', 'badbool', 'auto', true, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
    );

    // 3. Mutate a curated broker's field in DB to simulate an older version record
    await query(`UPDATE privacy_brokers SET name = 'Old Spokeo Name' WHERE id = 'spokeo'`);

    // 4. Trigger ensureSeeded
    svc.resetEnsureSeededForTests();
    await svc.ensureSeeded();

    // 5. Verify curated broker definition is updated from seed file (name restored)
    const spokeo = await svc.getBroker('spokeo');
    expect(spokeo.name).toBe('Spokeo');
    // Verify user-modified enabled setting (false) was preserved
    expect(spokeo.enabled).toBe(false);

    // 6. Verify non-curated broker was untouched
    const autoBroker = await svc.getBroker('test-auto-upgrade');
    expect(autoBroker).toMatchObject({ name: 'Auto Upgrade', source: 'badbool' });

    // Cleanup
    await svc.setBrokerEnabled('spokeo', true);
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

  // ─── Sealed identity evidence (#8333) ─────────────────────────────────────
  // Fake identity values, distinctive enough that a substring hit on the raw
  // JSONB column (what pg_dump writes) can only mean a plaintext copy.
  const IDENTITY = {
    matched_name: 'Jane Q Sealtest',
    matched_location: 'Sealville',
    search_url: 'https://seal-broker.example/Jane-Sealtest/Sealville',
    listing_urls: ['https://seal-broker.example/p/jane-sealtest'],
  };
  const insertTestBroker = (id) => query(
    `INSERT INTO privacy_brokers (id, name, source, confidence, enabled, created_at, updated_at)
     VALUES ($1, $1, 'badbool', 'auto', FALSE, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`, [id],
  );
  const rawEvidence = async (caseId) => (await query(
    `SELECT evidence::text AS t FROM privacy_broker_cases WHERE id = $1`, [caseId],
  )).rows[0].t;
  const expectNoPlaintextIdentity = (text) => {
    for (const needle of ['Sealtest', 'Sealville', 'seal-broker.example']) expect(text).not.toContain(needle);
  };

  it('stores scan identity evidence sealed, reveals it on request, and erases it on confirmed_removed', async () => {
    await insertTestBroker('test-evidence-seal');
    const kase = await svc.recordScanVerdict('test-evidence-seal', 'found', {
      evidence: { match_basis: 'name+location', ...IDENTITY }, found: true,
    });
    // At rest (and so in every dump): no plaintext name, location, or URL.
    expectNoPlaintextIdentity(await rawEvidence(kase.id));
    // The API projection carries the verdict metadata + a summary, never the identity.
    expect(kase.evidence).toEqual({ match_basis: 'name+location' });
    expect(kase.identityEvidence).toEqual({ sealed: true, listingCount: 1 });
    expect((await svc.revealCaseEvidence(kase.id)).evidence).toEqual(IDENTITY);

    // Lifecycle transitions that restate workflow metadata carry the envelope forward.
    await svc.transitionCase(kase.id, 'optout_in_progress', { evidence: { lane: 'web_form' } });
    await svc.transitionCase(kase.id, 'submitted');
    const pending = await svc.transitionCase(kase.id, 'verification_pending');
    expect(pending.identityEvidence).toEqual({ sealed: true, listingCount: 1 });
    expect((await svc.revealCaseEvidence(kase.id)).evidence.search_url).toBe(IDENTITY.search_url);

    // The verifying re-scan's confirmed_removed erases the identity copy but
    // keeps the non-identifying evidence, the state, and the case history.
    const removed = await svc.transitionCase(kase.id, 'confirmed_removed', { viaRescan: true });
    expect(removed.state).toBe('confirmed_removed');
    expect(removed.identityEvidence).toBe(null);
    expect(removed.evidence).toEqual({ lane: 'web_form' });
    expect(new Date(removed.createdAt).getTime()).toBe(new Date(kase.createdAt).getTime());
    expect(await rawEvidence(kase.id)).not.toContain('sealed_identity');
    expect(await svc.revealCaseEvidence(kase.id)).toEqual({ caseId: kase.id, sealed: false, evidence: {} });
  });

  it('erases one case\'s identity evidence on request, keeping its state and verdict', async () => {
    await insertTestBroker('test-evidence-erase');
    const kase = await svc.recordScanVerdict('test-evidence-erase', 'blocked', {
      evidence: { match_basis: 'antibot_wall', search_url: IDENTITY.search_url },
    });
    const cleared = await svc.clearCaseIdentityEvidence(kase.id);
    expect(cleared).toMatchObject({ state: 'blocked', evidence: { match_basis: 'antibot_wall' }, identityEvidence: null });
    // Gone from later API responses too.
    const listed = (await svc.listBrokerCases()).find((c) => c.id === kase.id);
    expect(listed.identityEvidence).toBe(null);
    expect((await svc.revealCaseEvidence(kase.id)).evidence).toEqual({});
    await expect(svc.clearCaseIdentityEvidence('00000000-0000-4000-8000-00000000dead')).rejects.toMatchObject({ status: 404 });
  });

  it('converts a legacy plaintext case idempotently, and a failed conversion changes nothing', async () => {
    await insertTestBroker('test-evidence-legacy');
    const legacyId = '00000000-0000-4000-8000-0000000833aa';
    await query(
      `INSERT INTO privacy_broker_cases (id, broker_id, state, found, evidence, next_recheck_at, created_at, updated_at)
       VALUES ($1, 'test-evidence-legacy', 'found', TRUE, $2, NOW(), NOW(), NOW())`,
      [legacyId, JSON.stringify({ match_basis: 'name+location', ...IDENTITY })],
    );
    const before = await rawEvidence(legacyId);

    // No usable key and an unwritable .env: the conversion cannot seal, so the
    // read that triggered it fails and the row is left exactly as it was.
    const vaultCrypto = await import('../lib/vaultCrypto.js');
    const blockerDir = mkdtempSync(join(tmpdir(), 'portos-8333-'));
    writeFileSync(join(blockerDir, 'not-a-dir'), '');
    const savedKey = process.env.PRIVACY_VAULT_KEY;
    delete process.env.PRIVACY_VAULT_KEY;
    vaultCrypto.__setVaultEnvPathForTests(join(blockerDir, 'not-a-dir', '.env'));
    svc.__resetCaseEvidenceSealForTests();
    try {
      await expect(svc.listBrokerCases()).rejects.toThrow();
      expect(await rawEvidence(legacyId)).toBe(before);
    } finally {
      process.env.PRIVACY_VAULT_KEY = savedKey;
      vaultCrypto.__setVaultEnvPathForTests(null);
      rmSync(blockerDir, { recursive: true, force: true });
    }

    // With the key back, the next read converts before returning anything.
    const listed = (await svc.listBrokerCases()).find((c) => c.id === legacyId);
    expect(listed.evidence).toEqual({ match_basis: 'name+location' });
    expect(listed.identityEvidence).toEqual({ sealed: true, listingCount: 1 });
    expectNoPlaintextIdentity(await rawEvidence(legacyId));
    expect((await svc.revealCaseEvidence(legacyId)).evidence).toEqual(IDENTITY);
    // Idempotent: a second conversion pass leaves the sealed row byte-identical
    // (it is not re-encrypted, which would mint a new IV).
    const sealed = await rawEvidence(legacyId);
    svc.__resetCaseEvidenceSealForTests();
    await svc.listBrokerCases();
    expect(await rawEvidence(legacyId)).toBe(sealed);
  });

  it('deleting the source vault record leaves no identity copy in the case API or the stored row', async () => {
    await insertTestBroker('test-evidence-vault');
    const nameRec = await vault.createVaultRecord({ type: 'legal_name', label: 'Seal test name', value: IDENTITY.matched_name });
    const kase = await svc.recordScanVerdict('test-evidence-vault', 'found', {
      evidence: { match_basis: 'name+location', ...IDENTITY }, found: true,
    });
    expect(kase.identityEvidence?.sealed).toBe(true);

    await vault.deleteVaultRecord(nameRec.id);
    const after = await svc.getCaseForBroker('test-evidence-vault');
    expect(after.state).toBe('found');
    expect(after.identityEvidence).toBe(null);
    expect(after.evidence).toEqual({ match_basis: 'name+location' });
    const raw = await rawEvidence(kase.id);
    expectNoPlaintextIdentity(raw);
    expect(raw).not.toContain('sealed_identity');
  });

  it('reports scan status counts', async () => {
    const status = await svc.getScanStatus();
    expect(status.enabledBrokers).toBeGreaterThan(0);
    expect(typeof status.caseCounts).toBe('object');
    expect(typeof status.dueForRecheck).toBe('number');
  });
});
