/**
 * Storyboard / video shot-continuity deterministic primitives (#1315) for the
 * editorial check registry. Pure and dependency-free (no side-effecting imports)
 * so it stays unit-testable in isolation — mirrors ./nameSimilarity.js and the
 * other deterministic scanners.
 *
 * Backs the deterministic `visual.shot-continuity` check in checkRegistry.js,
 * which reasons over a storyboard scene's `shots[]` (each carrying the
 * film-grammar fields `shotType` + `screenDirection` + `continuityFromShotId`
 * from server/lib/shotGrammar.js). Two classic film-grammar errors are computable
 * from those signals without an LLM:
 *
 *   1. **180-degree rule (axis reversal).** When shot B chains from an earlier
 *      shot A (`B.continuityFromShotId === A.id`) — i.e. the author declared the
 *      two shots a continuous bridge — and the two shots face OPPOSITE screen
 *      directions (one `left`, one `right`), the subject appears to flip sides
 *      across the cut. That's an axis jump that disorients the viewer. A
 *      continuity-linked pair is the high-precision trigger: the link is the
 *      author's explicit "these are continuous" signal, so a direction flip
 *      across it is a real error, not a legitimate reverse-angle.
 *
 *   2. **Shot-type monotony.** A scene whose shots ALL share one framing (every
 *      shot `medium`, say) reads as flat, slideshow coverage — no establishing
 *      wide, no punch-in for emphasis. Flagged only when enough shots are
 *      classified to be confident it's monotony, not a sparse outline.
 *
 * High-precision by design (favors under-flagging, like the other deterministic
 * scanners). Unclassified shots (null `shotType` / `screenDirection`) are treated
 * as ABSENT — skipped, never guessed — per the absent-vs-empty rule. The judgment
 * cases this can't compute need an LLM: eyeline match ships as the `visual.eyeline-match`
 * check (#1466), fed by `summarizeStoryboardShots` below; appearance/prop continuity
 * is a tracked follow-up.
 */

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

// Human-readable label for a shot's screen direction, used when rendering shots
// for the LLM eyeline/appearance continuity passes (#1466). The field records the
// side the subject "faces / moves" (shotGrammar.js) — NOT specifically gaze — so
// the label stays neutral ("screen direction: left") rather than asserting the
// subject is LOOKING that way; conflating motion with gaze would induce false
// eyeline contradictions for a shot like "walks left while looking back right".
// `neutral` is head-on; an unset direction is named so the model knows the signal
// is absent, not "left".
const DIRECTION_PROMPT_LABEL = {
  left: 'screen direction: left',
  right: 'screen direction: right',
  neutral: 'screen direction: neutral (head-on)',
};

// Bounds on a single eyeline pass so a very large storyboard can't overflow the
// provider context in one unchunked LLM call. Three independent limits — the pass
// stops at whichever it hits first, and every omission is surfaced in the block
// (NOT silent) so the model and any reader know coverage stopped. An eyeline match
// is a WITHIN-scene judgment, so omitting a scene loses no cross-scene context;
// a future iteration could page across the overflow.
//   - EYELINE_MAX_SCENES   — most scenes rendered in one pass.
//   - EYELINE_MAX_CHARS    — total rendered-block character budget (the real
//                            overflow guard: bounds 60 dense scenes, not just 60).
//                            Enforced as a HARD ceiling — a single block is
//                            truncated to the remaining budget if it would exceed it,
//                            so even one scene with thousands of shots can't blow past.
//   - EYELINE_MAX_DESC_CHARS — per-shot description truncation, so one giant shot
//                            description can't blow the budget on its own.
//   - EYELINE_MAX_SHOTS_PER_SCENE — most shot lines rendered per scene (the common
//                            "deep scene" guard, applied before the char ceiling).
export const EYELINE_MAX_SCENES = 60;
export const EYELINE_MAX_CHARS = 24_000;
export const EYELINE_MAX_DESC_CHARS = 600;
export const EYELINE_MAX_SHOTS_PER_SCENE = 40;

/**
 * Render the collected storyboard scenes into a compact, ordered text block for
 * an LLM continuity pass (eyeline match — #1466 — and, later, appearance/prop
 * continuity). Pure + deterministic so it's unit-testable and so its token cost
 * is countable. Each qualifying scene becomes a labeled block; each shot is one
 * line carrying the fields the model reasons over: id, shot type, screen
 * direction, continuity link, and the free-text description (the eyeline signal).
 *
 * A scene qualifies only when it has at least two shots with a non-empty
 * description — an eyeline/appearance match is a judgment ACROSS shots, so a
 * single-shot (or description-less) scene has nothing to compare. ALL shots of a
 * qualifying scene are rendered (not just the described ones) so a
 * `continuityFromShotId` reference still resolves to a visible line; an
 * undescribed shot renders its description as `(no description)`.
 *
 * The rendered payload is bounded four ways (scene count, shots-per-scene, total
 * chars, per-shot description length — see the EYELINE_MAX_* constants) so one
 * unchunked LLM call can't overflow the provider context whether the storyboard
 * is wide (many scenes), deep (a few enormous descriptions), or has one pathological
 * scene with thousands of shots. The total-char budget is a HARD ceiling: a block
 * that would exceed the remaining budget is truncated to it, so the returned string
 * never exceeds `maxChars` (plus the two short trailing markers). When anything is
 * dropped or truncated a trailing marker says so — the truncation is never silent.
 *
 * Returns '' when no scene qualifies, so the caller can gate the LLM call on a
 * non-empty block (mirrors the object-backstory check's row gate).
 *
 * @param {Array<{ issueNumber: number|null, scene: object }>} storyboardScenes
 * @param {{ maxScenes?: number, maxChars?: number, maxDescChars?: number, maxShotsPerScene?: number }} [opts]
 * @returns {string}
 */
