/** Builds and compares the playable source list for the Music Video preview dock. */
import { formatTimecode } from '../utils/formatters.js';
import { isNonBlankStr } from './textUtils';
import { projectHasAudio } from './musicVideoStageProgress.js';
import { projectPreviz } from '../../../server/lib/musicVideo/musicVideoPreviz.js';

const FILM_LIVE_LABEL = 'Film (live)';

/**
 * The dock's live composite. Layered styles can play it without final-quality
 * shot segments: a composition document plays its document, a composed
 * video cuts the selected takes, and a Blender film cuts its shots' renders
 * once it has synced shots (`project.blenderShots`). Every other style keeps
 * the same row disabled and says why, so the picker does not drop it silently.
 */
function liveCompositeSource(project) {
  const mode = project?.composition?.mode || 'concat';
  if (mode === 'document') {
    return project.composition?.document
      ? { id: 'document', kind: 'document', label: 'Composition (live)' }
      : { id: 'document', kind: 'document', label: 'Composition (live)', disabled: true, reason: 'Attach a composition document to play the live composite.' };
  }
  if (mode === 'composed') return { id: 'composite', kind: 'composite', label: 'Composition (live)' };
  if (mode === 'blender') {
    const film = { id: 'composite', kind: 'composite', label: FILM_LIVE_LABEL };
    return project.blenderShots?.total > 0
      ? film
      : { ...film, disabled: true, reason: 'Sync shots from scripts in Blender film on Shots to watch the film live.' };
  }
  const reason = mode === 'code'
    ? 'Code-rendered video draws the song in code and has no take composite.'
    : mode === 'eidoverse'
      ? 'Eidoverse video renders a saved scene and has no take composite.'
      : 'Footage cuts the clips as they are and has no live composite.';
  return { id: 'composite', kind: 'composite', label: 'Composition (live)', disabled: true, reason };
}

const previewChangeName = (source) => (source.id === 'document'
  ? 'Composition (live) from the composition document'
  : source.id === 'composite'
    ? (source.label === FILM_LIVE_LABEL ? 'Film (live) from the Blender shot renders' : 'Composition (live) from the selected takes')
    : source.label);

/**
 * What a render-style change does to the dock: the playable sources that
 * leave and the ones that arrive. Disabled rows stay listed, so they are not
 * counted as appearing or disappearing. Empty when the playable set is unchanged.
 */
export function describePreviewSourceChange(before, after) {
  const playable = (list) => (list || []).filter((source) => !source.disabled);
  const beforePlayable = playable(before);
  const afterPlayable = playable(after);
  // The live composite keeps one id across styles, so what it plays from tells two of them apart.
  const same = (a, b) => a.id === b.id && previewChangeName(a) === previewChangeName(b);
  const dropped = beforePlayable.filter((source) => !afterPlayable.some((next) => same(next, source)));
  const added = afterPlayable.filter((source) => !beforePlayable.some((prev) => same(prev, source)));
  if (!dropped.length && !added.length) return '';
  const parts = [];
  if (dropped.length) parts.push(`drops ${dropped.map(previewChangeName).join(', ')}`);
  if (added.length) parts.push(`adds ${added.map(previewChangeName).join(', ')}`);
  return `Preview ${parts.join(' and ')}.`;
}

/**
 * Everything the docked preview can play, in the order it picks a default:
 * the final render (its resolved file and timing), the live composite,
 * then each finished draft excerpt, newest first. `leadWith` picks the
 * ordering: `"final"` (default) as above; `"drafts"` (Final render stage)
 * puts the drafts before the composition; `"storyboard"` (Plan and Shots
 * stages) puts the live composite, then the animatic, first; `"previz"` (Previz
 * stage) puts the greybox previz first. A final render whose
 * inputs changed is labelled out of date. Last comes the storyboard animatic —
 * the song under each shot's frame or card — so a project with a track and
 * shots always has something to watch — and after it the lyric timing
 * playthrough once the words are aligned. The live composite is always
 * listed ("Film (live)" for a Blender film): a style that cannot play it is
 * disabled and carries `reason`.
 * Each entry has a stable `id` (the `?play=` value) and a `label` for the source picker.
 */
export function listPreviewSources(project, { finalVideo = null, leadWith = 'final' } = {}) {
  const sources = [];
  const final = project?.renderHistoryId && finalVideo?.src
    ? {
        id: 'final', kind: 'video', label: project.renderDependencyState?.status === 'stale' ? 'Final render (out of date)' : 'Final render',
        src: finalVideo.src, startSec: 0, endSec: finalVideo.songDurationSec ?? null, fps: finalVideo.fps,
        // The file clock starts before song zero when a cold open is encoded.
        clockOffsetSec: finalVideo.songStartSec == null ? null : -finalVideo.songStartSec,
      }
    : null;
  const live = liveCompositeSource(project);
  const drafts = (project?.excerpts || []).filter((e) => e.status === 'complete' && e.filename).reverse().map((excerpt) => ({
    id: `excerpt:${excerpt.id}`, kind: 'video', src: `/data/videos/${excerpt.filename}`,
    startSec: excerpt.startSec, endSec: excerpt.endSec,
    label: `${excerpt.dependencyState?.status === 'stale' ? 'Older draft' : 'Draft'} ${formatTimecode(excerpt.startSec)}–${formatTimecode(excerpt.endSec)} · ${excerpt.id.slice(-6)}`,
  }));
  // Final render is reviewed by watching its drafts until the final render exists.
  const ordered = leadWith === 'storyboard' ? [live, final, ...drafts] : leadWith === 'drafts' ? [final, ...drafts, live] : [final, live, ...drafts];
  sources.push(...ordered.filter(Boolean));
  if (projectHasAudio(project) && (project?.scenes || []).length > 0) {
    const animatic = { id: 'animatic', kind: 'animatic', label: 'Storyboard animatic' };
    // On Storyboard the storyboard itself leads (the live document, else the animatic): a draft
    // clip covers only its own range, so most shots could not be played from it.
    // The live composite is always present, so the animatic follows it on Storyboard.
    if (leadWith === 'storyboard') sources.splice(1, 0, animatic);
    else sources.push(animatic);
  }
  // The song over the live Three.js greybox, cut to each shot's camera: blocking is watched before anything renders.
  if (projectHasAudio(project) && projectPreviz(project)) {
    const previz = { id: 'previz', kind: 'previz', label: 'Greybox previz' };
    if (leadWith === 'previz') sources.unshift(previz);
    else sources.push(previz);
  }
  // The aligned words over a plain frame, for checking timing before there is any picture.
  if (projectHasAudio(project) && project.audioAnalysis
    && (project.lyricCues || []).some((cue) => typeof cue.startSec === 'number' && isNonBlankStr(cue.text))) {
    const lyrics = { id: 'lyrics', kind: 'lyrics', label: 'Lyric timing' };
    // On Song the words are being checked: lead with them. The animatic and renders
    // follow the lyric overlay setting, so with overlays off they show no words.
    if (leadWith === 'lyrics') sources.unshift(lyrics);
    else sources.push(lyrics);
  }
  return sources;
}
