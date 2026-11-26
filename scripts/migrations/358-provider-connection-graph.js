import { join } from 'node:path';
import { atomicWrite, readJSONFileStrict, tryReadFile } from '../../server/lib/fileUtils.js';

/**
 * Register the provider connection graph and park a recovery copy of its INPUT (issue #6367).
 *
 * The import itself can't run here: `ai_connections` / `ai_harness_bindings` / `ai_route_bindings` are created by `ensureSchema()` at boot, after this file runner (as for migrations 048-052 and 108), so it runs in the database phase (`reconcileProviderGraph` in `bootstrapSequence.js` → `initProviderGraph`).
 * This migration owns what must precede any write to `data/providers.json` under a graph-aware server: a private, untouched copy of the pre-graph provider file (the import is lossless per round-trip tests, but a copy turns "the import mangled my custom route" into a diff).
 * GATED ON THE INPUT, never the absence of the output (root `AGENTS.md`): it runs when `data/providers.json` exists and skips otherwise. The output is DERIVED, so no `data.reference/` seed, and its path is declared in `scripts/lib/migrationOwnedPaths.js`. Re-run safety: the applied-list plus the "already parked" check below; a second run must never overwrite the pre-graph copy with a post-graph file.
 */
/** Derived paths relative to `data/`; never ship reference seeds. */
export const OWNED_OUTPUT_PATHS = ['private/providers.pre-graph.json'];

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