export function summarizeStoryboardShots(storyboardScenes, opts = {}) {
  const maxScenes = Number.isInteger(opts.maxScenes) && opts.maxScenes > 0
    ? opts.maxScenes
    : EYELINE_MAX_SCENES;
  const maxChars = Number.isInteger(opts.maxChars) && opts.maxChars > 0
    ? opts.maxChars
    : EYELINE_MAX_CHARS;
  const maxDescChars = Number.isInteger(opts.maxDescChars) && opts.maxDescChars > 0
    ? opts.maxDescChars
    : EYELINE_MAX_DESC_CHARS;
  const maxShotsPerScene = Number.isInteger(opts.maxShotsPerScene) && opts.maxShotsPerScene > 0
    ? opts.maxShotsPerScene
    : EYELINE_MAX_SHOTS_PER_SCENE;
  const entries = Array.isArray(storyboardScenes) ? storyboardScenes : [];
  const blocks = [];
  let qualifying = 0;
  let usedChars = 0;
  let truncatedDesc = false;
  let truncatedShots = false;
  let truncatedBlock = false;
  for (const entry of entries) {
    const scene = entry?.scene;
    if (!scene || typeof scene !== 'object') continue;
    const shots = sceneShots(scene);
    const describedCount = shots.filter(
      (s) => s && typeof s === 'object' && typeof s.description === 'string' && s.description.trim(),
    ).length;
    // Need at least two described shots to compare an eyeline / appearance across.
    if (describedCount < 2) continue;
    qualifying += 1;
    // Keep counting (for the omission marker) but stop rendering once EITHER the
    // scene cap or the character budget is reached.
    if (blocks.length >= maxScenes || usedChars >= maxChars) continue;
    const issueNumber = Number.isInteger(entry.issueNumber) ? entry.issueNumber : null;
    const sceneName = typeof scene.heading === 'string' && scene.heading.trim()
      ? scene.heading.trim()
      : (typeof scene.slugline === 'string' && scene.slugline.trim() ? scene.slugline.trim() : 'scene');
    const header = issueNumber != null
      ? `Scene ${blocks.length + 1} (Issue ${issueNumber}): ${sceneName}`
      : `Scene ${blocks.length + 1}: ${sceneName}`;
    const lines = [];
    let renderedShots = 0;
    for (const s of shots) {
      if (!s || typeof s !== 'object') continue;
      // Bound shots-per-scene so one pathological scene with thousands of shots
      // can't dominate the pass; the dropped tail is reported in the line below.
      if (renderedShots >= maxShotsPerScene) { truncatedShots = true; break; }
      const id = typeof s.id === 'string' && s.id ? s.id : 'shot';
      const type = typeof s.shotType === 'string' && s.shotType ? s.shotType : 'unspecified framing';
      const dir = DIRECTION_PROMPT_LABEL[s.screenDirection] || 'screen direction unspecified';
      const from = typeof s.continuityFromShotId === 'string' && s.continuityFromShotId
        ? ` (continues from ${s.continuityFromShotId})`
        : '';
      let desc = typeof s.description === 'string' && s.description.trim()
        ? s.description.trim()
        : '(no description)';
      if (desc.length > maxDescChars) {
        desc = `${desc.slice(0, maxDescChars)}…[truncated]`;
        truncatedDesc = true;
      }
      lines.push(`  - ${id} [${type}, ${dir}]${from}: ${desc}`);
      renderedShots += 1;
    }
    if (truncatedShots && renderedShots === maxShotsPerScene) {
      lines.push('  - …[further shots in this scene omitted to fit the model context]');
    }
    let block = `${header}\n${lines.join('\n')}`;
    // HARD char ceiling: even after the per-shot and per-scene caps, truncate the
    // assembled block to whatever budget remains so the total can't be exceeded by
    // a single scene. Reserve the join's 2 chars.
    const remaining = maxChars - usedChars - 2;
    if (block.length > remaining) {
      block = `${block.slice(0, Math.max(0, remaining))}…[scene truncated]`;
      truncatedBlock = true;
    }
    blocks.push(block);
    usedChars += block.length + 2; // +2 for the '\n\n' join that will follow
  }
  if (!blocks.length) return '';
  const omitted = qualifying - blocks.length;
  if (omitted > 0) {
    blocks.push(`(${omitted} additional scene${omitted === 1 ? '' : 's'} omitted from this eyeline pass to fit the model context — review them in a later pass.)`);
  }
  if (truncatedDesc || truncatedShots || truncatedBlock) {
    blocks.push('(Some shots or descriptions were truncated to fit the model context — open the storyboard for the full text.)');
  }
  return blocks.join('\n\n');
}

/**
 * Detect shot-type monotony in one scene: enough classified shots that they ALL
 * share a single `shotType`. Returns the monotony descriptor or null.
 *
 * Only CLASSIFIED shots (non-null `shotType`) count toward the verdict — an
 * outline where the extractor tagged framing on some shots but not others isn't
 * penalized for the untagged ones. The scene is flagged only when at least
 * `minClassified` shots are classified AND every classified one is the same type
 * (so a 2-of-5 partial tag never trips it).
 *
 * @param {object} scene
 * @param {{ minClassified?: number }} [opts] minClassified — floored at 2 (a
 *   single classified shot is never "monotony"); default 3.
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
