import { useState } from 'react';
import { Mic, Wand2, X } from 'lucide-react';
import toast from '../ui/Toast';
import { uploadMusicVideoVocalStem, removeMusicVideoVocalStem, updateMusicVideoProject } from '../../services/apiMusicVideo.js';

const HELP = 'Optional. A full-length vocal bounce from the same session as the song, starting at 0:00. '
  + 'Lip-sync performance shots are conditioned on it instead of the full mix. The final video keeps the song.';

const SEPARATE_HELP = 'Split the vocal out of the song with demucs and attach it as the stem. '
  + 'The first run installs demucs (a few minutes); after that a song takes seconds on Apple Silicon or an NVIDIA GPU.';

/**
 * Attach, replace or remove the project's vocal stem (#8977), or separate one
 * from the song (`separation`, a useMusicVideoVocalSeparation slot). The server
 * refuses a stem whose length does not match the song, since its timing would
 * not line up; the error toast says why.
 */
export default function VocalStemControl({ project, hasAudio, onUpdated, separation = null }) {
  const [busy, setBusy] = useState(false);
  const inputId = `mv-vocal-stem-${project.id}`;
  const sourceId = `mv-conditioning-source-${project.id}`;
  const source = project.performanceConditioningSource || (project.vocalStemFilename ? 'vocal-stem' : 'master');
  const stem = project.vocalStemFilename || null;
  const separating = Boolean(separation?.active && separation.context === project.id);
  const separationLabel = separating
    ? `${separation.stageLabel || 'Separating vocals…'}${separation.stage === 'separating' && separation.percent ? ` ${separation.percent}%` : ''}`
    : 'Separate vocals';

  const run = (call, success, failure) => {
    setBusy(true);
    call()
      .then((updated) => {
        onUpdated(updated);
        toast.success(success);
      })
      .catch((err) => toast.error(err?.message || failure))
      .finally(() => setBusy(false));
  };

  const upload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    run(() => uploadMusicVideoVocalStem(project.id, file, { silent: true }), 'Vocal stem attached', 'Failed to attach the vocal stem');
  };
  const remove = () => run(() => removeMusicVideoVocalStem(project.id, { silent: true }), 'Vocal stem removed', 'Failed to remove the vocal stem');

  const disabled = busy || !hasAudio || separating;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" title={hasAudio ? HELP : 'Link a track first'}>
      <input id={inputId} type="file" accept="audio/*" className="sr-only" onChange={upload} disabled={disabled} />
      <label htmlFor={inputId}
        className={`flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1 min-h-[44px] sm:min-h-0 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-port-border/40'}`}>
        <Mic size={13} /> {busy ? 'Working…' : stem ? 'Replace vocal stem' : 'Add vocal stem'}
      </label>
      {separation && (
        <button type="button" onClick={() => separation.start(project.id)} disabled={busy || !hasAudio || separation.active}
          title={hasAudio ? SEPARATE_HELP : 'Link a track first'} aria-live="polite"
          className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1 min-h-[44px] sm:min-h-0 disabled:opacity-50">
          <Wand2 size={13} /> {separationLabel}
        </button>
      )}
      {separating && separation.jobId && (
        <button type="button" onClick={separation.cancel}
          className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1 min-h-[44px] sm:min-h-0">
          Cancel
        </button>
      )}
      <label htmlFor={sourceId}>Conditioning source</label>
      <select id={sourceId} value={source} disabled={disabled}
        onChange={(e) => run(() => updateMusicVideoProject(project.id, { performanceConditioningSource: e.target.value }, { silent: true }), 'Conditioning source saved', 'Failed to save conditioning source')}
        className="max-w-full bg-port-bg border border-port-border rounded px-2 py-1 min-h-[44px] sm:min-h-0">
        <option value="master">Master mix</option>
        <option value="vocal-stem" disabled={!stem}>Attached vocal stem</option>
        <option value="clean-singer-stem" disabled={!stem}>Attached clean singer stem (user selected)</option>
      </select>
      <span className="text-port-text-muted">Choose a clean singer bounce explicitly. Separation, source selection and duration parity do not verify voice isolation.</span>
      {stem ? (
        <>
          <span className="text-port-text-muted break-all">{source === 'master' ? 'Lip-sync uses the full mix' : `Lip-sync uses ${stem}`}</span>
          <button type="button" onClick={remove} disabled={busy || separating} aria-label="Remove vocal stem"
            className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1 min-h-[44px] sm:min-h-0 disabled:opacity-50">
            <X size={13} /> Remove
          </button>
        </>
      ) : (
        <span className="text-port-text-muted">Lip-sync uses the full mix</span>
      )}
    </div>
  );
}
