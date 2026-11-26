import { Aperture, Loader2 } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters';
import { useTimeTick } from '../../hooks/useTimeTick';
import { ENGINES, FLY_FPS, MAX_SAMPLES, photorealActionButton } from './photorealControls';

export function PhotorealEngineControls({
  running, engine, engineNote, samplesField, noGpuNotice, showEngineWarning, checkedEngine, onEngineChange, onOpenSetup,
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs text-gray-400">Engine</legend>
      <div className="flex flex-wrap gap-1.5">
        {ENGINES.map((e) => (
          <button key={e.id} type="button" aria-pressed={engine === e.id} onClick={() => onEngineChange(e.id)} disabled={running}
            className={`min-h-[40px] px-3 rounded-lg border text-sm ${engine === e.id ? 'border-port-accent text-white bg-port-accent/10' : 'border-port-border text-gray-300'}`}>
            {e.label}
          </button>
        ))}
        <label htmlFor="photoreal-samples" className="inline-flex items-center gap-1.5 text-xs text-gray-400">
          Samples
          <input id="photoreal-samples" type="number" min={1} max={MAX_SAMPLES} disabled={running} {...samplesField.inputProps}
            className="w-20 min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white" />
        </label>
      </div>
      <p className="text-[11px] text-gray-500">{engineNote}</p>
      {noGpuNotice && <p role="status" className="rounded border border-port-warning p-3 text-sm">{noGpuNotice}</p>}
      {showEngineWarning && <div className="space-y-2 rounded border border-port-warning p-3 text-sm">
        <p>Blender was checked with {checkedEngine === 'CYCLES' ? 'Cycles CPU' : 'EEVEE GPU'}; {engine === 'eevee' ? 'EEVEE GPU' : 'Cycles CPU'} has not been checked. To verify it, select that engine in Blender setup, save, and check it. This changes the Blender check for all PortOS uses.</p>
        <button type="button" className={photorealActionButton} onClick={onOpenSetup}>Open Blender setup</button>
      </div>}
    </fieldset>
  );
}

function Elapsed({ since }) {
  const now = useTimeTick(1000);
  return <span>{formatDurationSec(Math.max(0, Math.round((now - Date.parse(since)) / 1000)))}</span>;
}

function RenderProgress({ job }) {
  if (!job.startedAt) return null;
  const count = job.shotIds.length;

  return (
    <span className="text-xs text-gray-400" role="status">
      {job.engine === 'cycles' ? 'Cycles' : 'EEVEE'} · {job.flythroughSeconds
        ? `fly-through, ${job.flythroughSeconds}s (${job.flythroughSeconds * FLY_FPS} frames)`
        : `${count} camera${count === 1 ? '' : 's'}`} · <Elapsed since={job.startedAt} />
    </span>
  );
}

function RenderResult({ job }) {
  if (job?.state === 'canceled') return <span className="text-xs text-gray-400" role="status">Render canceled.</span>;
  if (job?.state === 'failed') return <span className="text-xs text-red-400" role="alert">{job.error}</span>;
  if (job?.state !== 'done' || !job.report) return null;

  const { backend, device, version } = job.report;
  const processor = device === 'GPU' ? `GPU${backend ? ` (${backend})` : ''}` : 'CPU';
  return <span className="text-xs text-gray-400" role="status">Last render: Blender {version} on {processor}</span>;
}

export function PhotorealRenderControls({ canRender, onRender, running, starting, count, job, onCancel, canCancel, canceling }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {onRender && (
        <button type="button" onClick={onRender} disabled={!canRender}
          className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg bg-port-accent px-4 text-sm font-medium text-white disabled:opacity-40">
          {running || starting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Aperture size={16} aria-hidden="true" />}
          {running ? 'Rendering…' : `Render ${count} camera${count === 1 ? '' : 's'}`}
        </button>
      )}
      {running && <RenderProgress job={job} />}
      {running && (
        <button type="button" className={photorealActionButton} disabled={!canCancel} onClick={onCancel}>
          {canceling ? 'Canceling render…' : 'Cancel render'}
        </button>
      )}
      <RenderResult job={job} />
    </div>
  );
}
