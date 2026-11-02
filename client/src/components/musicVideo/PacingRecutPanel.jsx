import { useState } from 'react';
import { useMounted } from '../../hooks/useMounted.js';
import { Scissors } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import { previewMusicVideoPacingRecut, recutMusicVideoToPacing } from '../../services/apiMusicVideo.js';
import { formatTimecode } from '../../utils/formatters.js';

const buttonClass = 'min-h-[44px] rounded border border-port-border px-2 py-1.5 text-sm disabled:opacity-40 sm:min-h-0';
const shots = (count) => `${count} shot${count === 1 ? '' : 's'}`;
const cutLabel = { lyric: 'lyric start', downbeat: 'downbeat', beat: 'beat', even: 'even cut' };

/** Server-authored cuts are shown before a revision-bound, single-write apply. */
export default function PacingRecutPanel({ project, disabled, onApplied }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const active = useMounted();
  const stale = preview && preview.updatedAt !== project.updatedAt;
  const readPreview = async () => {
    setOpen(true);
    setBusy(true);
    setPreview(null);
    setError(null);
    const next = await previewMusicVideoPacingRecut(project.id, { silent: true }).catch((err) => { setError(err.message); return null; });
    if (!active.current) return;
    setPreview(next);
    setBusy(false);
  };
  const apply = async () => {
    setBusy(true);
    setError(null);
    const saved = await recutMusicVideoToPacing(project.id, preview.revision, { silent: true }).catch((err) => { setError(err.message); setPreview(null); return null; });
    if (!active.current) return;
    setBusy(false);
    if (saved) { onApplied(saved.project); setOpen(false); setPreview(null); }
  };
  return <>
    <button type="button" disabled={disabled || busy || !project.scenes?.length} onClick={readPreview} className={`${buttonClass} inline-flex items-center gap-1`}>
      <Scissors size={15} aria-hidden="true" /> Re-cut to pacing
    </button>
    <Drawer open={open} onClose={() => { if (!busy) setOpen(false); }} title="Re-cut to pacing" size="md">
      <div className="space-y-3">
        <p className="text-sm text-port-text-muted">Preview cuts at lyric starts, downbeats and beats. Each first piece keeps its still and clip. New pieces keep the parent prompt and are marked “Needs its own beat”.</p>
        {busy && <p role="status" className="text-sm">{preview ? 'Applying cuts…' : 'Planning cuts…'}</p>}
        {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
        {stale && <p role="alert" className="text-sm text-port-warning">The project changed. Preview again before applying.</p>}
        {preview && <>
          <p className="text-sm">{shots(preview.total)} → {shots(preview.total + preview.added)} · {preview.minSec}–{preview.maxSec}s pacing</p>
          {!preview.added && <p className="text-sm">All timed shots already fit the pacing ceiling.</p>}
          <ol aria-label="Planned pacing cuts" className="space-y-2">
            {preview.changes.map((change) => <li key={change.sceneId} className="rounded border border-port-border p-2 text-sm">
              <strong>{change.label || 'Shot'}</strong>
              <ul className="mt-1 space-y-1 text-xs text-port-text-muted">
                {change.pieces.map((piece, i) => <li key={piece.startSec}>{formatTimecode(piece.startSec)}–{formatTimecode(piece.endSec)} · {(piece.endSec - piece.startSec).toFixed(2)}s{piece.cut ? ` · ${cutLabel[piece.cut]}` : ''}{i === 0 ? ' · keeps media' : ' · needs its own beat'}</li>)}
              </ul>
            </li>)}
          </ol>
          {preview.skipped.length > 0 && <p className="text-xs text-port-warning">Untimed shots left unchanged: {preview.skipped.map((scene) => scene.label || scene.sceneId).join(', ')}.</p>}
        </>}
        <div className="flex gap-2">
          <button type="button" onClick={readPreview} disabled={busy || disabled} className={buttonClass}>Preview again</button>
          <button type="button" onClick={apply} disabled={busy || disabled || !preview?.added || stale} className={`${buttonClass} bg-port-accent text-white`}>Apply cuts</button>
        </div>
      </div>
    </Drawer>
  </>;
}
