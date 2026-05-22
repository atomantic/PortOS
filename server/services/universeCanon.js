// Canon entities on the universe — characters, places, objects. Mirrors
// `pipeline/series.js`'s extract+refine paths but writes into the universe
// so multiple series can share a cast (Phase A of the Universe-as-canon
// refactor). The series-side helpers stay live until Phase B migrates
// series.cast → references into universe entities.

import { getUniverse, updateUniverse, listUniverses, joinInfluenceList } from './universeBuilder.js';
import { extractBible } from '../lib/bibleExtractor.js';
import {
  BIBLE_KIND, BIBLE_KINDS, BIBLE_FIELD, BIBLE_KEYS, BIBLE_SOURCE, mergeExtractedBible,
  listSheetPointers, applySheetPointerToCharacter,
} from '../lib/storyBible.js';
import { runStagedLLM } from '../lib/stageRunner.js';
import { runPromptRefine } from './pipeline/refineHelpers.js';
import { ServerError } from '../lib/errorHandler.js';
import { shortId } from '../lib/fileUtils.js';

export const peerForPrompt = (entry) => ({
  id: entry.id,
  name: entry.name,
  aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
  role: entry.role || '',
  physicalDescription: entry.physicalDescription || entry.description || '',
});

const targetForPrompt = (entry) => ({
  ...peerForPrompt(entry),
  evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
  firstAppearance: entry.firstAppearance || null,
});

export const buildStyleClause = (universe) => {
  const embraceTokens = joinInfluenceList(universe.influences?.embrace);
  const bits = [
    embraceTokens ? `Universe aesthetic: ${embraceTokens}` : null,
    universe.styleNotes ? `Universe notes: ${universe.styleNotes}` : null,
  ].filter(Boolean);
  return bits.length ? bits.join('\n') : '(none provided — pick choices that fit the character\'s role and genre)';
};

/**
 * Extract characters/places/objects from a prose corpus and merge into the
 * universe's canon arrays. Mirrors `extractAndMergeIntoSeries` so callers
 * can swap targets without changing prompt shapes.
 *
 * `opts.source` / `opts.autoLock` / `opts.sourceSeriesId` stamp NEW inserts
 * only — existing entries are not touched by these options (locked existing
 * entries are protected by mergeExtractedBible itself).
 */
export async function extractCanonFromProse(universeId, opts = {}) {
  const universe = await getUniverse(universeId);
  const rawKinds = (opts.kinds && opts.kinds.length)
    ? opts.kinds
    : [BIBLE_KIND.CHARACTER, BIBLE_KIND.PLACE, BIBLE_KIND.OBJECT];
  const kinds = [...new Set(rawKinds)];
  if (typeof opts.corpus !== 'string' || !opts.corpus.trim()) {
    throw new ServerError('extractCanonFromProse: corpus is required', {
      status: 400, code: 'UNIVERSE_CANON_NO_CORPUS',
    });
  }

  const runOne = (kind) => extractBible({
    kind,
    corpus: opts.corpus,
    existing: universe[BIBLE_FIELD[kind]] || [],
    context: { universe: { id: universe.id, name: universe.name } },
    providerOverride: opts.providerOverride,
    source: `universe-canon-${kind}`,
  }).then((result) => ({ kind, result }));

  const completed = opts.parallel
    ? await Promise.all(kinds.map(runOne))
    : await kinds.reduce(async (acc, kind) => [...(await acc), await runOne(kind)], Promise.resolve([]));

  const wantsLock = opts.autoLock !== false;
  const mergeOpts = {
    source: opts.source || BIBLE_SOURCE.SERIES_EXTRACT,
    // Default to locked-on-insert. New canon entries are protected from AI
    // overwrite from the moment they land so users don't have to chase a
    // batch extract with a Lock All click. Callers can opt out with an
    // explicit `autoLock: false` — in that case we still stamp `locked:
    // false` on the new entries below so the universe-side
    // lock-by-default contract (sanitizeTemplate.defaultLockCanon) doesn't
    // silently re-lock them on the next read.
    autoLock: wantsLock,
    sourceSeriesId: opts.sourceSeriesId || null,
  };
  const results = {};
  const patch = {};
  for (const { kind, result } of completed) {
    const field = BIBLE_FIELD[kind];
    // Capture existing ids BEFORE the merge — mergeExtractedBible mutates the
    // existing list in place via push(), so reading universe[field] after the
    // merge already includes the new inserts and breaks the "is this an
    // already-known entry?" check below.
    const existingIds = wantsLock
      ? null
      : new Set((universe[field] || []).map((e) => e?.id).filter(Boolean));
    const merged = mergeExtractedBible(universe[field] || [], result.extracted, kind, mergeOpts);
    // Opt-out path: caller asked for unlocked inserts. The merge step left
    // `locked` absent on new entries; sanitizeTemplate.defaultLockCanon
    // would then read them back as locked. Force explicit `locked: false`
    // on every new insert so the opt-out survives the round-trip — even
    // if the extractor payload tried to set `locked: true`, `autoLock:
    // false` is the explicit override. Existing entries are skipped via
    // existingIds (they keep their current lock state).
    if (!wantsLock) {
      patch[field] = merged.map((e) => {
        if (!e || typeof e !== 'object') return e;
        if (existingIds.has(e.id)) return e;
        return { ...e, locked: false };
      });
    } else {
      patch[field] = merged;
    }
    results[field] = {
      extracted: result.extracted, runId: result.runId,
      providerId: result.providerId, model: result.model,
    };
  }
  const updated = await updateUniverse(universe.id, patch);
  return { universe: updated, results };
}

