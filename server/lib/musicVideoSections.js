/**
 * Director edits to a music video's song map (`audioAnalysis.sections`).
 * Pure: the route and the storage backends share these transforms.
 */
import { ServerError } from './errorHandler.js';
import { lyricSectionSpans } from './lyricSectionSpans.js';

export const SECTION_MIN_SEC = 0.5;
export const SECTION_MAX_COUNT = 64;
// A boundary this close to its neighbour (or to 0 / the song end) is the same
// boundary; the edit snaps it exact so the map stays gapless.
const EDGE_TOLERANCE_SEC = 0.05;

const round3 = (n) => Number(n.toFixed(3));
const bad = (message) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });

// Duration-weighted mean of the prior sections' energy across [startSec, endSec].
function energyByOverlap(prior, startSec, endSec) {
  let weighted = 0;
  let covered = 0;
  for (const section of prior) {
    const overlap = Math.min(endSec, section.endSec) - Math.max(startSec, section.startSec);
    if (!(overlap > 0)) continue;
    weighted += overlap * (typeof section.energy === 'number' ? section.energy : 1);
    covered += overlap;
  }
  return covered > 0 ? round3(weighted / covered) : 1;
}

/**
 * Validate a director-edited section list against the song and return the
 * stored shape. The list must tile the song: start at 0, end at `durationSec`,
 * ascending and gapless, each section at least SECTION_MIN_SEC long. Energy is
 * carried from the prior sections by overlap, so a split inherits its parent's
 * loudness and a merge averages its parts. Edited sections are marked
 * `labelSource: 'manual'` so a later lyric relabel never renames them.
 */
export function applyEditedSections(sections, prior, durationSec) {
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > SECTION_MAX_COUNT) {
    throw bad(`Provide 1-${SECTION_MAX_COUNT} sections`);
  }
  if (!(durationSec > 0)) throw bad('Analyze the song before editing its sections');
  const priorList = Array.isArray(prior) ? prior : [];
  let cursor = 0;
  return sections.map((section, i) => {
    const label = String(section.label ?? '').trim();
    if (!label) throw bad(`Section ${i + 1} needs a name`);
    const last = i === sections.length - 1;
    if (Math.abs(section.startSec - cursor) > EDGE_TOLERANCE_SEC) {
      throw bad(i === 0 ? 'The first section must start at 0s' : `Section ${i + 1} must start where section ${i} ends (${round3(cursor)}s)`);
    }
    const startSec = cursor;
    let endSec = round3(section.endSec);
    if (last) {
      if (Math.abs(endSec - durationSec) > EDGE_TOLERANCE_SEC) throw bad(`The last section must end at the song's end (${round3(durationSec)}s)`);
      endSec = round3(durationSec);
    }
    if (endSec - startSec < SECTION_MIN_SEC) throw bad(`Section ${i + 1} must be at least ${SECTION_MIN_SEC}s long`);
    cursor = endSec;
    return { label, startSec: round3(startSec), endSec, energy: energyByOverlap(priorList, startSec, endSec), labelSource: 'manual' };
  });
}

/**
 * Section list taken from the aligned lyric sheet: each lyric section runs to
 * the next one, with Intro before the first and Outro after the last when they
 * leave at least SECTION_MIN_SEC. Returns [] when no lyric section is timed.
 */
export function sectionsFromLyricSpans(cues, markers, durationSec) {
  const spans = lyricSectionSpans(cues, markers);
  if (spans.length === 0 || !(durationSec > 0)) return [];
  const out = spans
    .map((span) => ({ label: span.label, startSec: span.startSec, endSec: Math.min(span.endSec, durationSec) }))
    .filter((span) => span.endSec > span.startSec);
  if (out.length === 0) return [];
  // Stretch the first back to 0 and the last out to the song end when the sheet
  // leaves no room for an Intro/Outro, so the map stays gapless.
  if (out[0].startSec >= SECTION_MIN_SEC) out.unshift({ label: 'Intro', startSec: 0, endSec: out[0].startSec });
  else out[0].startSec = 0;
  const tail = out[out.length - 1];
  if (durationSec - tail.endSec >= SECTION_MIN_SEC) out.push({ label: 'Outro', startSec: tail.endSec, endSec: durationSec });
  else tail.endSec = durationSec;
  return out;
}

/**
 * Re-point scenes that were tied to a section at the edited map: the section
 * holding the scene's midpoint supplies its index and label.
 */
export function remapScenesToSections(scenes, sections) {
  return (scenes || []).map((scene) => {
    const tied = scene.sectionIndex != null || scene.sectionLabel != null;
    if (!tied || typeof scene.startSec !== 'number' || typeof scene.endSec !== 'number') return scene;
    const mid = (scene.startSec + scene.endSec) / 2;
    let index = sections.findIndex((s) => mid >= s.startSec && mid < s.endSec);
    if (index < 0) index = mid < 0 ? 0 : sections.length - 1;
    return { ...scene, sectionIndex: index, sectionLabel: sections[index].label };
  });
}
