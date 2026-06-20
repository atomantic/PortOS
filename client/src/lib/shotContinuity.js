// Client mirror of the deterministic shot-continuity primitives in
// server/lib/editorial/shotContinuity.js (#1315). The two detectors
// (`findAxisReversals`, `findShotTypeMonotony`) are kept byte-for-byte in sync
// with the server — the server `visual.shot-continuity` editorial check is
// authoritative and tested in server/lib/editorial/shotContinuity.test.js.
//
// This copy powers the storyboards / episode-video stages' INLINE pre-render
// warnings (#1468) so a user sees a 180°-rule axis jump or shot-type monotony
// BEFORE spending render time — without a round-trip through an editorial-checks
// run. Mirrors the inline comic-lettering warning pattern (#1313) in
// client/src/lib/letteringDensity.js. The warning composer (`sceneShotWarnings`)
// below is client-only (the server emits findings in a different shape); port any
// change to the two shared detectors to BOTH sides verbatim.

// Two directions are an axis reversal only when both are decided AND opposite.
// `neutral` (head-on / ambiguous) has no axis to cross, so it never reverses.
function isAxisReversal(a, b) {
  if (a == null || b == null) return false;
  if (a === 'neutral' || b === 'neutral') return false;
  return a !== b; // one 'left', one 'right'
}

// Shots of a scene as a safe array (an older/peer-synced scene may carry a
// non-array `shots`). Each element is passed through untouched — the caller
// type-guards the fields it reads.
function sceneShots(scene) {
  return Array.isArray(scene?.shots) ? scene.shots : [];
}

/**
 * Detect 180-degree-rule axis reversals across continuity-linked shot pairs in
 * one scene. For every shot that chains from an earlier shot in the same scene,
 * compare their `screenDirection`; a decided-and-opposite pair is flagged.
 *
 * @param {object} scene  a storyboard scene with `shots[]`
 * @returns {Array<{ fromId, toId, fromDirection, toDirection, fromDescription, toDescription }>}
 */
export function findAxisReversals(scene) {
  const shots = sceneShots(scene);
  if (shots.length < 2) return [];
  // Shot ids are unique on the extract path (sanitizeShot synthesizes them) but
  // the route doesn't enforce cross-shot uniqueness, so a hand-edited scene could
  // carry a duplicate id — last-wins here, matching how a continuity ref would
  // resolve anyway. Acceptable under the check's high-precision / under-flag design.
  const byId = new Map();
  for (const s of shots) {
    if (s && typeof s === 'object' && typeof s.id === 'string' && s.id) byId.set(s.id, s);
  }
  const out = [];
  for (const shot of shots) {
    if (!shot || typeof shot !== 'object') continue;
    const fromId = typeof shot.continuityFromShotId === 'string' ? shot.continuityFromShotId : null;
    if (!fromId) continue;
    const prior = byId.get(fromId);
    if (!prior || prior === shot) continue;
    const fromDir = typeof prior.screenDirection === 'string' ? prior.screenDirection : null;
    const toDir = typeof shot.screenDirection === 'string' ? shot.screenDirection : null;
    if (!isAxisReversal(fromDir, toDir)) continue;
    out.push({
      fromId,
      toId: typeof shot.id === 'string' ? shot.id : '',
      fromDirection: fromDir,
      toDirection: toDir,
      fromDescription: typeof prior.description === 'string' ? prior.description : '',
      toDescription: typeof shot.description === 'string' ? shot.description : '',
    });
  }
  return out;
}

/**
 * Detect shot-type monotony in one scene: enough classified shots that they ALL
 * share a single `shotType`. Returns the monotony descriptor or null.
 *
 * @param {object} scene
 * @param {{ minClassified?: number }} [opts] minClassified — floored at 2;
 *   default 3 (mirrors the check's `minShotsForMonotony` default).
 * @returns {{ shotType: string, classifiedCount: number } | null}
 */
export function findShotTypeMonotony(scene, opts = {}) {
  const minClassified = Math.max(2, Number.isInteger(opts.minClassified) ? opts.minClassified : 3);
  const shots = sceneShots(scene);
  const types = [];
  for (const s of shots) {
    if (s && typeof s === 'object' && typeof s.shotType === 'string' && s.shotType) types.push(s.shotType);
  }
  if (types.length < minClassified) return null;
  const first = types[0];
  if (!types.every((t) => t === first)) return null;
  return { shotType: first, classifiedCount: types.length };
}

// Screen-direction → reader-facing label, mirroring the server check's
// DIRECTION_LABEL so the inline warning and the editorial-run finding read the same.
const DIRECTION_LABEL = { left: 'screen-left', right: 'screen-right', neutral: 'head-on' };

/**
 * Compose the inline, render-gating continuity warnings for ONE storyboard scene
 * (client-only). Runs the two deterministic detectors with the check's default
 * config and returns concise, scene-scoped warnings — the same hazards the server
 * `visual.shot-continuity` check surfaces in the manuscript review, shown here so
 * the user sees them before spending render time.
 *
 * @param {object} scene a storyboard scene with `shots[]`
 * @param {{ minClassified?: number, flagAxisReversal?: boolean }} [opts]
 * @returns {Array<{ kind: 'axis-reversal'|'monotony', severity: 'medium', message: string }>}
 */
export function sceneShotWarnings(scene, opts = {}) {
  const flagAxis = opts.flagAxisReversal !== false;
  const minClassified = Number.isInteger(opts.minClassified) ? opts.minClassified : 3;
  const warnings = [];
  if (flagAxis) {
    for (const r of findAxisReversals(scene)) {
      const fromLabel = DIRECTION_LABEL[r.fromDirection] || r.fromDirection;
      const toLabel = DIRECTION_LABEL[r.toDirection] || r.toDirection;
      warnings.push({
        kind: 'axis-reversal',
        severity: 'medium',
        message: `180° axis jump — shot "${r.toId}" continues from "${r.fromId}" but faces ${toLabel} where "${r.fromId}" faced ${fromLabel}; the subject appears to flip sides across the cut.`,
      });
    }
  }
  if (minClassified > 0) {
    const mono = findShotTypeMonotony(scene, { minClassified });
    if (mono) {
      warnings.push({
        kind: 'monotony',
        severity: 'medium',
        message: `Shot-type monotony — all ${mono.classifiedCount} classified shots are ${mono.shotType}; the scene reads as flat, slideshow coverage with no establishing wide or punch-in.`,
      });
    }
  }
  return warnings;
}
