/**
 * Creative media wire versions (collections, video history, decks, storyboards, mood boards, FableLoom, Creative Director, Commissions) and render pins.
 *
 * One domain slice of `PORTOS_SCHEMA_VERSIONS` (`server/lib/schemaVersions.js` composes every slice in the shipped key order).
 * Bump a value here, never in the composer, so a routine bump runs scoped CI instead of the full matrix; a NEW category also needs its composer entry.
 * A new pinnable render backend adds its first-supported sender version to `RENDER_PIN_SENDER_VERSIONS` in the same change that bumps its category.
 */

export const CREATIVE_MEDIA_SCHEMA_VERSIONS = Object.freeze({
  // Media collections; v2 = per-item `removedItems` removal records.
  mediaCollections: 2,
  // Video history snapshot rows; v1 = Make-primary designation (`primaryInstanceId`/`primaryAt`).
  videoHistory: 1,
  // Card decks; v2 = deck-level `cardOrientation` and `cardOrientationPrompt`.
  decks: 2,
  // Storyboards (boards, beats, panels, takes); v15 = panel `linkMedia`.
  storyboards: 15,
  // Mood boards; v2 = `video` board items.
  moodBoards: 2,
  // FableLoom story graph; v16 = Google backend pins in `renderSettings`.
  fableLoom: 16,
  // Creative Director projects; v10 = validated assembled cuts and retained cut history.
  creativeDirectorProjects: 10,
  // Creative Commission feedback reactions (body-less, tombstoned).
  commissionFeedback: 1,
  // Creative Commission brief (schedule and runs stay machine-local); v9 = Google backend pins in `generation`.
  creativeCommissions: 9,
});

// First wire version guaranteed to round-trip each persisted render mode. Agy
// (commission v3) and Reactor (commission v4 / loom v6) landed between bumps,
// so only the following version guarantees every build understands them.
export const RENDER_PIN_SENDER_VERSIONS = Object.freeze({
  creativeCommissions: Object.freeze({
    image: Object.freeze({ local: 3, codex: 3, grok: 3, agy: 4, fal: 5, runway: 6, higgsfield: 8, google: 9 }),
    video: Object.freeze({ local: 3, grok: 3, fal: 5, reactor: 5, runway: 5, gemini: 7, higgsfield: 8, google: 9 }),
  }),
  fableLoom: Object.freeze({
    image: Object.freeze({ local: 6, codex: 6, grok: 6, agy: 6, fal: 10, runway: 11, higgsfield: 15, google: 16 }),
    video: Object.freeze({ local: 6, grok: 6, fal: 10, reactor: 7, runway: 10, gemini: 14, higgsfield: 15, google: 16 }),
  }),
});

/** Restore a mode and its paired model only when the sender cannot represent the local pin. */
export function preserveLegacyRenderPins(category, senderVersion, remote, local) {
  let merged = remote;
  const commission = category === 'creativeCommissions';
  const fieldVersion = commission ? 3 : 6;
  for (const kind of ['image', 'video']) {
    const mode = `${kind}Mode`;
    const value = local[mode];
    const versions = RENDER_PIN_SENDER_VERSIONS[category][kind];
    // Before commission v3 the whole pair was absent, including a standalone
    // model override. Unknown abilities retain their raw field shapes.
    const requiredVersion = typeof value === 'string' && Object.hasOwn(versions, value) ? versions[value] : fieldVersion;
    if (senderVersion >= requiredVersion) continue;
    const model = commission ? `${kind}ModelId` : `${kind}Model`;
    for (const key of [mode, model]) {
      // A commission's winning ability determines which slots exist. A loom
      // always supports preferences, even when its incoming settings omit all.
      if (Object.hasOwn(local, key) && (!commission || Object.hasOwn(remote, key))) {
        if (merged === remote) merged = { ...remote };
        merged[key] = local[key];
      }
    }
  }
  return merged;
}
