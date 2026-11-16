import { useMemo } from 'react';
import Drawer from '../../Drawer';
import ShotTimeline from '../ShotTimeline.jsx';
import ShotCardHost, { blenderShotPosters, shotNamer, useLinkedStoryboard } from '../ShotCardHost.jsx';
import { reorderedSceneIds, timelineShots } from '../../../lib/musicVideoTimeline.js';
import { plannedTransitions } from '../../../lib/musicVideoCutEffects.js';
import { isLayeredComposition } from '../../../lib/musicVideoLayers.js';

/**
 * The editor: the shots on a timeline under the preview player, laid out like
 * an editing application, with the whole page width for both. A tapped shot
 * opens its card in the same slide-in drawer the Shots board uses, over the
 * editor rather than beside it, so the timeline never gives up its width.
 *
 * It is another view of the Shots board, not a second copy of it: the player
 * is the workspace's preview (`board.previewDock`), the card is the board's own
 * (`ShotCardHost`), and the open shot is the route (`…/editor/scene/:sceneId`).
 */
export default function EditorStage({ board }) {
  const { project, activeSceneId, onToggleSceneExpand } = board;
  const [storyboard, setStoryboard] = useLinkedStoryboard(project.storyboardId);
  const { shotName } = shotNamer(project);
  const scenes = project.scenes || [];
  // What the Shots board's effect badges read, so the timeline's effects track shows the same effects.
  const storyboardRows = project.productionReview?.draft?.storyboard;
  const layered = isLayeredComposition(project);
  const effectOptions = useMemo(() => ({ layered, planned: plannedTransitions(storyboardRows), cameras: project.cameras }),
    [layered, storyboardRows, project.cameras]);
  const editShot = (sceneId, patch) => { board.editSceneLocal(sceneId, patch); return board.saveScene(sceneId, patch); };
  const openShot = (scene) => {
    board.seekToScene?.(scene);
    onToggleSceneExpand?.(scene.sceneId, true);
  };
  if (!scenes.length) {
    return (
      <div className="space-y-2 text-sm text-port-text-muted">
        <p>No shots to edit yet.</p>
        <button type="button" onClick={() => board.goToStage('board')} className="min-h-[44px] rounded border border-port-border px-3 text-port-text hover:border-port-accent pointer-fine:sm:min-h-[32px]">
          Plan shots on Storyboard
        </button>
      </div>
    );
  }
  const activeScene = scenes.find((scene) => scene.sceneId === activeSceneId) || null;
  const closeShot = () => onToggleSceneExpand?.(activeSceneId, false);
  const mode = project.composition?.mode;
  // A Blender film's or a composition document's shots take their order from that source, not the board.
  const orderOwned = mode === 'blender' || (mode === 'document' && project.productionReview?.draft?.storyboardSource === 'document');
  const reorder = (fromIndex, toIndex) => {
    const { shots } = timelineShots(project);
    const ids = reorderedSceneIds(scenes, shots, fromIndex, toIndex);
    if (ids) board.reorderShots(ids, shots[fromIndex].scene);
  };
  return (
    <div className="min-w-0 space-y-3">
      {board.previewDock}
      <ShotTimeline project={project} activeSceneId={activeSceneId} songClock={board.songClock} shotName={shotName}
        posters={blenderShotPosters(project, board.blender)}
        onSeek={(t) => board.seekToScene?.({ startSec: t })} onOpenShot={openShot}
        onMoveCut={board.locked ? null : (sceneId, edge, t) => (edge === 'end' ? board.onMoveSceneEnd(sceneId, t) : board.onMoveSceneStart(sceneId, t))}
        onReorder={board.locked || orderOwned ? null : reorder}
        effectOptions={effectOptions} onEditShot={board.locked ? null : editShot}
        onPreview={(t) => board.seekToScene?.({ startSec: t }, { play: true })} />
      {/* The shot draws its own header (thumbnail, timing, previous / next, close). */}
      <Drawer open={!!activeScene} size="xl" onClose={closeShot} title={activeScene ? shotName(activeScene) : 'Shot'}
        closeLabel="Close shot" showHeader={false}>
        {activeScene && (
          <ShotCardHost board={board} sceneId={activeScene.sceneId} storyboard={storyboard} onStoryboard={setStoryboard}
            onClose={closeShot} onOpenShot={openShot} />
        )}
      </Drawer>
    </div>
  );
}
