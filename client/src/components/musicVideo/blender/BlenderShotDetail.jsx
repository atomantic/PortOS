import { memo, useRef, useState } from 'react';
import { Box, Camera, Clapperboard, Film, Square } from 'lucide-react';
import BlenderShotPlayer from './BlenderShotPlayer.jsx';
import BlenderShotNote from './BlenderShotNote.jsx';
import BlenderStatusChip from './BlenderStatusChip.jsx';
import {
  blenderShotPlayable, blenderShotRenderStatus, blenderShotTiming, blenderStaleReason, blenderStillPreviewKey, isBlenderJobActive,
} from '../../../lib/musicVideoBlender.js';
import { useFilmApi } from './FilmApiContext.jsx';
import { formatTimecode } from '../../../utils/formatters.js';
import { buttonCls, noticeCls, primaryCls } from './blenderStyles.js';

const WORKING = ['queued', 'rendering', 'encoding'];
const FIELDS = [['summary', 'Summary'], ['action', 'Action'], ['staging', 'Staging'], ['camera', 'Camera'], ['transition', 'Transition'], ['set', 'Set']];

// "Render preview", "Re-render preview" (up to date, so forced), "Resume preview" (frames already on disk), or its progress.
const renderLabel = (noun, view) => {
  if (view.status === 'queued') return `${noun} queued`;
  if (view.status === 'rendering') return view.percent == null ? `Rendering ${noun.toLowerCase()}…` : `${noun} ${view.percent}%`;
  if (view.status === 'encoding') return `Encoding ${noun.toLowerCase()}…`;
  if (view.status === 'done') return `Re-render ${noun.toLowerCase()}`;
  if (view.status === 'partial') return `Resume ${noun.toLowerCase()}`;
  return `Render ${noun.toLowerCase()}`;
};

/**
 * The selected shot: its render actions, the looping player with the song,
 * what the film script says about it, the director's note and its stills.
 * The actions sit above the player so both stay in view on a laptop.
 * `blocker` is why a render cannot start (`{ message, tab }`, null when it can).
 */
