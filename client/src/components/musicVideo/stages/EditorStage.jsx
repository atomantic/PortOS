import { useEffect, useMemo, useState } from 'react';
import useMediaQuery from '../../../hooks/useMediaQuery.js';
import Drawer from '../../Drawer';
import ShotTimeline from '../ShotTimeline.jsx';
import ShotCardHost, { blenderShotPosters, shotNamer, useLinkedStoryboard } from '../ShotCardHost.jsx';
import { reorderedSceneIds, timelineShots } from '../../../lib/musicVideoTimeline.js';
import { plannedTransitions } from '../../../lib/musicVideoCutEffects.js';
import { isLayeredComposition } from '../../../lib/musicVideoLayers.js';
import { MUSIC_VIDEO_SCROLL_ID } from '../MusicVideoLayout.jsx';
import toast from '../../ui/Toast';
import { uploadMusicVideoAudioLayer } from '../../../services/apiMusicVideo.js';

// What a PATCH of `audioLayers` may carry: the server keeps each layer's file and length.
const layerPatch = ({ id, startSec, volume, muted, label }) => ({ id, startSec, volume, muted, label });

/**
 * The height that takes `el` from where it sits to the bottom of the page's
 * scroll area, so the docked timeline is on screen
 * without scrolling whatever the headers above it wrap to. Null until measured.
 * Whatever the page still adds below it (a wrapper's padding or gap) is read
 * back from the scroll area's overflow and taken off, so the page never scrolls.
 */
function useScreenFill(el) {
  const [height, setHeight] = useState(null);
  useEffect(() => {
    // The Music Video page scrolls in its own padded area under its title bar, not in `main`.
    const scroller = el?.closest(`#${MUSIC_VIDEO_SCROLL_ID}`) || el?.closest('main');
    if (!el || !scroller || typeof ResizeObserver === 'undefined') return undefined;
    let handle = 0;
    const apply = () => {
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const padBottom = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
      const fit = Math.max(0, Math.floor(scroller.clientHeight - top - padBottom));
      setHeight(fit);
      cancelAnimationFrame(handle);
      handle = requestAnimationFrame(() => {
        const over = scroller.scrollHeight - scroller.clientHeight;
        if (over > 0 && over < fit / 2) setHeight(fit - over);
      });
    };
    apply();
    const observer = new ResizeObserver(apply);
    // A width change is what rewraps the headers above, and it resizes the scroll area too.
    observer.observe(scroller);
    return () => { observer.disconnect(); cancelAnimationFrame(handle); };
  }, [el]);
  return height;
}

/**
 * The widest the preview card in `cell` may be for all of it, its controls
 * included, to fit the cell's height: the card's height less its picture's is
 * its controls, and the picture keeps its own shape. Null until measured.
 */
