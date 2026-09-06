import { join } from 'node:path';
import { atomicWrite, readJSONFileStrict, tryReadFile } from '../../server/lib/fileUtils.js';

/**
 * Register the provider connection graph and park a recovery copy of its INPUT
 * (issue #6367, design record
 * `docs/plans/2026-09-06-provider-connections-and-harnesses.md`).
 *
 * The import itself cannot run here. `ai_connections` / `ai_harness_bindings` /
 * `ai_route_bindings` are created by `ensureSchema()` at boot, and this file
 * runner executes BEFORE the database phase — the same ordering that makes
 * migrations 048-052 and 108 stub registrations. The import instead runs in the
 * database phase (`reconcileProviderGraph` in `bootstrapSequence.js` →
 * `initProviderGraph`), where the tables exist and the toolkit is warm.
 *
 * What this migration DOES own is the part that must happen before anything can
 * write to `data/providers.json` under a graph-aware server: a private,
 * untouched copy of the provider file as it stood before the graph existed. The
 * import is designed to be lossless and is proven so by round-trip tests, but a
 * recovery copy costs one small file and turns "the import mangled my custom
 * route" from unrecoverable into a diff.
 *
 * GATED ON THE INPUT, never on the absence of the output (root `AGENTS.md`): it
 * runs when `data/providers.json` exists, and skips when it does not. The
 * output is DERIVED, so it ships no `data.reference/` seed and its path is
 * declared in `scripts/lib/migrationOwnedPaths.js`. Re-run safety comes from
 * the applied-list plus the explicit "already parked" check below — a second
 * run must never overwrite the pre-graph copy with a post-graph file.
 */
export default {
  async up({ rootDir }) {
    const input = join(rootDir, 'data/providers.json');
    const { ok, value } = await readJSONFileStrict(input, null);
    if (!ok) throw new Error('Cannot migrate an unreadable data/providers.json');
    if (!value) return { success: true, skipped: 'no providers.json' };

    const recovery = join(rootDir, 'data/private/providers.pre-graph.json');
    if (await tryReadFile(recovery) !== null) {
      return { success: true, skipped: 'recovery copy already parked' };
    }

    await atomicWrite(recovery, value);
    const count = Object.keys(value.providers || {}).length;
    console.log(`🔗 Parked a pre-graph copy of ${count} provider records; the graph import runs at boot`);
    return { success: true };
  },
};
