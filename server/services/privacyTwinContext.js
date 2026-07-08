/**
 * Privacy → Digital Twin context bridge (issue #2147, epic #2138).
 *
 * Builds a compact identity-dossier block from the encrypted PII vault for
 * injection into the digital twin's agent prompts. Sharing PII with agent
 * prompts is opt-in TWICE:
 *   - per-field: only vault records the user flagged `share_with_twin = true`
 *     (enforced here by the WHERE clause);
 *   - global:    only when the twin setting `includePrivacyContext` is on
 *     (enforced by the caller in digital-twin-context.js).
 *
 * Vault values are decrypted AT INJECTION TIME ONLY and are NEVER cached to
 * disk or logged — the returned string is handed straight into the in-memory
 * prompt and discarded. Logs carry counts only, mirroring the vault's
 * plaintext-never-logged posture (see privacyVault.js).
 *
 * Degrades gracefully when the privacy tables haven't been provisioned yet (a
 * fresh install before the migrations run, or the Phase 5/6 broker tables that
 * don't exist yet): a missing table yields an empty/omitted section via a
 * `to_regclass` existence gate rather than throwing, so the twin prompt builder
 * never fails just because Privacy Center isn't set up.
 */

import { query } from '../lib/db.js';
import { PRIVACY_SENSITIVE_TYPES } from '../lib/privacyValidation.js';
// vaultCrypto is imported lazily (inside getPrivacyTwinContext) so merely
// importing this module — which digital-twin-context.js does at top level —
// doesn't eagerly evaluate vaultCrypto's install-root .env path resolution.
// It's only needed when a context block is actually being built (which already
// requires a live DB), and dynamic import stays subject to the same vi.mock.

// Broker-case states that count as "confirmed removed" for the posture line.
// The Phase 5/6 state machine is not built yet; treat this as a
// forward-compatible superset — anything else is "pending".
const REMOVED_BROKER_STATES = new Set(['removed', 'confirmed_removed', 'suppressed']);

/** One-line "Organizations on file" summary (counts by trust + category span). */
async function buildOrgSummary() {
  const { rows } = await query(`SELECT trust, category FROM privacy_orgs`);
  if (rows.length === 0) return '';
  const byTrust = {};
  const categories = new Set();
  for (const row of rows) {
    byTrust[row.trust] = (byTrust[row.trust] || 0) + 1;
    if (row.category) categories.add(row.category);
  }
  const trustParts = Object.entries(byTrust)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([trust, n]) => `${n} ${trust}`)
    .join(', ');
  const categoryWord = categories.size === 1 ? 'category' : 'categories';
  return `Organizations on file: ${rows.length} (${trustParts}) across ${categories.size} ${categoryWord}.`;
}

/** One-line data-broker opt-out posture (only when Phase 5/6 tables exist). */
async function buildBrokerPosture() {
  const { rows } = await query(`SELECT state FROM privacy_broker_cases`);
  if (rows.length === 0) return '';
  let removed = 0;
  for (const row of rows) if (REMOVED_BROKER_STATES.has(row.state)) removed += 1;
  const pending = rows.length - removed;
  return `Data-broker posture: ${removed} confirmed removed, ${pending} pending.`;
}

/**
 * Compact identity-context block from the vault, or '' when nothing is shared
 * (no flagged records and no orgs) or Privacy Center is not provisioned. The
 * caller is responsible for the GLOBAL gate (`includePrivacyContext`) and for
 * fitting the block into the twin's token budget.
 */
export async function getPrivacyTwinContext() {
  // Single round-trip existence gate — a null column means the table is absent.
  const { rows: tableRows } = await query(
    `SELECT to_regclass('public.privacy_vault_records') AS vault,
            to_regclass('public.privacy_orgs')          AS orgs,
            to_regclass('public.privacy_broker_cases')  AS broker`,
  );
  const tables = tableRows[0] ?? {};
  // No vault table ⇒ Privacy Center not provisioned; nothing to inject.
  if (!tables.vault) return '';

  const sections = [];

  // Per-field gate: only records the user explicitly flagged for the twin.
  // Sensitive types (SSN, passport, driver's license, financial account) are
  // NEVER injected into a prompt even if flagged — the same never-disclose
  // posture as broker scans (use_for_scans), enforced here so an already-stored
  // flag on a sensitive record can't leak highly-sensitive IDs into an LLM.
  const { rows: records } = await query(
    `SELECT type, label, status, value_enc
     FROM privacy_vault_records
     WHERE share_with_twin = true
       AND type <> ALL($1::text[])
     ORDER BY type, label`,
    [PRIVACY_SENSITIVE_TYPES],
  );
  if (records.length > 0) {
    const { decryptValue } = await import('../lib/vaultCrypto.js');
    const lines = records.map((row) => {
      const value = decryptValue(row.value_enc); // decrypt at injection time only
      const suffix = row.status === 'previous' ? ' (previous)' : '';
      return `- ${row.label} — ${row.type}${suffix}: ${value}`;
    });
    sections.push(
      '# Identity Facts (Privacy Vault)\n'
      + 'Authoritative, user-verified identity facts. Treat these as the source '
      + "of truth for the user's legal name, contact details, and addresses.\n"
      + lines.join('\n'),
    );
  }

  // Org summary + broker posture only when their tables exist (graceful degrade).
  const posture = [];
  if (tables.orgs) {
    const orgLine = await buildOrgSummary();
    if (orgLine) posture.push(orgLine);
  }
  if (tables.broker) {
    const brokerLine = await buildBrokerPosture();
    if (brokerLine) posture.push(brokerLine);
  }
  if (posture.length > 0) sections.push(posture.join('\n'));

  if (sections.length === 0) return '';
  console.log(`🔐 Built privacy twin context (${records.length} vault fact(s))`);
  return sections.join('\n\n');
}
