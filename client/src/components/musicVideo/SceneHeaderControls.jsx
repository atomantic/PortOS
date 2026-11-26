import { Activity, ChevronLeft, ChevronRight, Undo2, X } from 'lucide-react';
import { formatTimecode } from '../../utils/formatters.js';
import { SCENE_ATTENTION_LABELS } from '../../lib/musicVideoSceneAttention.js';
import { sceneShotName } from '../../lib/musicVideoStages.js';
import ScenePoster from './ScenePoster.jsx';
import SceneRenderProgress from './SceneRenderProgress.jsx';
import { frameSpan } from './sceneCardProps.js';

/**
 * Sticky shot drawer header: poster thumbnail, shot title/timing/readiness/attention badges,
 * Done checkbox, Previous/Next shot navigation, Close button, and live frame/clip progress.
 * Sits outside the locked fieldset so stepping between shots and closing always work.
 */
export default function SceneHeaderControls({
  scene, project, posterSrc, shotName, fieldId,
  frameReadiness, clipPlayback, attention,
  locked, doneSaving, onSetDone, onToggleDone, onUndoBoardEdit = null, undoingBoard = false, stepShot, onClose,
  generatingLane, generatingFrame, generatingVideo, frameProgress, clipJobs,
}) {
  const { clipId, clipSec } = clipPlayback;
  const boardUndo = project?.boardUndo || null;
  const hasSpan = typeof scene.startSec === 'number' && typeof scene.endSec === 'number';
  const videoReady = clipId && project?.assetMarks?.[`video:${clipId}`] !== 'bad';
  const showProgress = generatingLane || generatingFrame || generatingVideo;

  return (
    <header className="port-opaque-surface sticky -top-4 z-10 -mx-4 -mt-4 mb-3 flex flex-wrap items-center gap-3 border-b border-port-border px-4 py-2">
      <ScenePoster src={posterSrc} scene={scene} scenes={project?.scenes} iconSize={14} className="aspect-video w-20 shrink-0 rounded border border-port-border max-sm:hidden" />
      <div className="min-w-0 flex-1">
        <h2 id={`scene-${scene.sceneId}-title`} tabIndex={-1} data-shot-heading className="truncate text-base font-medium text-white focus:outline-hidden">
          {shotName || sceneShotName(scene)}
        </h2>
        <div className="truncate text-[11px] text-port-text-muted">
          {hasSpan
            ? `${(scene.endSec - scene.startSec).toFixed(2)}s · ${formatTimecode(scene.startSec)}–${formatTimecode(scene.endSec)} · ${frameSpan(scene)}`
            : `#${scene.order + 1}`}
          {frameReadiness.text ? ` · ${frameReadiness.text}` : ''}
          {videoReady ? ' · video ready' : ''}
          {frameReadiness.reasons.length > 0 && <span className="block truncate text-port-warning">{frameReadiness.reasons.join(' · ')}</span>}
          {clipSec != null ? ` · clip ${clipSec.toFixed(1)}s` : ''}
        </div>
        {scene.lyricText && <div className="truncate text-[11px] italic text-port-text-muted">♪ {scene.lyricText}</div>}
        {attention.length > 0 && (
          <ul aria-label="Needs attention" className="mt-0.5 flex flex-wrap gap-1">
            {attention.map((code) => (
              <li key={code} data-attention={code} className="whitespace-nowrap rounded border border-port-warning/40 bg-port-warning/10 px-1.5 text-[10px] text-port-warning">
                {SCENE_ATTENTION_LABELS[code]}
              </li>
            ))}
          </ul>
        )}
      </div>
      {boardUndo?.count > 0 && onUndoBoardEdit && (
        <button type="button" onClick={() => onUndoBoardEdit()} disabled={locked || undoingBoard}
          aria-label={`Undo ${boardUndo.label}`} title={`Undo ${boardUndo.label} (⌘Z)`}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-port-border px-2 text-xs text-port-text hover:bg-port-border disabled:opacity-40 pointer-fine:sm:min-h-[36px]">
          <Undo2 size={14} aria-hidden="true" />
          <span>Undo</span>
        </button>
      )}
      {onSetDone && (
        <label htmlFor={fieldId('done')} className="flex min-h-[44px] shrink-0 items-center gap-2 rounded border border-port-border px-2 text-sm pointer-fine:sm:min-h-[36px]">
          <input id={fieldId('done')} type="checkbox" checked={!!scene.shotSheet?.checked} disabled={locked || doneSaving}
            onChange={(event) => onToggleDone(event.target.checked)} />
          {doneSaving ? 'Saving…' : 'Done'}
        </label>
      )}
      {stepShot && (
        <>
          <button type="button" onClick={stepShot.prev || undefined} disabled={!stepShot.prev} aria-label="Previous shot" title="Previous shot"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-port-border text-port-text hover:bg-port-border disabled:opacity-40 pointer-fine:sm:min-h-[36px] pointer-fine:sm:min-w-[36px]">
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={stepShot.next || undefined} disabled={!stepShot.next} aria-label="Next shot" title="Next shot"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-port-border text-port-text hover:bg-port-border disabled:opacity-40 pointer-fine:sm:min-h-[36px] pointer-fine:sm:min-w-[36px]">
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </>
      )}
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Close shot" title="Close shot"
          className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-port-border/50 hover:text-white">
          <X size={20} aria-hidden="true" />
        </button>
      )}
      {/* Render status wraps under the title instead of squeezing it. */}
      {showProgress && (
        <span className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1">
          {generatingLane && (
            <span className="flex items-center gap-1 text-[11px] text-port-accent">
              <Activity size={14} className="animate-spin" aria-label="Generating" />
              {generatingLane}
            </span>
          )}
          <SceneRenderProgress kind="Frame" generating={generatingFrame} progress={frameProgress} />
          {clipJobs.map((job) => (
            <SceneRenderProgress key={job.key} kind={job.label ? `Video (${job.label})` : 'Video'} generating
              progress={job.running ? { progress: job.progress } : null} retry={job.retry} />
          ))}
        </span>
      )}
    </header>
  );
}
