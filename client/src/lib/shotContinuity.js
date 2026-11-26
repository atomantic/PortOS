// The storyboards / episode-video stages' INLINE pre-render continuity warnings (#1468).
//
// `findAxisReversals` / `findShotTypeMonotony` are imported from
// `server/lib/editorial/shotContinuity.js`, the same detectors the authoritative
// `visual.shot-continuity` check runs; `sceneShotWarnings(scene, opts)` is the client-only composer
// (the server emits findings in a different shape). Pure/DOM-free.
//
// The inline, render-gating shot-continuity warnings for the storyboards /
// episode-video stages (#1468) — shown before a render so the user sees a
// 180°-rule axis jump or shot-type monotony without a round-trip through an
// editorial-checks run.
//
// The two deterministic detectors are re-exported from
// server/lib/editorial/shotContinuity.js (#1315), which the authoritative
// `visual.shot-continuity` editorial check also runs, so the inline warning and
// the manuscript-review finding can never disagree. Only the composer below is
// client-only (the server emits findings in a different shape).
import { findAxisReversals, findShotTypeMonotony, DIRECTION_LABEL } from '../../../server/lib/editorial/shotContinuity.js';

/**
 * Compose the inline, render-gating continuity warnings for ONE storyboard scene
 * (client-only). Runs the two deterministic detectors with the check's default
 * config and returns concise, scene-scoped warnings — the same hazards the server
 * `visual.shot-continuity` check surfaces in the manuscript review, shown here so
 * the user sees them before spending render time.
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
