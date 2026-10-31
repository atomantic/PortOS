/**
 * Music Video production medium (#14244): an optional per-project handmade
 * surface the compositor owns, not the image/video model.
 *
 *   - `stepped`: no smooth motion, blur, gloss or generated lettering in the
 *     prompt, and the final render holds every other frame (24 fps out).
 *   - `beat-graphic`: lettering, labels and UI are compositor-only, and every
 *     section cuts on the intercut loud tier (two beats). No frame retiming.
 *
 * Neither replaces a character style. Pure and browser-safe: the shot card
 * lists the prompt addition as a chip, the render applies the hold.
 */

export const PRODUCTION_MEDIUMS = Object.freeze(['stepped', 'beat-graphic']);

/** The stored medium, or null (today's behavior) for anything unrecognized. */
export const normalizeProductionMedium = (value) => (PRODUCTION_MEDIUMS.includes(value) ? value : null);

const ADDITIONS = Object.freeze({
  stepped: 'Handmade stepped look: no smooth in-between motion, no motion blur, no gloss or glassy sheen, and no generated lettering, captions or signage.',
  'beat-graphic': 'Lettering, labels and interface elements are added later in the compositor: draw no text, captions, logos, signage or UI in the image.',
});

/** The `{ id, label, text }` prompt addition for a project's medium, or null. */
export function productionMediumAddition(project) {
  const medium = normalizeProductionMedium(project?.productionMedium);
  return medium ? { id: 'production-medium', label: 'Production medium', text: ADDITIONS[medium] } : null;
}

/** Whether the project cuts every section on the loud (two beat) intercut tier. */
export const usesLoudTierEverywhere = (project) => normalizeProductionMedium(project?.productionMedium) === 'beat-graphic';

/**
 * Whether the render re-cuts on the song's energy: an intercut project, or a
 * beat-graphic project unless the director chose scene-by-scene cutting.
 */
export const rendersIntercut = (project) => project?.composition?.cutting === 'intercut'
  || (usesLoudTierEverywhere(project) && project?.composition?.cutting !== 'scene');

/**
 * The frame spans a stepped render holds, on the frame grid. `sections` are
 * the render's `{ sceneId, startSec, endSec }` spans on song time; a shot in
 * `performanceSceneIds` keeps its captured frames (lip-sync lives at its own
 * song time). `leadSec` is the cold open ahead of the song in the file.
 *
 * Returns `{ parts, exemptSceneIds }`: `parts` tile `[0, totalFrames)` as
 * `{ startFrame, endFrame, held }`, merged where neighbours agree.
 */
export function steppedHoldPlan(sections, { performanceSceneIds = [], fps = 24, leadSec = 0, totalFrames } = {}) {
  const performance = new Set(performanceSceneIds);
  const exempt = new Set();
  const lead = Math.round(leadSec * fps);
  const spans = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    if (!Number.isFinite(section?.startSec) || !Number.isFinite(section?.endSec)) continue;
    const startFrame = lead + Math.round(section.startSec * fps);
    const endFrame = Math.min(totalFrames ?? Infinity, lead + Math.round(section.endSec * fps));
    if (endFrame <= startFrame) continue;
    const isPerformance = performance.has(section.sceneId);
    if (isPerformance) exempt.add(section.sceneId);
    spans.push({ startFrame, endFrame, held: !isPerformance });
  }
  spans.sort((a, b) => a.startFrame - b.startFrame);
  const parts = [];
  let cursor = 0;
  const push = (startFrame, endFrame, held) => {
    if (endFrame <= startFrame) return;
    const last = parts[parts.length - 1];
    if (last && last.held === held && last.endFrame === startFrame) last.endFrame = endFrame;
    else parts.push({ startFrame, endFrame, held });
  };
  for (const span of spans) {
    const startFrame = Math.max(cursor, span.startFrame);
    push(cursor, startFrame, false);
    push(startFrame, Math.max(startFrame, span.endFrame), span.held);
    cursor = Math.max(cursor, span.endFrame);
  }
  if (Number.isFinite(totalFrames)) push(cursor, totalFrames, false);
  return { parts, exemptSceneIds: [...exempt] };
}
