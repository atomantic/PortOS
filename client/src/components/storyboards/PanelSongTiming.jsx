import { useEffect, useState } from 'react';
import { STORYBOARD_LIMITS } from '../../../../server/lib/storyboardVocabulary.js';
import { formatTimecode } from '../../utils/formatters';

const labelClass = 'block text-[11px] text-gray-500 mb-0.5';
const inputClass = 'w-full min-h-[44px] bg-port-bg border border-port-border rounded px-2 text-sm text-white tabular-nums';
const round = (t) => Math.round(t * 100) / 100;
// How far past the panel's start the "end on a sung line" picker looks.
const LINE_PICK_WINDOW_SEC = 30;

/** A number field that saves on blur or Enter; an out-of-range entry reverts. */
function SecondsField({ id, label, value, min, max, onCommit }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  const commit = () => {
    const next = Number(String(draft).trim());
    if (String(draft).trim() === '' || !Number.isFinite(next) || next < min || next > max) {
      setDraft(value ?? '');
      return;
    }
    if (round(next) !== value) onCommit(round(next));
  };
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelClass}>{label}</label>
      <input id={id} type="number" inputMode="decimal" step="0.01" min={min} max={max} value={draft}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} className={inputClass} />
    </div>
  );
}

/**
 * A music video panel's timing (lib/storyboardShotSync.js): when it plays on
 * the song and the line sung over it. Its length is the panel's `seconds`;
 * setting its end (by hand or on a sung line) sets that length, and every
 * later panel moves with it. A panel before the song has only its length.
 */
export default function PanelSongTiming({ panel, span, lyricCues = [], onPatch }) {
  const fieldId = (name) => `panel-${panel.id}-song-${name}`;
  const max = STORYBOARD_LIMITS.panelSecondsMax;
  const setLength = (seconds) => onPatch({ seconds });
  if (span.beforeSong) {
    return (
      <section aria-label="Timing" className="space-y-2 rounded-lg border border-port-border p-2">
        <SecondsField id={fieldId('length')} label="Seconds before the song" value={panel.seconds ?? null} min={0.5} max={max} onCommit={setLength} />
        {span.estimated && <p className="text-[11px] text-gray-500">No length yet: it holds {formatTimecode(span.durationSec)}.</p>}
      </section>
    );
  }
  const lines = lyricCues.filter((cue) => cue.startSec > span.startSec + 0.05 && cue.startSec <= span.startSec + LINE_PICK_WINDOW_SEC);
  return (
    <section aria-label="Timing" className="space-y-2 rounded-lg border border-port-border p-2">
      <div className="grid grid-cols-3 gap-2">
        <div className="min-w-0">
          <span className={labelClass}>Starts</span>
          <p className="min-h-[44px] flex items-center text-sm text-gray-300 tabular-nums">{formatTimecode(span.startSec)}</p>
        </div>
        <SecondsField id={fieldId('length')} label="Seconds" value={panel.seconds ?? null} min={0.01} max={max} onCommit={setLength} />
        <SecondsField id={fieldId('end')} label="Ends" value={span.endSec} min={round(span.startSec + 0.01)} max={round(span.startSec + max)}
          onCommit={(end) => setLength(round(end - span.startSec))} />
      </div>
      {lines.length > 0 && (
        <div>
          <label htmlFor={fieldId('line')} className={labelClass}>End where a line starts</label>
          <select id={fieldId('line')} value="" onChange={(event) => event.target.value && setLength(round(Number(event.target.value) - span.startSec))}
            className="w-full min-h-[44px] bg-port-bg border border-port-border rounded px-2 text-sm text-white">
            <option value="">Pick a sung line…</option>
            {lines.map((cue) => <option key={cue.id || cue.startSec} value={cue.startSec}>{formatTimecode(cue.startSec)} · {cue.text}</option>)}
          </select>
        </div>
      )}
      <div>
        <span className={labelClass}>Sung over this panel</span>
        <p className={`text-sm ${span.lyricText ? 'text-gray-200 italic' : 'text-gray-500'}`}>{span.lyricText || 'No sung line'}</p>
      </div>
      {span.estimated && <p className="text-[11px] text-gray-500">No length yet: it holds {formatTimecode(span.durationSec)} until you set one.</p>}
      {span.pastSong && <p className="text-[11px] text-port-warning">This panel runs past the end of the song.</p>}
    </section>
  );
}
