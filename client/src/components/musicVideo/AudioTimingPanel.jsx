import { useRef, useState } from 'react';
import { previewMusicVideoAudioTiming, applyMusicVideoAudioTiming } from '../../services/apiMusicVideo.js';
import { formatCount } from '../../utils/formatters.js';

const seconds = (value) => value == null ? '—' : `${Number(value).toFixed(2)}s`;

/** Draft lives only in this keyed panel. Cancel never mutates the project. */
export default function AudioTimingPanel({ project, tracks, onApplied, disabled }) {
  const [open, setOpen] = useState(false);
  const [targetTrackId, setTargetTrackId] = useState('');
  const [intervals, setIntervals] = useState([{ oldStartSec: 0, oldEndSec: project.audioAnalysis?.durationSec || 1, newStartSec: 0 }]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const change = (fn) => { generation.current++; setPreview(null); setError(''); fn(); };
  const cancel = () => change(() => { setOpen(false); });
  const inspect = () => {
    const token = ++generation.current;
    setBusy(true); setError('');
    previewMusicVideoAudioTiming(project.id, { targetTrackId, intervals }, { silent: true })
      .then((result) => { if (generation.current === token) setPreview(result); })
      .catch((err) => { if (generation.current === token) setError(err.message); })
      .finally(() => setBusy(false));
  };
  const apply = () => {
    setBusy(true); setError('');
    applyMusicVideoAudioTiming(project.id, { targetTrackId, intervals, basis: preview.basis }, { silent: true })
      .then(({ project: updated }) => { onApplied(updated); setPreview(null); setOpen(false); })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  };
  if (!open) return <button disabled={disabled} onClick={() => setOpen(true)} className="min-h-[44px] text-sm text-port-accent">Preview audio timing revision</button>;
  return (
    <section aria-label="Audio timing revision" className="min-w-0 space-y-3 rounded-lg border border-port-border bg-port-card p-3">
      <h3 className="font-medium">Preview audio timing revision</h3>
      <p className="text-xs text-port-text-muted">Choose a separate edited track and list preserved intervals in seconds. Gaps describe inserted or deleted audio. Each interval keeps its duration. Cancel leaves timing unchanged.</p>
      <fieldset disabled={busy || disabled} className="space-y-3">
        <label htmlFor="audio-timing-track" className="block text-sm">Edited track</label>
        <select id="audio-timing-track" value={targetTrackId} onChange={(event) => change(() => setTargetTrackId(event.target.value))} className="w-full rounded border border-port-border bg-port-bg p-2">
          <option value="">Choose a library track</option>
          {(tracks || []).filter((track) => track.audioFilename && track.id !== project.trackId).map((track) => <option key={track.id} value={track.id}>{track.title || track.id}</option>)}
        </select>
        {intervals.map((row, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2">
            {[['oldStartSec', 'Old start'], ['oldEndSec', 'Old end'], ['newStartSec', 'New start']].map(([key, label]) => (
              <div key={key} className="min-w-0 flex-1">
                <label htmlFor={`timing-${index}-${key}`} className="block text-xs">{label} {formatCount(index + 1)}</label>
                <input id={`timing-${index}-${key}`} type="number" min="0" step="0.01" value={row[key]} onChange={(event) => change(() => setIntervals((current) => current.map((entry, i) => i === index ? { ...entry, [key]: Number(event.target.value) } : entry)))} className="w-full rounded border border-port-border bg-port-bg p-2" />
              </div>
            ))}
            <button disabled={intervals.length === 1} onClick={() => change(() => setIntervals((current) => current.filter((_, i) => i !== index)))} className="min-h-[44px] text-sm">Remove interval {formatCount(index + 1)}</button>
          </div>
        ))}
        <div className="flex flex-wrap gap-3">
          <button disabled={intervals.length >= 200} onClick={() => change(() => setIntervals((current) => [...current, { oldStartSec: current.at(-1).oldEndSec, oldEndSec: current.at(-1).oldEndSec + 1, newStartSec: current.at(-1).newStartSec + current.at(-1).oldEndSec - current.at(-1).oldStartSec }]))} className="min-h-[44px] text-sm">Add preserved interval</button>
          <button disabled={!targetTrackId} onClick={inspect} className="min-h-[44px] text-sm text-port-accent">Preview mapping</button>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
      {preview && <div aria-label="Timing map preview" className="space-y-2 text-sm">
        {[...preview.intervals, ...preview.gaps].map((row, index) => <p key={index}>{row.status}: {seconds(row.oldStartSec)}–{seconds(row.oldEndSec)} → {seconds(row.newStartSec)}–{seconds(row.newEndSec)}</p>)}
        {preview.affectedShots.map((shot) => <div key={shot.sceneId} className="rounded border border-port-border p-2">
          <p>{shot.label || shot.sceneId}: {shot.status} · {seconds(shot.oldStartSec)}–{seconds(shot.oldEndSec)} → {seconds(shot.newStartSec)}–{seconds(shot.newEndSec)}</p>
          <p className="text-xs text-port-text-muted">{formatCount(shot.takeIds.length)} historical takes retained{shot.repairRequired ? ' · performance repair required' : ''}{shot.reason ? ` · ${shot.reason}` : ''}</p>
        </div>)}
        <p>Rebuild estimate: {formatCount(preview.estimate.minGenerations)}–{formatCount(preview.estimate.maxGenerations)} shot repairs, up to {seconds(preview.estimate.maxSeconds)}. Price depends on the selected repair backend. Apply starts no generation.</p>
        {preview.blockers.map((blocker, index) => <p key={index} role="alert">{blocker}</p>)}
        <button disabled={!preview.canApply || busy || disabled} onClick={apply} className="min-h-[44px] rounded bg-port-accent px-3 text-white">Apply timing revision</button>
      </div>}
      <button disabled={busy} onClick={cancel} className="min-h-[44px] text-sm">Cancel timing revision</button>
    </section>
  );
}