function BlenderShotDetail({ blender, shot, audioUrl, blocker, onTime, onOpenPreview, onOpenTab }) {
  const { musicVideoBlenderMediaUrl } = useFilmApi();
  const { state, pending, projectId } = blender;
  const [quality, setQuality] = useState(null);
  const video = useRef(null);
  const preview = blenderShotRenderStatus(state, shot.id, 'preview');
  const final = blenderShotRenderStatus(state, shot.id, 'final');
  const playable = blenderShotPlayable(state, shot.id, quality);
  const renders = state.renders?.[shot.id] || {};
  const activeJobs = (state.jobs || []).filter((job) => job.shotId === shot.id && isBlenderJobActive(job));
  const stillStarting = !!pending[`render:${shot.id}:still`];
  const stillRunning = activeJobs.some((job) => job.quality === 'still');
  const canceling = activeJobs.some((job) => pending[`cancel:${job.id}`]);

  const renderShot = (kind, view) => blender.render({ shotIds: [shot.id], quality: kind, ...(view.status === 'done' ? { force: true } : {}) }, shot.id);
  // A paused player names the frame; otherwise the server takes the shot's midpoint.
  const renderStill = () => {
    const element = video.current;
    const fps = state.settings?.fps;
    const paused = element && element.paused && Number.isFinite(element.currentTime) && element.currentTime >= 0 && fps > 0;
    // Synced shot boundaries are on the frame grid; round their floating-point representation.
    const firstFrame = Math.round(shot.start * fps);
    const lastFrame = Math.round(shot.end * fps) - 1;
    const frame = paused ? Math.max(firstFrame, Math.min(lastFrame, Math.round((shot.start + element.currentTime) * fps))) : null;
    const at = frame == null ? null : frame / fps;
    const times = at != null && at >= shot.start && at < shot.end ? [at] : null;
    blender.render({ shotIds: [shot.id], quality: 'still', ...(times ? { times } : {}) }, shot.id);
  };
  const cancel = () => { for (const job of activeJobs) blender.cancelJob(job.id); };
  const { width, height } = state.settings || {};
  const aspect = width > 0 && height > 0 ? `${width} / ${height}` : null;
  const renderViews = [['Preview', preview], ['Final', final]];
  const stale = renderViews.filter(([, view]) => view.status === 'stale');

  return (
    <section aria-label={`Shot ${shot.id}`} className="@container min-w-0 space-y-2">
      <div className="min-w-0 space-y-1">
        <h4 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm font-medium">
          <span className="shrink-0 font-mono text-xs text-port-text-muted">{shot.id}</span>
          <span className="min-w-0 break-words">{shot.label || 'Untitled shot'}</span>
        </h4>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-port-text-muted">
          <span>{blenderShotTiming(shot)}</span>
          <BlenderStatusChip label="Preview" view={preview} />
          <BlenderStatusChip label="Final" view={final} />
        </div>
      </div>

      <div role="group" aria-label="Render this shot" className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button type="button" className={buttonCls} disabled={!!blocker || stillStarting || stillRunning} onClick={renderStill}
          title="Renders the frame the player is paused on, else the shot's midpoint">
          <Camera size={14} aria-hidden="true" /> {stillStarting || stillRunning ? 'Rendering still…' : 'Render still'}
        </button>
        <button type="button" className={primaryCls} disabled={!!blocker || WORKING.includes(preview.status) || !!pending[`render:${shot.id}:preview`]}
          onClick={() => renderShot('preview', preview)}>
          <Clapperboard size={14} aria-hidden="true" /> {pending[`render:${shot.id}:preview`] ? 'Queuing…' : renderLabel('Preview', preview)}
        </button>
        <button type="button" className={buttonCls} disabled={!!blocker || WORKING.includes(final.status) || !!pending[`render:${shot.id}:final`]}
          onClick={() => renderShot('final', final)}>
          <Film size={14} aria-hidden="true" /> {pending[`render:${shot.id}:final`] ? 'Queuing…' : renderLabel('Final', final)}
        </button>
        <button type="button" className={`${buttonCls} ${activeJobs.length ? '' : 'invisible'}`} disabled={!activeJobs.length || canceling} onClick={cancel}>
          <Square size={14} aria-hidden="true" /> {canceling ? 'Canceling…' : 'Cancel'}
        </button>
        {renders.blend && (
          <button type="button" className={buttonCls} disabled={!state.tool?.ready || !!pending[`open:${shot.id}`]} onClick={() => blender.openShot(shot.id)}
            title={state.tool?.ready ? 'Opens the scene saved with this shot’s last render' : 'Set up Blender first'}>
            <Box size={14} aria-hidden="true" /> {pending[`open:${shot.id}`] ? 'Opening…' : 'Open in Blender'}
          </button>
        )}
      </div>
      {blocker && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-port-warning">
          <span className="min-w-0">{blocker.message}</span>
          <button type="button" className={buttonCls} onClick={() => onOpenTab(blocker.tab)}>{blocker.tab === 'files' ? 'Open Files' : 'Open Settings'}</button>
        </p>
      )}
      {stale.length > 0 && (
        <p role="status" className={noticeCls}>
          {stale.map(([label, view]) => `${label} is out of date: ${blenderStaleReason(view.render)}.`).join(' ')} Render it again to bring it up to date.
        </p>
      )}
      {renderViews.filter(([, view]) => view.status === 'failed' || view.status === 'partial').map(([label, view]) => (
        <p key={label} role={view.status === 'failed' ? 'alert' : 'status'}
          className={`break-words text-xs ${view.status === 'failed' ? 'text-port-error' : 'text-port-text-muted'}`}>
          {label}: {view.detail}
        </p>
      ))}

      <BlenderShotPlayer projectId={projectId} shot={shot} playable={playable} audioUrl={audioUrl} aspect={aspect} onQuality={setQuality} onTime={onTime} videoHandle={video} />

      {FIELDS.some(([field]) => shot[field]) && (
        <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-xs @md:grid-cols-2">
          {FIELDS.filter(([field]) => shot[field]).map(([field, label]) => (
            <div key={field} className="min-w-0">
              <dt className="text-port-text-muted">{label}</dt>
              <dd className="whitespace-pre-wrap break-words">{shot[field]}</dd>
            </div>
          ))}
        </dl>
      )}

      <BlenderShotNote blender={blender} shotId={shot.id} />

      {renders.stills?.length > 0 && (
        <section aria-label="Stills" className="min-w-0 space-y-1">
          <h5 className="text-xs text-port-text-muted">Stills</h5>
          <ul className="grid grid-cols-2 gap-1.5 @md:grid-cols-3 @2xl:grid-cols-4">
            {renders.stills.map((still) => (
              <li key={still.file}>
                <button type="button" onClick={() => onOpenPreview(blenderStillPreviewKey(shot.id, still.file))}
                  className="block w-full overflow-hidden rounded border border-port-border focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent">
                  <img src={musicVideoBlenderMediaUrl(projectId, still.thumbnail || still.file)} alt={`Still at ${formatTimecode(still.timeSec ?? shot.start)}`} loading="lazy" decoding="async"
                    className="aspect-video w-full bg-black object-cover" />
                  {/* Made from scripts or options that have changed since: the shot no longer looks like this. */}
                  {still.stale && <span className="block px-1 py-0.5 text-left text-[11px] text-port-warning">Out of date</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

export default memo(BlenderShotDetail);
