import { MousePointerClick } from 'lucide-react';
import ShotTimeline from '../ShotTimeline.jsx';
import ShotCardHost, { blenderShotPosters, shotNamer, useLinkedStoryboard } from '../ShotCardHost.jsx';
import { reorderedSceneIds, timelineShots } from '../../../lib/musicVideoTimeline.js';

/**
 * The editor: the shots on a timeline under the preview player, with the open
 * shot's card beside them, laid out like an editing application. From `xl` the
 * player sits over the timeline with the shot card in a column on the right;
 * below that they stack (player, timeline, shot), so the timeline stays under
 * the picture on a phone.
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
  const open = scenes.some((scene) => scene.sceneId === activeSceneId);
  const mode = project.composition?.mode;
  // A Blender film's or a composition document's shots take their order from that source, not the board.
  const orderOwned = mode === 'blender' || (mode === 'document' && project.productionReview?.draft?.storyboardSource === 'document');
  const reorder = (fromIndex, toIndex) => {
    const { shots } = timelineShots(project);
    const ids = reorderedSceneIds(scenes, shots, fromIndex, toIndex);
    if (ids) board.reorderShots(ids, shots[fromIndex].scene);
  };
  return (
    <div className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)]">
      <div className="min-w-0 space-y-3 xl:sticky xl:top-[calc(var(--mv-header-h,9rem)-0.75rem)]">
        {board.previewDock}
        <ShotTimeline project={project} activeSceneId={activeSceneId} songClock={board.songClock} shotName={shotName}
          posters={blenderShotPosters(project, board.blender)}
          onSeek={(t) => board.seekToScene?.({ startSec: t })} onOpenShot={openShot}
          onMoveCut={board.locked ? null : (sceneId, edge, t) => (edge === 'end' ? board.onMoveSceneEnd(sceneId, t) : board.onMoveSceneStart(sceneId, t))}
          onReorder={board.locked || orderOwned ? null : reorder} />
      </div>
      <section aria-label="Shot" className="min-w-0 rounded-lg border border-port-border bg-port-card">
        {open ? (
          <ShotCardHost board={board} sceneId={activeSceneId} storyboard={storyboard} onStoryboard={setStoryboard}
            onClose={() => onToggleSceneExpand?.(activeSceneId, false)} onOpenShot={openShot} />
        ) : (
          <p className="flex items-center gap-2 p-3 text-sm text-port-text-muted">
            <MousePointerClick size={16} aria-hidden="true" className="shrink-0" /> Tap a shot on the timeline to edit it.
          </p>
        )}
      </section>
    </div>
  );
}
