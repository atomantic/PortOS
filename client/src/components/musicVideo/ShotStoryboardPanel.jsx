import { useState } from 'react';
import { Link } from 'react-router';
import { ImageUp, LayoutPanelLeft, Loader2, RefreshCw, Unlink } from 'lucide-react';
import { sendShotStillToStoryboardPanel, updateShotFromStoryboardPanel } from '../../services/api';
import { selectedTake } from '../storyboards/storyboardArt';

const actionButton = 'min-h-[44px] sm:min-h-[32px] inline-flex shrink-0 items-center gap-1 rounded border border-port-border px-2 text-xs text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const imageName = (ref) => (typeof ref === 'string' ? ref.split(/[?#]/)[0].split('/').pop() : null);

/**
 * A fitted shot's storyboard panel: which panel it came from, a notice when the
 * panel was edited since (Update copies its action to the shot's intent and its
 * art to the shot's frame reference) or deleted (Unlink), and Use as panel art, which sends
 * the shot's still back to the panel as its selected take.
 */
export default function ShotStoryboardPanel({ projectId, storyboardId, scene, linked, onSceneUpdated, onUnlink, onBoard }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  if (!linked) return null;
  const { state, panel, beat, number } = linked;

  const run = async (kind, call) => {
    setBusy(kind);
    setError(null);
    const res = await call().catch((err) => { setError(err?.message || 'That did not work.'); return null; });
    setBusy(null);
    return res;
  };
  const update = async () => {
    const res = await run('update', () => updateShotFromStoryboardPanel(projectId, scene.sceneId, { silent: true }));
    if (res?.scene) onSceneUpdated(scene.sceneId, { visualIntent: res.scene.visualIntent, panelRev: res.scene.panelRev, panelArt: res.scene.panelArt ?? null });
  };
  const sendArt = async () => {
    const res = await run('art', () => sendShotStillToStoryboardPanel(projectId, scene.sceneId, { silent: true }));
    if (res?.scene) onSceneUpdated(scene.sceneId, { panelArt: res.scene.panelArt ?? null });
    if (res?.board) onBoard(res.board);
  };
  const still = imageName(scene.referenceImageId);
  const art = selectedTake(panel);
  const isPanelArt = !!still && art?.source === 'gallery' && art.image === still;

  return (
    <section aria-label="Storyboard panel" className="space-y-1 rounded border border-port-border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <LayoutPanelLeft size={14} className="shrink-0 text-port-accent" aria-hidden="true" />
        {state === 'missing' ? (
          <span className="min-w-0 flex-1 text-port-warning">Its storyboard panel was deleted.</span>
        ) : (
          <Link to={`/storyboards/${storyboardId}/panel/${panel.id}`} className="min-w-0 flex-1 truncate text-gray-300 hover:text-white">
            Storyboard · {beat.title || `Beat ${linked.beatIndex + 1}`} · panel {number}
          </Link>
        )}
        {state === 'missing' && (
          <button type="button" onClick={onUnlink} className={actionButton}><Unlink size={14} aria-hidden="true" /> Unlink</button>
        )}
        {state !== 'missing' && still && (isPanelArt
          ? <span className="text-gray-500">This still is the panel's art</span>
          : (
            <button type="button" onClick={sendArt} disabled={!!busy} className={actionButton}>
              {busy === 'art' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ImageUp size={14} aria-hidden="true" />} Use as panel art
            </button>
          ))}
      </div>
      {state === 'changed' && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-port-warning/40 bg-port-warning/10 p-1.5">
          <p className="min-w-0 flex-1 break-words text-port-warning">
            Storyboard changed: {panel.action || 'the panel has no action now'}{linked.artChanged ? ' (new panel art)' : ''}
          </p>
          <button type="button" onClick={update} disabled={!!busy} className={actionButton}>
            {busy === 'update' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} Update
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-port-error">{error}</p>}
    </section>
  );
}
