/**
 * Character/place/object canon field caps — the ONE table of length and count
 * limits every story-bible sanitizer, Zod schema, and catalog payload upgrade
 * measures against.
 *
 * A pure leaf on purpose: `server/lib/storyBible.js` (which owns the
 * sanitizers) pulls `crypto` and `fileUtils`, and `server/lib/catalogTypes.js`
 * plus the browser bundle need only the numbers. Keeping the table here lets
 * both import it without dragging Node built-ins into the client build —
 * `client/src/lib/bibleLimits.js` re-exports it. Import no Node built-in here.
 */

export const BIBLE_LIMITS = Object.freeze({
  NAME_MAX: 200,
  ROLE_MAX: 200,
  ALIAS_MAX: 100,
  ALIASES_PER_ENTRY_MAX: 12,
  PHYSICAL_DESCRIPTION_MAX: 2000,
  PERSONALITY_MAX: 2000,
  BACKGROUND_MAX: 2000,
  NOTES_MAX: 4000,
  IMAGE_REF_MAX: 500,
  IMAGE_REFS_PER_ENTRY_MAX: 12,
  // Extended character identity (novelist + graphic-novelist needs). All
  // optional; sanitizer trims missing/blank to empty string. These flow into
  // the bible-extraction prompt + the universe-character-expand LLM call.
  PRONOUNS_MAX: 60,
  AGE_MAX: 80,
  CORE_THEME_MAX: 500,
  SPEECH_ACCENT_MAX: 500,
  // Written speech-pattern: cadence, sentence-structure, lexical tics, vocal
  // habits — *not* the regional accent (that lives in SPEECH_ACCENT_MAX).
  // Roomier than accent because writers tend to describe rhythm + vocabulary
  // + idiom in one paragraph.
  SPEECH_PATTERN_MAX: 1000,
  VISUAL_NOTES_MAX: 1000,
  SILHOUETTE_NOTES_MAX: 2000,
  POSTURE_NOTES_MAX: 1000,
  SPECIAL_TRAITS_MAX: 2000,
  VISUAL_IDENTITY_MAX: 1000,
  MOTIVATIONS_MAX: 2000,
  // Character framework (CWQE Phase 10, #2175). The Ghost → Wound → Lie →
  // Want → Need chain + Three Sliders + declared arc type. All OPTIONAL so
  // every pre-existing character round-trips unchanged (absent vs empty rule).
  // The checkable-test discipline (state the Lie in one sentence; Truth is its
  // direct opposite; Ghost causally explains the Lie) lives in the prompt, not
  // the sanitizer — these caps just bound each field's length.
  GHOST_MAX: 1000,
  WOUND_MAX: 1000,
  LIE_MAX: 600,
  WANT_MAX: 600,
  NEED_MAX: 600,
  // Secrets the character keeps (≥2 encouraged in the prompt). Short prose
  // items, capped per-item and per-character like other string lists.
  SECRET_MAX: 600,
  SECRETS_PER_CHARACTER_MAX: 12,
  // Three Sliders — proactivity / likability / competence on a 1–10 scale.
  // Stored as integers; a value outside the range (or a non-integer) collapses
  // to null (unset). Rule (prompt-enforced, not sanitizer-enforced): HIGH on ≥2,
  // or HIGH on one with clear growth; all-low = boring, all-high = Mary Sue.
  SLIDER_MIN: 1,
  SLIDER_MAX: 10,
  LIKES_MAX: 1500,
  DISLIKES_MAX: 1500,
  MANNERISMS_MAX: 1500,
  RELATIONSHIPS_MAX: 2000,
  // Structured character-to-character relationship links (#1287). The legacy
  // prose `relationships` field above stays; `relationshipLinks[]` is additive.
  // `description` is per-link prose; `opposition` captures a binary-tension
  // axis (hunter/prey, winner/loser…) the reader watches to see reverse.
  RELATIONSHIP_TARGET_ID_MAX: 64,
  RELATIONSHIP_TYPE_MAX: 60,
  RELATIONSHIP_DESCRIPTION_MAX: 1000,
  RELATIONSHIP_OPPOSITION_AXIS_MAX: 60,
  RELATIONSHIP_OPPOSITION_ROLE_MAX: 120,
  RELATIONSHIP_OPPOSITION_NOTE_MAX: 600,
  RELATIONSHIP_LINKS_PER_CHARACTER_MAX: 40,
  SKILLS_MAX: 2000,
  // Flexible stats list — open key/value so non-humans aren't forced into
  // human anatomy ("Number of eyes: 8", "Form: spectral vapor", etc).
  STAT_LABEL_MAX: 80,
  STAT_VALUE_MAX: 200,
  STATS_PER_CHARACTER_MAX: 30,
  // Color palette: named hex swatches with role hints ("amber #f59e0b — skin").
  COLOR_NAME_MAX: 80,
  COLOR_HEX_MAX: 10,
  COLOR_ROLE_MAX: 120,
  COLORS_PER_PALETTE_MAX: 12,
  // Props (graphic-novelist reference): per-prop name + purpose + materials.
  PROP_NAME_MAX: 120,
  PROP_PURPOSE_MAX: 400,
  PROP_MATERIALS_MAX: 200,
  PROP_NOTES_MAX: 600,
  PROPS_PER_CHARACTER_MAX: 12,
  // Expressions + hand gestures: named visual cues for reference-sheet panels.
  EXPRESSION_NAME_MAX: 80,
  EXPRESSION_DESC_MAX: 400,
  EXPRESSIONS_PER_CHARACTER_MAX: 16,
  GESTURE_NAME_MAX: 80,
  GESTURE_DESC_MAX: 300,
  GESTURES_PER_CHARACTER_MAX: 12,
  // Wardrobes per character — A2 in the AnyFilm gap analysis. Each entry
  // is an outfit/styling variant; first one is the visual default.
  WARDROBE_NAME_MAX: 120,
  WARDROBE_DESCRIPTION_MAX: 800,
  WARDROBES_PER_CHARACTER_MAX: 10,
  EVIDENCE_ITEM_MAX: 500,
  EVIDENCE_PER_ENTRY_MAX: 20,
  // Places
  SLUGLINE_MAX: 200,
  PALETTE_MAX: 200,
  ERA_MAX: 200,
  WEATHER_MAX: 200,
  RECURRING_DETAILS_MAX: 1000,
  PLACE_DESCRIPTION_MAX: 2000,
  // Objects
  OBJECT_DESCRIPTION_MAX: 2000,
  SIGNIFICANCE_MAX: 1000,
  // Structured object↔character attachment links (#1288). The legacy prose
  // `significance` field above stays; `attachments[]` is additive. Each link
  // ties an object to ONE character and captures the emotion/significance/origin
  // of that bond plus a `role` archetype. `characterId` caps match the canon id
  // format; the prose fields are roomy because writers describe backstory at
  // length, but tighter than NOTES so a runaway extraction stays bounded.
  ATTACHMENT_CHARACTER_ID_MAX: 64,
  ATTACHMENT_EMOTION_MAX: 120,
  ATTACHMENT_SIGNIFICANCE_MAX: 1000,
  ATTACHMENT_ORIGIN_MAX: 1000,
  ATTACHMENTS_PER_OBJECT_MAX: 40,
  // Per-bible cap (universal — protects against runaway extraction)
  ENTRIES_PER_BIBLE_MAX: 200,
  PROMPT_MAX: 2000,
  TAG_MAX: 60,
  TAGS_PER_ENTRY_MAX: 12,
  SOURCE_SERIES_ID_MAX: 64,
  // Catalog backlink: when an embedded bible entry is promoted to the
  // creative-ingredients catalog (server/services/catalogDB.js), this carries
  // the catalog row id so edits stay synchronized. Cap matches the catalog's
  // own id format ('cat-<prefix>-<uuid>') — generous so future id schemes fit.
  INGREDIENT_ID_MAX: 64,
  // Voice id namespace: `engine:voiceName` (e.g. `kokoro:af_heart`,
  // `piper:en_GB-northern_english_male`). Caps generously since 3rd-party
  // providers (ElevenLabs) use uuid-shaped voice ids.
  VOICE_ID_MAX: 200,
  // Versioned, portable voice-production intent (#5378). This records only
  // creative direction and an approval decision; local profiles, providers,
  // recordings, and training artifacts deliberately have no slot here.
  VOICE_CANON_VERSION_MAX: 100000,
  VOICE_CANON_DESCRIPTION_MAX: 1200,
  VOICE_CANON_DELIVERY_MAX: 1200,
  VOICE_CANON_RANGE_ITEM_MAX: 240,
  VOICE_CANON_RANGE_MAX: 12,
  VOICE_CANON_AVOID_ITEM_MAX: 240,
  VOICE_CANON_AVOID_MAX: 12,
  VOICE_CANON_PRONUNCIATION_TERM_MAX: 160,
  VOICE_CANON_PRONUNCIATION_VALUE_MAX: 240,
  VOICE_CANON_PRONUNCIATIONS_MAX: 24,
  // Approved identity-pack assets are a curated view over imageRefs[], not a
  // second image store. Only an existing managed reference can be assigned.
  IDENTITY_PACK_ASSETS_MAX: 24,
  IDENTITY_PACK_AVOID_ITEM_MAX: 240,
  IDENTITY_PACK_AVOID_MAX: 12,
  // Reveal-gated canon (#2178): `surfaceDescriptor` is the pre-reveal
  // stand-in — what the world looks like BEFORE the spoiler is due ("the
  // locked east wing" vs "the wing where the heir is imprisoned"). Roomy
  // like a place description so a full surface-level paragraph fits.
  SURFACE_DESCRIPTOR_MAX: 2000,
  // Upper bound for the issue number a canon fact is revealed in. A generous
  // cap that comfortably exceeds any real series length while still rejecting
  // a hallucinated/overflowed integer.
  REVEAL_ISSUE_MAX: 100000,
});
