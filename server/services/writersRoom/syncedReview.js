/**
 * Writers Room — Phase 4 synchronized prose/script/media review surface.
 *
 * This is a *read-model*: it derives the prose↔script↔media mapping from data
 * that already exists immutably elsewhere rather than persisting a fourth copy.
 *   - prose segments  ← the active draft's `segmentIndex` (built on every save)
 *   - script scenes   ← the `script` analysis snapshot's `result.scenes[]`,
 *                       each carrying `sourceSegmentIds` back to prose
 *   - media refs      ← the same snapshot's `sceneImages` map (scene → image)
 *   - cast integrity  ← the per-work character bible, measured by the shared
 *                       characterIntegrity.js contract and joined to the
 *                       scenes that stage each character (#6415/#6417)
 *
 * Deriving on read (instead of a persisted render-plan store) means there is no
 * second source of truth to keep in sync, and staleness falls straight out of
 * the analysis snapshot's pinned `sourceContentHash` vs. the live draft hash —
 * the same contentHash machinery the rest of Writers Room already uses.
 *
 * The mapping model from docs/features/writers-room.md ("Synchronized Review
 * Surface") is expressed *relationally* across the three pane arrays — every
 * prose segment lists the script scenes mapped to it; every scene lists the
 * prose segments it adapts and the media rendered from it; every media item
 * carries its full provenance back to scene + prose. There is intentionally no
 * separate `mappings[]` array — that would be a redundant denormalization of
 * exactly these cross-references.
 */

import { buildCastIntegrityReport, castIntegrityPassed } from '../../lib/characterIntegrity.js';
import { normalizeBibleName } from '../../lib/storyBible.js';
import { getWorkWithBody } from './local.js';
import { getAnalysis } from './evaluator.js';
import { listCharacters } from './characters.js';
import { assertValidWorkId } from './_shared.js';

const SCRIPT_ANALYSIS_ID = 'script';

// Pull the active draft's metadata (contentHash, segmentIndex) out of the
// manifest. Returns a stable empty shape when there's no active draft yet so
// callers never have to null-check the index.
function activeDraftMeta(manifest) {
  const activeId = manifest?.activeDraftVersionId || null;
  const draft = (manifest?.drafts || []).find((d) => d.id === activeId) || null;
  return {
    draftVersionId: activeId,
    contentHash: draft?.contentHash || null,
    segmentIndex: Array.isArray(draft?.segmentIndex) ? draft.segmentIndex : [],
  };
}

// One media item per rendered scene image. Provenance points back to the scene
// it was rendered from and (transitively) the prose segments that scene adapts.
// An image whose `sceneId` no longer matches any scene (the script was
// re-extracted with different ids after the render) is surfaced as an orphan —
// honest "source scene no longer in script" rather than silently dropped.
function buildMediaItem(sceneId, img, sceneById) {
  const scene = sceneById.get(sceneId) || null;
  return {
    sceneId,
    sceneHeading: scene?.heading || null,
    orphan: !scene,
    kind: 'image',
    ref: img.filename,
    jobId: img.jobId || null,
    prompt: img.prompt || null,
    generatedAt: img.generatedAt || null,
    proseSegmentIds: scene ? scene.proseSegmentIds : [],
  };
}

