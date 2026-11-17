/**
 * Seed the shipped `Reality` universe (#7616, epic #7609).
 *
 * Factual/autobiographical capture had no home (every universe was fiction, so a voice memo got extracted through a story lens); Phase 2 added a `factual` flag on the universe record and this gives every install one factual world from first boot.
 *
 * A MIGRATION, not a `data.reference/` seed: universes are Postgres rows (`server/lib/db/schema/universes.js`) and `scripts/setup-data.js` only copies files into `data/`. This is NOT the "derived from the install's own records" case of `scripts/lib/migrationOwnedPaths.js` (that list governs `data/` FILE paths).
 *
 * Shape: deterministic id `universe-reality` (matches `UNIVERSE_ID_RE`), not a `randomUUID()`: federated machines each run this, and a random id would give one Reality per install that all sync to each other, while a fixed id converges under LWW. Empty logline / premise / styleNotes
 * (Reality is the user's own life, and AGENTS.md "No cold-bootstrap LLM calls" bars generating copy on a boot path). Not `ephemeral`, so it federates. Re-run safety: the applied-list stops a second run but the record check is the real guard (the row may already have synced in from a peer).
 *
 * TOMBSTONE CONTRACT: the check is "does ANY row exist with this id", `deleted` true or false, so a deleted Reality is not resurrected by the next upgrade. `insertUniverseWithId` deliberately OVERWRITES a tombstone (`wasResurrection`), right for a share-bucket re-import and wrong here, so the check lives here rather than as a `resurrect: false` option on the shared importer.
 */

import { store, insertUniverseWithId } from '../../server/services/universeBuilder.js';

export const REALITY_UNIVERSE_ID = 'universe-reality';
const REALITY_UNIVERSE_NAME = 'Reality';

export default {
  async up() {
    // loadOneRaw, not loadOne: the raw read returns the stored row untouched,
    // including a tombstone, which is the thing we must not write over.
    const existing = await store().loadOneRaw(REALITY_UNIVERSE_ID);
    if (existing) {
      const why = existing.deleted ? 'deleted by the user' : 'already present';
      console.log(`🌍 migration 395: Reality universe ${why} — leaving it alone`);
      return { updated: 0, reason: existing.deleted ? 'tombstoned' : 'already-seeded' };
    }

    await insertUniverseWithId({
      id: REALITY_UNIVERSE_ID,
      name: REALITY_UNIVERSE_NAME,
      factual: true,
      // Left blank deliberately — see the header. The user fills these in.
      starterPrompt: '',
      logline: '',
      premise: '',
      styleNotes: '',
    });
    console.log(`🌍 migration 395: seeded the factual "${REALITY_UNIVERSE_NAME}" universe (${REALITY_UNIVERSE_ID})`);
    return { updated: 1 };
  },
};