/**
 * Rewrite one character's `physicalDescription` so they render distinct
 * from every peer. Same prompt as the series-side refine; just sourced from
 * the universe.
 */
export async function refineUniverseCharacter(universeId, entryId, options = {}) {
  const universe = await getUniverse(universeId);
  const list = Array.isArray(universe.characters) ? universe.characters : [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx < 0) {
    throw new ServerError(`Character ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }
  const target = list[idx];
  // 409 (vs. silent overwrite) so the UI can render a clear "Unlock to edit"
  // affordance for entries an active series depends on.
  if (target.locked === true) {
    throw new ServerError(
      `Character "${target.name}" is locked — unlock it before refining`,
      { status: 409, code: 'UNIVERSE_CANON_LOCKED' },
    );
  }
  const peers = list.filter((_, i) => i !== idx);

  const { refined, changes, rationale, runId, providerId, model } = await runPromptRefine({
    templateName: 'pipeline-character-refine',
    variables: {
      targetJson: JSON.stringify(targetForPrompt(target), null, 2),
      peersJson: JSON.stringify(peers.map(peerForPrompt), null, 2),
      styleClause: buildStyleClause(universe),
    },
    options,
    source: 'universe-character-refine',
    logTag: `Universe character refine — universe=${shortId(universeId)} entry=${shortId(entryId)}`,
    resultField: 'physicalDescription',
    emptyError: { code: 'UNIVERSE_CANON_REFINE_EMPTY', message: 'LLM returned an empty physicalDescription' },
    changesLimit: 12,
  });

  const nextList = list.map((e, i) => i === idx ? { ...e, physicalDescription: refined } : e);
  const updated = await updateUniverse(universeId, { characters: nextList });
  const updatedEntry = (updated.characters || []).find((e) => e.id === entryId) || null;
  return { universe: updated, entry: updatedEntry, rationale, changes, runId, providerId, model };
}

/**
 * Cast-wide differentiate. One LLM call rewrites every character's
 * `physicalDescription` so the cast as a whole has no visually-colliding
 * pairs. Returns counts + rationale; the updated universe carries the new
 * descriptions on its `characters[]`.
 */
export async function differentiateUniverseCast(universeId, options = {}) {
  const universe = await getUniverse(universeId);
  const list = Array.isArray(universe.characters) ? universe.characters : [];
  if (list.length === 0) {
    throw new ServerError('Universe has no characters to differentiate — extract from issue prose first', {
      status: 400, code: 'UNIVERSE_CANON_EMPTY_CAST',
    });
  }

  // The LLM sees the FULL cast so unlocked rewrites are differentiated from
  // locked descriptions too. Lock enforcement happens at apply time.
  if (list.every((c) => c.locked === true)) {
    throw new ServerError(
      'All characters are locked — unlock at least one before differentiating the cast',
      { status: 400, code: 'UNIVERSE_CANON_ALL_LOCKED' },
    );
  }
  const castForPrompt = list.map(targetForPrompt);
  const result = await runStagedLLM('pipeline-character-differentiate-cast', {
    castJson: JSON.stringify(castForPrompt, null, 2),
    styleClause: buildStyleClause(universe),
  }, {
    providerOverride: options.providerId,
    modelOverride: options.model,
    returnsJson: true,
    source: 'universe-cast-differentiate',
  });

  const rewrites = Array.isArray(result.content?.characters) ? result.content.characters : [];
  if (rewrites.length === 0) {
    throw new ServerError('LLM returned no character rewrites', {
      status: 502, code: 'UNIVERSE_CAST_DIFFERENTIATE_EMPTY',
    });
  }

  const byId = new Map();
  for (const r of rewrites) {
    if (!r?.id || typeof r.physicalDescription !== 'string') continue;
    const trimmed = r.physicalDescription.trim();
    if (!trimmed) continue;
    byId.set(r.id, {
      physicalDescription: trimmed,
      changes: Array.isArray(r.changes)
        ? r.changes.map((c) => String(c).slice(0, 240)).filter(Boolean).slice(0, 8)
        : [],
    });
  }

  let touched = 0;
  let skippedLocked = 0;
  const nextList = list.map((entry) => {
    const rewrite = byId.get(entry.id);
    if (!rewrite) return entry;
    if (entry.locked === true) {
      skippedLocked += 1;
      return entry;
    }
    touched += 1;
    return { ...entry, physicalDescription: rewrite.physicalDescription };
  });
  if (touched === 0) {
    throw new ServerError('LLM rewrites did not match any existing character ids', {
      status: 502, code: 'UNIVERSE_CAST_DIFFERENTIATE_NO_MATCH',
    });
  }

  const updated = await updateUniverse(universeId, { characters: nextList });
  const rationale = typeof result.content?.rationale === 'string' ? result.content.rationale.trim() : '';
  console.log(`✨ Universe cast differentiate — universe=${shortId(universeId)} touched=${touched}/${list.length} skippedLocked=${skippedLocked} runId=${shortId(result.runId)}`);
  return {
    universe: updated,
    touched,
    skipped: list.length - touched,
    skippedLocked,
    rationale,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
  };
}

// Toggle the `locked` flag on a single canon entry. Locked entries are
// protected from AI rewrite paths — see `mergeExtractedBible` (evidence-only
// append) and the refine/differentiate runtime guards.
export async function setCanonEntryLock(universeId, kind, entryId, locked) {
  if (!BIBLE_KINDS.includes(kind)) {
    throw new ServerError(
      `Invalid canon kind "${kind}" — expected one of: ${BIBLE_KINDS.join(', ')}`,
      { status: 400, code: 'UNIVERSE_CANON_INVALID_KIND' },
    );
  }
  const field = BIBLE_FIELD[kind];
  let found = false;
  // Mutator form (same as setCanonKindLockAll) so the flip is computed from
  // the freshest persisted state inside updateUniverse's write queue. A
  // read-modify-write split (getUniverse → updateUniverse(patchObject))
  // would replace the full canon array via PATCHABLE_SCALARS and could
  // clobber a concurrent render-completion `imageRefs[]` append landing
  // between the read and the write.
  const updated = await updateUniverse(universeId, (cur) => {
    const list = Array.isArray(cur[field]) ? cur[field] : [];
    const idx = list.findIndex((e) => e.id === entryId);
    if (idx < 0) return null;
    found = true;
    const target = list[idx];
    // No-op short-circuit avoids a write + updatedAt churn on redundant toggles.
    if ((target.locked === true) === (locked === true)) return null;
    // applyCanonExtras now persists explicit locked:false (the universe-builder
    // contract), so the bit survives the round-trip and the unlock sticks.
    const nextList = list.map((e, i) => (i === idx ? { ...e, locked } : e));
    return { [field]: nextList };
  });
  if (!found) {
    throw new ServerError(
      `Canon ${kind} ${entryId} not found in universe`,
      { status: 404, code: 'UNIVERSE_CANON_NOT_FOUND' },
    );
  }
  const entry = (updated[field] || []).find((e) => e.id === entryId) || null;
  return { universe: updated, entry };
}

/**
 * Bulk-set the `locked` flag on every canon entry of a single kind. Returns
 * the updated universe plus the count of entries whose lock state actually
 * changed (no-op on entries already in the target state, so the response
 * carries enough info for a toast like "Locked 7 characters").
 */
export async function setCanonKindLockAll(universeId, kind, locked) {
  if (!BIBLE_KINDS.includes(kind)) {
    throw new ServerError(
      `Invalid canon kind "${kind}" — expected one of: ${BIBLE_KINDS.join(', ')}`,
      { status: 400, code: 'UNIVERSE_CANON_INVALID_KIND' },
    );
  }
  const field = BIBLE_FIELD[kind];
  let changed = 0;
  let total = 0;
  // Run inside `updateUniverse`'s file-write queue (mutator form) so the
  // patch is built from the freshest persisted state. A read-modify-write
  // split (getUniverse → updateUniverse(patchObject)) would clobber a
  // concurrent render-completion `imageRefs[]` append or an inline canon
  // edit landing between the two calls — the patch's full-array shape
  // replaces wholesale via PATCHABLE_SCALARS. Mirrors `setVariationsLockAll`.
  const updated = await updateUniverse(universeId, (cur) => {
    const list = Array.isArray(cur[field]) ? cur[field] : [];
    total = list.length;
    const nextList = list.map((e) => {
      if ((e.locked === true) === (locked === true)) return e;
      changed += 1;
      return { ...e, locked };
    });
    if (changed === 0) return null; // no-op short-circuit
    return { [field]: nextList };
  });
  return { universe: updated, kind, locked, changed, total };
}

/**
 * Strip a filename from every `imageRefs[]` across every universe's
 * characters/places/objects. Mirror of the series-side purge so the image-
 * delete route can clean both stores in one pass.
 */
export async function purgeImageRefFromAllUniverses(filename) {
  if (!filename || typeof filename !== 'string') return { removed: 0 };
  const universes = await listUniverses();
  let removed = 0;
  for (const universe of universes) {
    let touched = false;
    const patch = {};
    for (const key of BIBLE_KEYS) {
      const list = Array.isArray(universe[key]) ? universe[key] : null;
      if (!list) continue;
      const nextList = list.map((entry) => {
        const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : null;
        if (!refs || !refs.includes(filename)) return entry;
        const trimmed = refs.filter((f) => f !== filename);
        removed += refs.length - trimmed.length;
        touched = true;
        return { ...entry, imageRefs: trimmed };
      });
      if (touched) patch[key] = nextList;
    }
    if (touched) await updateUniverse(universe.id, patch);
  }
  return { removed };
}

/**
 * Null out any server-stamped sheet pointer (legacy `referenceSheetImageRef`
 * field OR any key in the `referenceSheets` map) whose value matches
 * `filename`, on every character across every universe. Mirrors
 * `purgeImageRefFromAllUniverses` but targets per-variant sheet pointers and
 * is variant-agnostic — the filename is the lookup key, the storage slot it
 * happens to live in is implementation detail.
 *
 * Wired into the sheet-delete route so the eager pointer-clear lands the same
 * moment the file is unlinked. The GET-time lazy `pruneStaleReferenceSheets`
 * is still the safety net for files deleted out-of-band (filesystem cleanup,
 * sample-data resets) — this helper is the eager path.
 *
 * Uses `updateUniverse`'s mutator form because both `referenceSheetImageRef`
 * and `referenceSheets` are in `SERVER_OWNED_CHARACTER_FIELDS` — a literal-
 * object PATCH would be guarded against clobbering the server-stamped value
 * (the guard preserves cur's value when its file still resolves on disk).
 * The purge IS the server-side writer, so it has to bypass that guard via
 * the mutator form.
 */
export async function purgeReferenceSheetFromAllUniverses(filename) {
  if (!filename || typeof filename !== 'string') return { cleared: 0 };
  const universes = await listUniverses();
  let cleared = 0;
  // No pre-check: the mutator returns null when no characters matched, so
  // updateUniverse skips the write. Single pass per universe instead of two.
  for (const universe of universes) {
    if (!Array.isArray(universe.characters)) continue;
    await updateUniverse(universe.id, (cur) => {
      const list = Array.isArray(cur.characters) ? cur.characters : [];
      let touched = false;
      const nextList = list.map((entry) => {
        let next = entry;
        for (const { variant, filename: f } of listSheetPointers(entry)) {
          if (f !== filename) continue;
          next = applySheetPointerToCharacter(next, variant, null);
          cleared += 1;
          touched = true;
        }
        return next;
      });
      return touched ? { characters: nextList } : null;
    });
  }
  return { cleared };
}

