import { useState } from 'react';
import { Mic, X } from 'lucide-react';
import toast from '../ui/Toast';
import { uploadMusicVideoVocalStem, removeMusicVideoVocalStem } from '../../services/apiMusicVideo.js';

const HELP = 'Optional. A full-length vocal bounce from the same session as the song, starting at 0:00. '
  + 'Lip-sync performance shots are conditioned on it instead of the full mix. The final video keeps the song.';

/**
 * Attach, replace or remove the project's vocal stem (#8977). The server
 * refuses a stem whose length does not match the song, since its timing would
 * not line up; the error toast says why.
 */
export default function VocalStemControl({ project, hasAudio, onUpdated }) {
  const [busy, setBusy] = useState(false);
  const inputId = `mv-vocal-stem-${project.id}`;
  const stem = project.vocalStemFilename || null;

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

  const disabled = busy || !hasAudio;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" title={hasAudio ? HELP : 'Link a track first'}>
      <input id={inputId} type="file" accept="audio/*" className="sr-only" onChange={upload} disabled={disabled} />
      <label htmlFor={inputId}
        className={`flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1 min-h-[44px] sm:min-h-0 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-port-border/40'}`}>
        <Mic size={13} /> {busy ? 'Working…' : stem ? 'Replace vocal stem' : 'Add vocal stem'}
      </label>
      {stem ? (
        <>
          <span className="text-port-text-muted break-all">Lip-sync uses {stem}</span>
          <button type="button" onClick={remove} disabled={busy} aria-label="Remove vocal stem"
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
