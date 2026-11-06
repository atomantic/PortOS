/**
 * The other direction of the shot sync (syncMusicVideo.js): a shot edit the
 * director makes in the shot editor (a moved cut, a merge, a split) on a video
 * keeping its shots in sync with its board. The board is what times those
 * shots, so without this the next board edit would undo the shot edit. The
 * panels take the edit here; the sync that follows the board write finds them
 * matching.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { STORYBOARD_LIMITS, newStoryboardEntityId } from '../../lib/storyboardVocabulary.js';
import { isPreMusicShot } from '../../lib/musicVideoColdOpen.js';
import { storyboardFitSong } from '../../lib/storyboardFit.js';
import { STORYBOARD_SYNC_END_SLACK_SEC } from '../../lib/storyboardShotSync.js';
import { getStoryboard, mutateStoryboard } from './index.js';

const hundredths = (sec) => Math.round(sec * 100) / 100;

export const boardFollowsShots = (project) => Boolean(project?.storyboardId && project.storyboardSync === true);

// Panels play end to end from the song's start, and the last one runs to the song's end when it gets within
// a second of it (storyboardPanelSpans). A cut the board can't hold would be undone by the sync after the board
// write, so it is refused before anything changes.
export function assertBoardHoldsFirstStart(project, startSec) {
  if (!boardFollowsShots(project) || startSec < 0.005) return;
  throw new ServerError("This video's shots follow its storyboard, which starts with the song, so the first shot starts at 0.", { status: 400, code: 'STORYBOARD_FIRST_START' });
}

export function assertBoardHoldsLastEnd(project, endSec) {
  if (!boardFollowsShots(project)) return;
  const songSec = storyboardFitSong(project)?.durationSec;
  if (!(songSec > 0) || Math.abs(songSec - endSec) < 0.005 || Math.abs(songSec - endSec) > STORYBOARD_SYNC_END_SLACK_SEC) return;
  throw new ServerError(`This video's shots follow its storyboard, where the last shot runs to the song's end unless it stops more than ${STORYBOARD_SYNC_END_SLACK_SEC}s before it. End it at ${songSec.toFixed(2)}s or earlier than ${(songSec - STORYBOARD_SYNC_END_SLACK_SEC).toFixed(2)}s.`, { status: 400, code: 'STORYBOARD_LAST_END' });
}

/** A linked song shot's panel length, as `[panelId, seconds]`, or null for a cold-open or unlinked shot. */
export function panelLength(scene) {
  if (!scene?.panelId || isPreMusicShot(scene)) return null;
  if (typeof scene.startSec !== 'number' || typeof scene.endSec !== 'number') return null;
  return [scene.panelId, hundredths(scene.endSec - scene.startSec)];
}

/** Id a new panel for each later piece of a split, refusing before the shots change if the board has no room. */
export async function reservePanelsForSplit(project, sceneId, count) {
  const panelId = project.scenes?.find((scene) => scene.sceneId === sceneId)?.panelId;
  if (!boardFollowsShots(project) || !panelId || count <= 0) return [];
  const board = await getStoryboard(project.storyboardId);
  const beat = board.beats.find((entry) => entry.panels.some((panel) => panel.id === panelId));
  if (!beat) return [];
  const total = board.beats.reduce((sum, entry) => sum + entry.panels.length, 0);
  if (beat.panels.length + count > STORYBOARD_LIMITS.panelsPerBeat || total + count > STORYBOARD_LIMITS.panelsTotal) {
    throw new ServerError("This shot's storyboard has no room for another panel, so it can't be split here.", { status: 409, code: 'STORYBOARD_PANELS_FULL' });
  }
  return Array.from({ length: count }, () => newStoryboardEntityId('panel'));
}

/**
 * Give the board a shot edit: `lengths` are `[panelId, seconds]` pairs, `remove`
 * panels whose shot was merged away, and `copies` the new panels of a split
 * (`{ fromPanelId, id, seconds }`, each placed after the last piece before it).
 * A panel the board no longer has is skipped. Writing the board runs the shot
 * sync, so this waits for it.
 */
export async function applyShotEditToBoard(project, { lengths = [], remove = [], copies = [] }) {
  if (!boardFollowsShots(project) || (!lengths.length && !remove.length && !copies.length)) return;
  await mutateStoryboard(project.storyboardId, (draft) => {
    const seconds = new Map(lengths);
    for (const beat of draft.beats) {
      for (const panel of beat.panels) if (seconds.has(panel.id)) panel.seconds = seconds.get(panel.id);
    }
    const placedAfter = new Map();
    for (const { fromPanelId, id, seconds: length } of copies) {
      const beat = draft.beats.find((entry) => entry.panels.some((panel) => panel.id === fromPanelId));
      if (!beat) continue;
      const source = beat.panels.find((panel) => panel.id === fromPanelId);
      const after = placedAfter.get(fromPanelId) ?? fromPanelId;
      beat.panels.splice(beat.panels.findIndex((panel) => panel.id === after) + 1, 0, { ...structuredClone(source), id, seconds: length });
      placedAfter.set(fromPanelId, id);
    }
    const gone = new Set(remove);
    for (const beat of draft.beats) beat.panels = beat.panels.filter((panel) => !gone.has(panel.id));
  });
}