/** normalized name/alias → character id, so a scene's cast names resolve to bible ids. */
function castNameIndex(characters) {
  const index = new Map();
  for (const entry of characters) {
    if (!entry?.id) continue;
    const names = [entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    for (const name of names) {
      const key = normalizeBibleName(name);
      // First writer wins: two characters sharing an alias must not make the
      // later one silently steal every scene from the earlier one.
      if (key && !index.has(key)) index.set(key, entry.id);
    }
  }
  return index;
}

/**
 * Cast integrity for the synced review (#6415, and the remaining half of #6417).
 *
 * The synced review is the one Writers Room surface where a COLD READ of the
 * draft (the `script` analysis, which derives scenes and their speaking cast
 * from the prose alone) sits beside AUTHOR KNOWLEDGE (the per-work character
 * bible, which holds the framework the reader never sees). Reporting cast
 * integrity here is what lets the author see the two disagree.
 *
 * The two are deliberately kept apart, in both directions:
 *
 *   - **Script evidence never closes a framework gap.** The integrity findings
 *     are measured by `buildCastIntegrityReport` against the AUTHORED record
 *     only. A character who is vividly on the page and blank in the bible still
 *     reports every gap — an interior that exists only in the author's head is
 *     exactly the defect this contract was written for.
 *   - **The bible never invents a scene, and the cold read never invents a
 *     character.** A name the extraction found that matches no bible entry is
 *     reported as `unmatchedNames`, NOT as a finding: the report has no record
 *     to attach a field path to, and inventing one would be the same failure as
 *     inventing a field. Symmetrically, an authored character no scene stages is
 *     reported `staged: false` and is NOT a finding — an offstage character is a
 *     legitimate authoring choice, not an integrity defect.
 *
 * Zero provider calls, exactly like every other pane here: this is the
 * deterministic completeness pass plus a join against scenes that already
 * exist. The semantic pass is an explicitly-invoked action elsewhere, so
 * `semanticReviewedCount` is 0 and `passed` is false by construction — a
 * deterministic pass alone never licenses "this cast is clean".
 */

/**
 * Assemble the cast block described above. No I/O.
 *
 * Reads the already-derived scenes (which carry their validated
 * `proseSegmentIds`) rather than re-deriving the mapping, and stamps each one
 * with the `castCharacterIds` its cold-read names resolved to, so the script
 * pane can cross-highlight without a second join on the client.
 */
function buildCastPane({ characters, scenes, scriptAvailable, scriptStale }) {
  const cast = characters.filter((c) => c?.id);
  const index = castNameIndex(cast);
  const sceneIdsByCharacter = new Map();
  const proseIdsByCharacter = new Map();
  const unmatched = new Map();

  for (const scene of scenes) {
    const resolved = [];
    for (const name of scene.characters) {
      const key = normalizeBibleName(name);
      const characterId = index.get(key);
      if (!characterId) {
        // Keep the first spelling the extraction used rather than the lowercased
        // key — the author is going to read this name and add the character.
        if (key && !unmatched.has(key)) unmatched.set(key, String(name).trim());
        continue;
      }
      if (resolved.includes(characterId)) continue;
      resolved.push(characterId);
      const sceneIds = sceneIdsByCharacter.get(characterId) || [];
      sceneIds.push(scene.id);
      sceneIdsByCharacter.set(characterId, sceneIds);
      const proseIds = proseIdsByCharacter.get(characterId) || new Set();
      for (const segId of scene.proseSegmentIds) proseIds.add(segId);
      proseIdsByCharacter.set(characterId, proseIds);
    }
    scene.castCharacterIds = resolved;
  }

  const report = buildCastIntegrityReport(cast);
  const coverage = report.coverage.map((row) => {
    const sceneIds = sceneIdsByCharacter.get(row.characterId) || [];
    return {
      ...row,
      // The cold read's view of this character, kept as its own field so it can
      // never be mistaken for part of the authored assessment above.
      staged: sceneIds.length > 0,
      scriptSceneIds: sceneIds,
      proseSegmentIds: [...(proseIdsByCharacter.get(row.characterId) || [])],
    };
  });

  return {
    available: cast.length > 0,
    findings: report.findings,
    coverage,
    castCount: report.castCount,
    reviewedCount: report.reviewedCount,
    semanticReviewedCount: report.semanticReviewedCount,
    // Always false here — see the module note. Carried explicitly so a consumer
    // reads the contract's answer rather than inferring one from `findings`.
    passed: castIntegrityPassed(report),
    staging: {
      // Without a script analysis nothing is staged, and that is not evidence
      // the cast is absent from the page — it is evidence nobody has looked.
      available: scriptAvailable,
      // The join is only as fresh as the script it joined against.
      stale: scriptStale,
      stagedCount: coverage.filter((row) => row.staged).length,
      unstagedCount: coverage.filter((row) => !row.staged).length,
      unmatchedNames: [...unmatched.values()],
    },
  };
}

/**
 * Pure assembler — no I/O. Given the work manifest, the active draft body, and
 * the (possibly absent / failed) `script` analysis snapshot, produce the full
 * synced-review payload. Kept pure so the mapping logic is unit-testable
 * without touching the filesystem.
 */
export function buildSyncedReview({ manifest, body = '', scriptAnalysis = null, characters = [] }) {
  const { draftVersionId, contentHash, segmentIndex } = activeDraftMeta(manifest);
  const text = String(body || '');

  // Prose segments with their sliced text. Offsets come from the segment index
  // computed at save time, so they line up with the persisted body.
  const proseSegments = segmentIndex.map((seg) => ({
    id: seg.id,
    kind: seg.kind,
    heading: seg.heading,
    start: seg.start,
    end: seg.end,
    wordCount: seg.wordCount,
    text: text.slice(seg.start, seg.end).trim(),
    // filled in below once we know which scenes map back to each segment
    scriptSceneIds: [],
    media: [],
    castCharacterIds: [],
  }));
  const proseSegmentIds = new Set(proseSegments.map((s) => s.id));
  const proseById = new Map(proseSegments.map((s) => [s.id, s]));

  const rawScenes = Array.isArray(scriptAnalysis?.result?.scenes)
    ? scriptAnalysis.result.scenes
    : [];
  const sceneImages = scriptAnalysis?.sceneImages && typeof scriptAnalysis.sceneImages === 'object'
    ? scriptAnalysis.sceneImages
    : {};

  // Script scenes. `sourceSegmentIds` from the LLM is validated against the
  // live prose index — hallucinated or stale segment refs are dropped so a
  // mapping never points at a segment that isn't on screen.
  const scenes = rawScenes.map((s) => {
    const validProseIds = (Array.isArray(s.sourceSegmentIds) ? s.sourceSegmentIds : [])
      .filter((id) => proseSegmentIds.has(id));
    const img = sceneImages[s.id];
    return {
      id: s.id,
      heading: s.heading || null,
      slugline: s.slugline || null,
      summary: s.summary || null,
      characters: Array.isArray(s.characters) ? s.characters : [],
      proseSegmentIds: validProseIds,
      media: img?.filename
        ? { kind: 'image', ref: img.filename, jobId: img.jobId || null, prompt: img.prompt || null, generatedAt: img.generatedAt || null }
        : null,
    };
  });
  const sceneById = new Map(scenes.map((s) => [s.id, s]));

  // Back-fill prose → scene and prose → media from the validated scene mappings.
  for (const scene of scenes) {
    for (const segId of scene.proseSegmentIds) {
      const seg = proseById.get(segId);
      if (!seg) continue;
      seg.scriptSceneIds.push(scene.id);
      if (scene.media) seg.media.push({ ...scene.media, sceneId: scene.id });
    }
  }

  // Media pane — every rendered scene image, including orphans.
  const mediaItems = Object.entries(sceneImages)
    .filter(([, img]) => img && img.filename)
    .map(([sceneId, img]) => buildMediaItem(sceneId, img, sceneById))
    .sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));

  const sceneCount = scenes.length;
  const available = sceneCount > 0;
  const stale = available
    && !!scriptAnalysis?.sourceContentHash
    && !!contentHash
    && scriptAnalysis.sourceContentHash !== contentHash;

  // Cast integrity last: it joins the authored bible against the scenes above,
  // and stamps each scene with the bible ids its cold-read names resolved to.
  const cast = buildCastPane({
    characters: Array.isArray(characters) ? characters : [],
    scenes,
    scriptAvailable: available,
    scriptStale: stale,
  });
  // Mirror scene → cast onto prose, so selecting a segment can highlight the
  // characters the script says it stages.
  for (const scene of scenes) {
    for (const segId of scene.proseSegmentIds) {
      const seg = proseById.get(segId);
      if (!seg) continue;
      for (const characterId of scene.castCharacterIds) {
        if (!seg.castCharacterIds.includes(characterId)) seg.castCharacterIds.push(characterId);
      }
    }
  }

  return {
    workId: manifest?.id || null,
    title: manifest?.title || null,
    draftVersionId,
    activeContentHash: contentHash,
    prose: { segments: proseSegments },
    script: {
      available,
      status: scriptAnalysis?.status || null,
      stale,
      analysisId: scriptAnalysis ? SCRIPT_ANALYSIS_ID : null,
      providerId: scriptAnalysis?.providerId || null,
      model: scriptAnalysis?.model || null,
      completedAt: scriptAnalysis?.completedAt || null,
      error: scriptAnalysis?.status === 'failed' ? (scriptAnalysis.error || 'Script analysis failed') : null,
      title: scriptAnalysis?.result?.title || null,
      logline: scriptAnalysis?.result?.logline || null,
      scenes,
    },
    media: { items: mediaItems },
    cast,
  };
}

/**
 * Orchestrator — load the work + active body + script analysis + cast bible and
 * assemble the synced-review read-model. A missing script analysis (never run,
 * or a fresh work) is a normal empty state, not an error.
 *
 * The cast bible is a local file read, not a provider call — opening the review
 * still starts no AI work.
 */
export async function getSyncedReview(workId) {
  assertValidWorkId(workId);
  const { manifest, body } = await getWorkWithBody(workId);
  const [scriptAnalysis, characters] = await Promise.all([
    getAnalysis(workId, SCRIPT_ANALYSIS_ID).catch((err) => {
      if (err?.code === 'NOT_FOUND') return null;
      throw err;
    }),
    listCharacters(workId),
  ]);
  return buildSyncedReview({ manifest, body, scriptAnalysis, characters });
}
