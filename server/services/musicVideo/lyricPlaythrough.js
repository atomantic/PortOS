/**
 * Music Video — the lyric timing playthrough.
 *
 * Word timing is checked by watching the words land on the song, which used to
 * wait for a first composition. This preview needs only the song, its analysis
 * and the aligned lyrics: the shipped layered template draws the words with the
 * shared lyricType.js (the same type and motion the final render uses) over a
 * plain frame, with no images or footage.
 *
 * Its scenes are the board's own timing when the board has timed shots (so each
 * line sits in the text zone its shot will give it), else the lyrics laid out
 * as scenes: one per lyric-sheet section, or per four lines when the sheet has
 * no headers. The layout is built for the preview only; the board is untouched.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { isNonBlankStr } from '../../lib/textUtils.js';
import { buildDocumentPreview } from './documentPreview.js';
import { readTemplateDocumentFiles } from './compositionDocument.js';
import { documentSongDuration } from './documentRender.js';

const LINES_PER_SCENE = 4;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
// The fields the template reads from a shot; no take, frame or clip comes along.
const SCENE_FIELDS = ['sceneId', 'order', 'label', 'sectionLabel', 'startSec', 'endSec', 'shotMode', 'textZone', 'lyricRole', 'lyricText', 'camera', 'stillMove'];

const timedShots = (scenes) => (Array.isArray(scenes) ? scenes : [])
  .filter((scene) => scene?.sceneId && finite(scene.startSec) && finite(scene.endSec) && scene.endSec > scene.startSec)
  .map((scene) => Object.fromEntries(SCENE_FIELDS.filter((key) => scene[key] !== undefined).map((key) => [key, scene[key]])));

/**
 * The lyrics laid out as scenes, `[{ sceneId, order, label, sectionLabel, startSec, endSec }]`.
 * A group starts at each section header (or every four lines without headers); each
 * scene runs from its first timed line to the next scene, the first from 0 and the
 * last to the end of the song.
 */
export function lyricScenes(cues, markers, durationSec) {
  const lines = Array.isArray(cues) ? cues : [];
  const sections = (Array.isArray(markers) ? markers : [])
    .filter((marker) => marker?.type === 'section' && Number.isInteger(marker.line) && marker.line < lines.length)
    .sort((a, b) => a.line - b.line);
  const groups = [];
  if (sections.length) {
    if (sections[0].line > 0) groups.push({ from: 0, label: 'Intro' });
    for (const marker of sections) {
      if (groups.at(-1)?.from === marker.line) groups.at(-1).label = marker.label;
      else groups.push({ from: marker.line, label: marker.label });
    }
  } else {
    for (let from = 0; from < lines.length; from += LINES_PER_SCENE) {
      groups.push({ from, label: `Lines ${from + 1}–${Math.min(from + LINES_PER_SCENE, lines.length)}` });
    }
  }
  const starts = groups.map((group, index) => {
    const until = groups[index + 1]?.from ?? lines.length;
    const first = lines.slice(group.from, until).find((cue) => finite(cue?.startSec) && isNonBlankStr(cue?.text));
    return first ? { label: group.label, startSec: first.startSec } : null;
  }).filter(Boolean);
  return starts.map((scene, index) => {
    const startSec = index === 0 ? 0 : scene.startSec;
    const endSec = starts[index + 1]?.startSec ?? durationSec;
    return { sceneId: `lyric-${index + 1}`, order: index, label: scene.label, sectionLabel: scene.label, startSec, endSec };
  }).filter((scene) => scene.endSec > scene.startSec);
}

/**
 * The preview page for the playthrough, in the shape `buildDocumentPreview`
 * returns. 409 until the song is analyzed and at least one line is timed.
 */
export async function buildLyricPlaythroughPreview(project) {
  const durationSec = documentSongDuration(project);
  if (!durationSec) throw new ServerError('Analyze the song before playing the lyrics through', { status: 409, code: 'NOT_ANALYZED' });
  const cues = project.lyricCues || [];
  if (!cues.some((cue) => finite(cue?.startSec) && isNonBlankStr(cue?.text))) {
    throw new ServerError('Align the words before playing the lyrics through', { status: 409, code: 'NO_TIMED_LYRICS' });
  }
  const shots = timedShots(project.scenes);
  const scenes = shots.length ? shots : lyricScenes(cues, project.lyricMarkers, durationSec);
  // Only the song and the words: no composition, overlay text or narrative events of the project's own.
  const playthrough = { ...project, scenes, composition: { mode: 'document', textCues: [] } };
  return buildDocumentPreview(playthrough, { files: await readTemplateDocumentFiles('layered') });
}
