/**
 * Seed the shipped `Reality` universe (#7616, epic #7609).
 *
 * Factual/autobiographical capture had no home: every universe was fiction, so
 * a voice memo or a journal entry got extracted through a story lens. Phase 2
 * put a `factual` flag on the universe record; this migration gives every
 * install one factual world from first boot, so the flag has something to be
 * true of.
 *
 * Why a MIGRATION and not a `data.reference/` seed: universes are Postgres
 * rows (`server/lib/db/schema/universes.js`), and `scripts/setup-data.js` only
 * copies files into `data/`. There is no `data/universes/` file to seed on a
 * PG install, so the seeding mechanism has to be code that writes a row. Note
 * this is NOT the "derived from the install's own records" case that
 * `scripts/lib/migrationOwnedPaths.js` governs — that list is about `data/`
 * FILE paths, and this migration writes no file at all.
 *
 * Shape decisions:
 *   - **Deterministic id `universe-reality`** (matches `UNIVERSE_ID_RE`), not
 *     a `randomUUID()`. A user commonly federates several machines; each one
 *     runs this migration itself, and a random id would give them one Reality
 *     per install that then all sync to each other. One fixed id makes the
 *     copies converge on a single record under the normal LWW merge.
 *   - **Empty logline / premise / styleNotes.** Reality is the user's own
 *     life; inventing copy for it would be wrong, and generating copy is
 *     barred outright — AGENTS.md "No cold-bootstrap LLM calls" rules out an
 *     LLM call on a boot path.
 *   - **Not `ephemeral`**, so it federates like any other universe.
 *
 * Re-run safety: the applied-list already stops a second run, but the record
 * check is the real guard — an install can also reach this code with the row
 * already synced in from a peer.
 *
 * TOMBSTONE CONTRACT (the subtle part): the check is "does ANY row exist with
 * this id", `deleted` true or false — not "is there a live row". A user who
 * deleted Reality must not have it resurrected by the next upgrade, and a
 * tombstone is exactly the record of that decision. `insertUniverseWithId`
 * deliberately OVERWRITES a tombstone (its `wasResurrection` branch), which is
 * right for a share-bucket re-import and wrong here, so the emptiness check
 * lives here rather than as a `resurrect: false` option on the shared importer.
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
