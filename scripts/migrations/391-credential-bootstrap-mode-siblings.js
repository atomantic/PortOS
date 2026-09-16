/**
 * Converge a CLI/TUI pair whose credential bootstrap landed on only ONE mode.
 *
 * The AI Providers page renders a conventional pair as one card and opens the
 * editor on its representative (the CLI mode), but `updateProvider` did not fan
 * `credentialBootstrap` out to the sibling — so a Bootstrap Command typed into
 * that one editor never reached the TUI record, which is what "Launch in Shell"
 * spawns. The fan-out is fixed in `sharedModeUpdates` and `unifyProviderModes`
 * now repairs a pair that arrived asymmetric anyway; this is the one-time pass
 * over an install that configured one before either existed.
 *
 * It is the migration-355 wrapper on purpose: the convergence rule lives beside
 * the pairing rule it belongs to and runs on every `providers.json` read, so an
 * asymmetric pair arriving later — peer sync, a hand edit, a restored backup —
 * heals without waiting for a migration.
 */

import { unifyProviderModes } from '../../server/lib/aiToolkit/internal/providerModes.js';
import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

async function up({ rootDir }) {
  const doc = await readProvidersDoc({ rootDir });
  if (!doc.ok) {
    if (doc.reason === 'no-file') console.log('📄 data/providers.json not present — skipping credential-bootstrap sibling repair');
    else if (doc.reason === 'unreadable') console.log(`⚠️ data/providers.json: invalid JSON, skipping (${doc.err.message})`);
    else console.log('⚠️ data/providers.json: unexpected shape, skipping');
    return { ok: false, reason: doc.reason, updated: 0 };
  }

  const changed = unifyProviderModes(doc.config);
  if (changed) {
    await writeJsonAtomic(doc.path, doc.config);
    console.log('🔑 data/providers.json: converged CLI/TUI mode siblings (credential bootstrap, enablement, models)');
  }
  return { ok: true, updated: changed ? 1 : 0 };
}

export default { up };
