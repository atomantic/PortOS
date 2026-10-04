/** Repair legacy prompt-only canon once, without generating new content or seeds. */
export default {
  async up() {
    // Keep this service graph off migration/status imports until the write runs.
    const { listUniverses } = await import('../../server/services/universeBuilder.js');
    const { backfillCanonDescriptionsFromPrompts, DESC_FIELD } = await import('../../server/services/universeCanon.js');
    const { BIBLE_KINDS, BIBLE_FIELD } = await import('../../server/lib/storyBible.js');
    const universes = await listUniverses();
    let updated = 0;
    let filled = 0;
    for (const universe of universes) {
      const hasLegacyEntries = BIBLE_KINDS.some((kind) =>
        (universe[BIBLE_FIELD[kind]] || []).some((entry) =>
          entry.locked !== true
          && !(entry[DESC_FIELD[kind]] || '').trim()
          && !(kind === 'character' && (entry.description || '').trim())
          && typeof entry.prompt === 'string' && entry.prompt.trim(),
        ),
      );
      if (!hasLegacyEntries) continue;
      // The service re-reads under the record write queue and rechecks locks.
      const { report } = await backfillCanonDescriptionsFromPrompts(universe.id);
      if (report.filled > 0) updated += 1;
      filled += report.filled;
    }
    console.log(`📝 migration 422: canon description backfill updated=${updated} filled=${filled}`);
    return { updated, filled };
  },
};
