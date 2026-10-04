import { useMemo, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import { sceneHasPendingDecision } from '../../lib/musicVideoTakes.js';

const FOCUS = '[data-take-focus]';

/**
 * Project contact sheet (#8965): every scene's frame and clip takes side by
 * side, so the director can compare candidates across the whole video, pick
 * the ones the render uses, and reject the misses in one pass. Opened from the
 * Board and Produce toolbars; its open state lives in the URL (`?sheet=contact`)
 * as does the "Pending decisions" filter (`pending`, driven by the page).
 *
 * Arrow keys move focus between take thumbnails: Left/Right within the sheet,
 * Up/Down to the first take of the previous/next scene.
 */
export default function ContactSheetDrawer({
  open, onClose, project, busy, onSelectTake, onReviewTake, onOpenPreview,
  pendingOnly = false, onPendingOnlyChange, onRegenerateFrame, generatingScenes = {},
}) {
  const listRef = useRef(null);
  const allScenes = project?.scenes || [];
  const scenes = useMemo(
    () => (pendingOnly ? allScenes.filter(sceneHasPendingDecision) : allScenes),
    [allScenes, pendingOnly],
  );

  const onKeyDown = (e) => {
    if (!e.key.startsWith('Arrow') || e.target.closest('input, textarea, select')) return;
    const all = [...listRef.current.querySelectorAll(FOCUS)];
    const at = all.indexOf(e.target.closest(FOCUS));
    if (at === -1) return;
    let next = null;
    if (e.key === 'ArrowRight') next = all[at + 1];
    else if (e.key === 'ArrowLeft') next = all[at - 1];
    else {
      const items = [...listRef.current.querySelectorAll('[data-sheet-scene]')];
      const sceneAt = items.findIndex((li) => li.contains(e.target));
      next = items[sceneAt + (e.key === 'ArrowDown' ? 1 : -1)]?.querySelector(FOCUS);
    }
    if (next) { e.preventDefault(); next.focus(); }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Contact sheet" subtitle={project?.name} size="xl" closeLabel="Close contact sheet">
      <div className="mb-3 flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs min-h-[44px] sm:min-h-0">
          <input type="checkbox" checked={pendingOnly} onChange={(e) => onPendingOnlyChange?.(e.target.checked)} />
          Pending decisions
        </label>
        <span className="text-[11px] text-port-text-muted">{scenes.length} of {allScenes.length} scenes</span>
      </div>
      {allScenes.length === 0 && <p className="text-sm text-port-text-muted">No scenes yet.</p>}
      {allScenes.length > 0 && scenes.length === 0 && <p className="text-sm text-port-text-muted">No scenes have undecided candidates.</p>}
      <ol ref={listRef} onKeyDown={onKeyDown} className="space-y-3">
        {scenes.map((scene) => {
          const index = allScenes.indexOf(scene);
          return (
            <li key={scene.sceneId} data-sheet-scene="" className="rounded border border-port-border p-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium truncate">
                  {index + 1}. {scene.sectionLabel || scene.label || `Scene ${index + 1}`}
                </div>
                {onRegenerateFrame && (
                  <button type="button" disabled={busy || !!generatingScenes[scene.sceneId]} onClick={() => onRegenerateFrame(scene)}
                    className="inline-flex shrink-0 items-center gap-1 rounded bg-port-border px-2 py-1 text-[11px] min-h-[44px] sm:min-h-0 disabled:opacity-50"
                    title="Generate another frame take for this scene">
                    <RefreshCw size={12} className={generatingScenes[scene.sceneId] ? 'animate-spin' : ''} /> Regenerate frame
                  </button>
                )}
              </div>
              {!(scene.takes?.length || scene.referenceImageId || scene.videoHistoryId) && (
                <p className="text-[11px] text-port-text-muted">No takes yet.</p>
              )}
              {['image', 'video'].map((kind) => (
                <SceneTakeStrip key={kind} scene={scene} kind={kind} busy={busy} large
                  onSelect={(take) => onSelectTake(scene, take)}
                  onReview={(take, review) => onReviewTake(scene, take, review)}
                  onOpenPreview={onOpenPreview} />
              ))}
            </li>
          );
        })}
      </ol>
    </Drawer>
  );
}
