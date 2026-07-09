/**
 * Postgres-backed round-trip for the opt-out automation engine (issue #2145).
 * Exercises the REAL case-ledger state machine (privacyBrokers.transitionCase)
 * through the lanes + verification pass, so the transitions the pure test mocks
 * are proven against the actual DB constraints. Skips cleanly when no test DB is
 * reachable. Runs via `npm run test:db` (→ portos_test) ONLY.
 *
 * Message drafts + accounts are injected (not the file-backed real ones) so the
 * suite touches only Postgres. Cleans up its own broker + cases.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';

const originalKey = process.env.PRIVACY_VAULT_KEY;
process.env.PRIVACY_VAULT_KEY = 'e'.repeat(64);

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'privacy_broker_cases') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'privacy_broker_cases table not present';
  }
}

if (!dbReady) console.log(`⏭️  privacyOptOut.db.test.js skipped: ${skipReason}`);

describe.skipIf(!dbReady)('privacy opt-out engine DB round-trip', () => {
  let svc; // privacyOptOut
  let brokers; // privacyBrokers
  let vault;
  const brokerId = 'test-optout-broker';
  const emailBrokerId = 'test-optout-email';
  const createdVaultIds = [];

  const account = { id: 'acct-test', type: 'gmail' };
  const injectedAccounts = async () => [account];
  const drafts = [];
  const injectedDraftCreator = async (d) => { const draft = { id: `draft-${drafts.length + 1}`, status: 'draft', ...d }; drafts.push(draft); return draft; };
  const injectedApprover = async (id) => ({ id, status: 'approved' });

  beforeAll(async () => {
    svc = await import('./privacyOptOut.js');
    brokers = await import('./privacyBrokers.js');
    vault = await import('./privacyVault.js');
    // Clean slate for cases so cross-suite ordering can't leak state in.
    await query(`DELETE FROM privacy_broker_cases`).catch(() => {});
    // A web-form broker + an email broker, inserted directly (auto source so the
    // curated seed idempotency is untouched).
    for (const [id, name, optout, antibot] of [
      [brokerId, 'Test OptOut Broker', { method: 'web_form', url: 'https://test-optout.example/optout', playbook: ['step 1'] }, false],
      [emailBrokerId, 'Test OptOut Email', { method: 'email', email: 'privacy@test-optout.example', url: 'https://test-optout.example' }, false],
    ]) {
      await query(
        `INSERT INTO privacy_brokers (id, name, urls, optout, tier, disclosure_fields, source, confidence, enabled, created_at, updated_at)
         VALUES ($1,$2,$3,$4,2,$5,'badbool','auto',TRUE,NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
        [id, name, JSON.stringify({ home: 'https://test-optout.example' }), JSON.stringify(optout), ['full_name', 'email', 'city', 'state', 'listing_url']],
      );
    }
    // A scan-eligible name so the disclosure payload has an identity.
    const rec = await vault.createVaultRecord({ type: 'legal_name', label: 'Legal', value: 'Jane Q Testcase', useForScans: true });
    createdVaultIds.push(rec.id);
    const addr = await vault.createVaultRecord({ type: 'address', label: 'Home', value: 'Portland, OR', useForScans: true });
    createdVaultIds.push(addr.id);
  });

  afterAll(async () => {
    for (const id of createdVaultIds) await query(`DELETE FROM privacy_vault_records WHERE id = $1`, [id]).catch(() => {});
    await query(`DELETE FROM privacy_broker_cases WHERE broker_id = ANY($1)`, [[brokerId, emailBrokerId]]).catch(() => {});
    await query(`DELETE FROM privacy_brokers WHERE id = ANY($1)`, [[brokerId, emailBrokerId]]).catch(() => {});
    await close();
    if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
    else process.env.PRIVACY_VAULT_KEY = originalKey;
  });

  it('emailLane drives a found case found → submitted in the ledger', async () => {
    const kase = await brokers.recordScanVerdict(emailBrokerId, 'found', { evidence: { listing_urls: ['https://test-optout.example/p/jane'] }, found: true });
    const broker = await brokers.getBroker(emailBrokerId);
    const payload = { full_name: 'Jane Q Testcase', email: 'jane@example.com', city: 'Portland', state: 'OR' };
    const disclosed = svc.computeDisclosedFields(broker, payload, { listingUrls: ['https://test-optout.example/p/jane'] });
    const res = await svc.emailLane(broker, kase, {
      disclosedFields: disclosed, payload, listingUrls: ['https://test-optout.example/p/jane'],
      autoApprove: false, accountsProvider: injectedAccounts, draftCreator: injectedDraftCreator, draftApprover: injectedApprover,
    });
    expect(res.outcome).toBe('submitted');
    const persisted = await brokers.getCaseForBroker(emailBrokerId);
    expect(persisted.state).toBe('submitted');
    expect(persisted.channel).toBe('email');
    expect(persisted.disclosedFields).toContain('full_name');
  });

  it('webFormLane default (auto-submit off) queues a human task in the ledger', async () => {
    const kase = await brokers.recordScanVerdict(brokerId, 'found', { evidence: {}, found: true });
    const broker = await brokers.getBroker(brokerId);
    const res = await svc.webFormLane(broker, kase, {
      disclosedFields: ['full_name'], payload: { full_name: 'Jane Q Testcase' }, listingUrls: [], autoSubmit: false,
    });
    expect(res.outcome).toBe('human_task_queued');
    const persisted = await brokers.getCaseForBroker(brokerId);
    expect(persisted.state).toBe('human_task_queued');
  });

  it('getOptOutDigest surfaces the queued human task with its playbook', async () => {
    const digest = await svc.getOptOutDigest();
    const item = digest.items.find((i) => i.brokerId === brokerId);
    expect(item).toBeTruthy();
    expect(item.playbook).toEqual(['step 1']);
    expect(item.optoutUrl).toBe('https://test-optout.example/optout');
  });

  it('verification advances submitted → verification_pending → confirmed_removed', async () => {
    // The email broker case is `submitted`. A trusted confirmation email advances it.
    const messagesProvider = async () => ({ messages: [{ id: 'm1', subject: 'Confirm your opt-out request', body: 'Click https://test-optout.example/confirm?t=1 to complete your removal.' }] });
    const advance = await svc.runVerificationPass({
      messagesProvider,
      removalProbe: async () => ({ skipped: true, reason: 'inconclusive' }),
    });
    expect(advance.advanced.some((a) => a.brokerId === emailBrokerId)).toBe(true);
    expect((await brokers.getCaseForBroker(emailBrokerId)).state).toBe('verification_pending');

    // A verifying re-scan that finds nothing → confirmed_removed (only path).
    const confirm = await svc.runVerificationPass({
      messagesProvider: async () => ({ messages: [] }),
      removalProbe: async (broker) => (broker.id === emailBrokerId ? { verdict: 'not_found' } : { skipped: true }),
    });
    expect(confirm.confirmed.some((c) => c.brokerId === emailBrokerId)).toBe(true);
    expect((await brokers.getCaseForBroker(emailBrokerId)).state).toBe('confirmed_removed');
  });
});
