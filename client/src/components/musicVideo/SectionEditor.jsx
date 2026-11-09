import { useEffect, useState } from 'react';
import toast from '../ui/Toast';
import { setMusicVideoSections, setMusicVideoSectionsFromLyrics } from '../../services/apiMusicVideo.js';

const MIN_SEC = 0.5;
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Split / merge / move / rename the song's sections. Each row owns its end
 * time; a row starts where the previous one ends, so the map stays gapless.
 * `onUpdated(project)` receives the persisted project.
 */
export default function SectionEditor({ projectId, sections, durationSec, onUpdated }) {
  const [rows, setRows] = useState(() => sections.map((s) => ({ label: s.label, endSec: s.endSec })));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRows(sections.map((s) => ({ label: s.label, endSec: s.endSec }))); }, [sections]);

  const starts = rows.map((_, i) => (i === 0 ? 0 : rows[i - 1].endSec));
  const patch = (i, change) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...change } : row)));
  const split = (i) => setRows((r) => {
    const mid = round((starts[i] + r[i].endSec) / 2);
    return [...r.slice(0, i), { label: r[i].label, endSec: mid }, { label: `${r[i].label} 2`, endSec: r[i].endSec }, ...r.slice(i + 1)];
  });
  const merge = (i) => setRows((r) => [...r.slice(0, i), { label: r[i].label, endSec: r[i + 1].endSec }, ...r.slice(i + 2)]);
  const valid = rows.every((row, i) => row.label.trim() && row.endSec - starts[i] >= MIN_SEC)
    && Math.abs(rows[rows.length - 1].endSec - durationSec) <= 0.05;

  const run = (call, okMessage) => {
    setBusy(true);
    call.then((project) => { onUpdated?.(project); toast.success(okMessage); })
      .catch((err) => toast.error(err?.message || 'Could not update sections'))
      .finally(() => setBusy(false));
  };
  const save = () => run(setMusicVideoSections(projectId, rows.map((row, i) => ({ label: row.label.trim(), startSec: starts[i], endSec: row.endSec })), { silent: true }), 'Sections saved');
  const fromLyrics = () => run(setMusicVideoSectionsFromLyrics(projectId, { silent: true }), 'Sections set from the lyric sheet');
  const btn = 'bg-port-card border border-port-border rounded px-2 py-1 min-h-[32px] hover:bg-port-border/40 disabled:opacity-50';

  return (
    <details data-testid="section-editor" className="mt-2 text-xs bg-port-bg border border-port-border rounded-lg p-2">
      <summary className="cursor-pointer text-port-text-muted">Edit sections ({rows.length})</summary>
      <ul className="mt-2 space-y-1">
        {rows.map((row, i) => (
          <li key={i} className="flex flex-wrap items-center gap-1">
            <input aria-label={`Section ${i + 1} name`} value={row.label} onChange={(e) => patch(i, { label: e.target.value })}
              className="w-32 bg-port-card border border-port-border rounded px-1.5 py-1" />
            <span className="text-port-text-muted">{starts[i].toFixed(1)}s →</span>
            <input aria-label={`Section ${i + 1} end (s)`} type="number" step={0.1} min={0} value={row.endSec}
              disabled={i === rows.length - 1} onChange={(e) => patch(i, { endSec: Number(e.target.value) })}
              className="w-20 bg-port-card border border-port-border rounded px-1.5 py-1 disabled:opacity-60" />
            <button type="button" className={btn} onClick={() => split(i)} disabled={row.endSec - starts[i] < MIN_SEC * 2}>Split</button>
            <button type="button" className={btn} onClick={() => merge(i)} disabled={i === rows.length - 1}>Merge next</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="bg-port-accent text-white rounded px-2 py-1.5 min-h-[32px] disabled:opacity-50" onClick={save} disabled={busy || !valid}>
          {busy ? 'Saving…' : 'Save sections'}
        </button>
        <button type="button" className={btn} onClick={fromLyrics} disabled={busy}>Use lyric sections</button>
      </div>
    </details>
  );
}