function usePreviewFit(cell) {
  const [maxWidth, setMaxWidth] = useState(null);
  useEffect(() => {
    if (!cell || typeof ResizeObserver === 'undefined') return undefined;
    const apply = () => {
      const card = cell.firstElementChild;
      // Each player marks the box its picture fills (`data-preview-picture`).
      const picture = card?.querySelector('[data-preview-picture]');
      if (!card || !picture?.offsetHeight || !picture.offsetWidth) return;
      const chrome = card.offsetHeight - picture.offsetHeight;
      const shape = picture.offsetWidth / picture.offsetHeight;
      const width = Math.floor((cell.clientHeight - chrome) * shape + (card.offsetWidth - picture.offsetWidth));
      // A pixel either way is the controls rewrapping; settling on it would loop.
      setMaxWidth((current) => (current != null && Math.abs(current - width) <= 2 ? current : width));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(cell);
    if (cell.firstElementChild) observer.observe(cell.firstElementChild);
    return () => observer.disconnect();
  }, [cell]);
  return maxWidth;
}

/**
 * The editor, laid out like a desktop editing application from `xl` up: one
 * screen with no scrolling, a side panel at the top left (the effects library,
 * or a tapped effect's settings in its place), the preview scaled to fit beside
 * it, and the timeline docked across the bottom. Below `xl` they stack:
 * preview, then the timeline with an effect's settings under it. A tapped shot
 * opens its card in the same slide-in drawer the Shots board uses.
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
  // From xl the timeline puts its library, and a selected effect's settings, in the panel beside the preview.
  const desktop = useMediaQuery('(min-width: 1280px)');
  const [libraryEl, setLibraryEl] = useState(null);
  const [previewCell, setPreviewCell] = useState(null);
  const previewWidth = usePreviewFit(previewCell);
  const [screenEl, setScreenEl] = useState(null);
  const screenHeight = useScreenFill(screenEl);
  // Audio layers over the song: shown at once, saved in order with the board's other project saves.
  const editAudioLayers = (audioLayers) => {
    board.editProjectLocal({ audioLayers });
    return board.saveProjectFields({ audioLayers: audioLayers.map(layerPatch) });
  };
  const addAudioLayer = (file, startSec) => uploadMusicVideoAudioLayer(project.id, file, { startSec, silent: true })
    .then(({ project: updated, layer }) => {
      board.replaceProject(updated);
      toast.success(`Added ${layer.label} at ${startSec.toFixed(2)}s — drag it along its row to move it`);
      return layer;
    })
    .catch((err) => { toast.error(err?.message || 'Failed to add the audio layer'); throw err; });
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
  const timeline = (
    <ShotTimeline project={project} activeSceneId={activeSceneId} songClock={board.songClock} shotName={shotName}
      posters={blenderShotPosters(project, board.blender)}
      onSeek={(t) => board.seekToScene?.({ startSec: t })} onOpenShot={openShot}
      onMoveCut={board.locked ? null : (sceneId, edge, t) => (edge === 'end' ? board.onMoveSceneEnd(sceneId, t) : board.onMoveSceneStart(sceneId, t))}
      onReorder={board.locked || orderOwned ? null : reorder}
      effectOptions={effectOptions} onEditShot={board.locked ? null : editShot}
      onSplitShot={board.locked || orderOwned || !board.onSplitScene ? null : (sceneId, atSec) => board.onSplitScene(sceneId, null, atSec)}
      onPreview={(t, play) => board.seekToScene?.({ startSec: t }, { play, pause: !play })}
      libraryEl={desktop ? libraryEl : null}
      onAddAudioLayer={board.replaceProject ? addAudioLayer : null}
      onEditAudioLayers={board.saveProjectFields ? editAudioLayers : null} />
  );
  const panelCls = 'min-h-0 overflow-y-auto rounded-lg border border-port-border bg-port-card';
  return (
    <div className="min-w-0">
      {desktop ? (
        // One screen: the top row takes what the docked timeline leaves.
        <div ref={setScreenEl} style={screenHeight ? { height: screenHeight } : undefined}
          className="grid h-[calc(var(--mv-scroll-h,100dvh)-var(--mv-header-h,9rem)-3rem)] min-h-[32rem] grid-rows-[minmax(0,1fr)_auto] gap-3">
          {/* A narrow side panel, then the preview centered in the rest, as wide as the row's height allows. */}
          <div className="flex min-h-0 gap-3">
            <section ref={setLibraryEl} aria-label="Effects" className={`${panelCls} w-[24rem] shrink-0`} />
            <div ref={setPreviewCell} className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-hidden">
              <div className="w-full min-w-[20rem]" style={previewWidth ? { maxWidth: previewWidth } : undefined}>{board.previewDock}</div>
            </div>
          </div>
          <div className="max-h-[45dvh] min-h-0 overflow-y-auto">{timeline}</div>
        </div>
      ) : (
        <div className="space-y-3">
          {board.previewDock}
          {timeline}
        </div>
      )}
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
