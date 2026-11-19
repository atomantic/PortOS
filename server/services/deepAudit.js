/**
 * Read-only access to historical Deep certification ledgers.
 *
 * Storage: `db-primary` — machine-local, never federated. The multi-pass certification engine that
 * created and mutated `deep_audit_ledgers` rows was retired (#16910); remaining rows are evidence
 * served by GET /api/cos/schedule/deep-audits/:id. Nothing writes them anymore.
 */
import { ensureSchema, query } from '../lib/db.js';

export async function getDeepAuditLedger(id) {
  await ensureSchema();
  const { rows } = await query('SELECT ledger FROM deep_audit_ledgers WHERE id=$1', [id]);
  return rows[0]?.ledger ?? null;
}
