import { useSearchParams } from 'react-router';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import ScenePoster from './ScenePoster.jsx';
import { planShotRows } from '../../lib/musicVideoStages.js';
import { musicVideoImageSrc, scenePosterSrc } from '../../lib/musicVideoPreview.js';
import { formatTimecode } from '../../utils/formatters.js';

const FILTERS = [['all', 'All'], ['fix', 'Needs a fix']];

/**
 * Plan's timing check: every shot in song order, read rather than watched —
 * its start and length, its storyboard panel (else its frame), the lyric it was
 * planned on, its action and camera, and each storyboard problem on its own
 * row. A row opens that shot on Shots, where it is fixed and made. `?shots=fix`
 * narrows the list to the shots with a problem.
 */
export default function PlanShotList({ project, readiness, onOpenShot }) {
  const rows = planShotRows(project, readiness);
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get('shots') === 'fix' ? 'fix' : 'all';
  const setFilter = (next) => setSearchParams((prev) => {
    const params = new URLSearchParams(prev);
    if (next === 'all') params.delete('shots'); else params.set('shots', next);
    return params;
  }, { replace: true });
  const flagged = rows.filter((row) => row.flags.length > 0);
  const listed = filter === 'fix' ? flagged : rows;
  const counts = { all: rows.length, fix: flagged.length };
  const songSec = project.audioAnalysis?.durationSec;
  const covered = !(readiness?.storyboard?.coverage?.length);

  if (!rows.length) return <p className="text-sm text-port-text-muted">No shots yet. Run AI Plan under Planning tools, or fit a storyboard to the song.</p>;
  return (
    <section aria-label="Shot list" className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className={`rounded-full border px-2 py-0.5 ${covered ? 'border-port-success text-port-success' : 'border-port-warning text-port-warning'}`}>
          {rows.length} shot{rows.length === 1 ? '' : 's'}{Number.isFinite(songSec) ? (covered ? ` cover ${formatTimecode(songSec)}` : ` · gaps in ${formatTimecode(songSec)}`) : ''}
        </span>
        {flagged.length > 0
          ? <span className="rounded-full border border-port-warning px-2 py-0.5 text-port-warning">{flagged.length} need{flagged.length === 1 ? 's' : ''} a fix</span>
          : <span className="rounded-full border border-port-success px-2 py-0.5 text-port-success">Timing checks out</span>}
        {project.storyboardId && <span className="rounded-full border border-port-border px-2 py-0.5 text-port-text-muted">Storyboard linked</span>}
      </div>
      {flagged.length > 0 && (
        <div role="group" aria-label="Filter shots" className="flex flex-wrap gap-1.5 text-xs">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}
              className={`min-h-[44px] rounded border px-2 py-1 sm:min-h-0 ${filter === id ? 'border-port-accent bg-port-accent/10 text-port-accent' : 'border-port-border text-port-text-muted'}`}>
              {label} ({counts[id]})
            </button>
          ))}
        </div>
      )}
      <ol className="min-w-0 space-y-1.5">
        {listed.map(({ scene, number, lyric, action, camera, flags }) => (
          <li key={scene.sceneId}>
            <button type="button" onClick={() => onOpenShot(scene.sceneId)} aria-label={`Open Shot ${number} on Shots`}
              className={`grid w-full min-w-0 grid-cols-[3.75rem_4.5rem_minmax(0,1fr)_1rem] items-center gap-2 rounded border p-1.5 text-left ${flags.length ? 'border-port-warning bg-port-warning/5' : 'border-port-border bg-port-card'}`}>
              <span className="text-xs tabular-nums text-port-text-muted">
                <span className="block font-medium text-port-text">{formatTimecode(scene.startSec)}</span>
                {Number.isFinite(scene.endSec) && <span className="block">{(scene.endSec - scene.startSec).toFixed(2)}s</span>}
              </span>
              <ScenePoster scene={scene} src={musicVideoImageSrc(scene.panelArt) || scenePosterSrc(scene)} className="aspect-video w-full rounded" iconSize={16} />
              <span className="min-w-0">
                <span className={`block truncate text-sm ${lyric ? 'italic text-port-text' : 'text-port-text-muted'}`}>{lyric ? `“${lyric}”` : 'Instrumental'}</span>
                <span className="block truncate text-xs text-port-text-muted">{[`Shot ${number}`, camera, action].filter(Boolean).join(' · ')}</span>
                {flags.map((text) => (
                  <span key={text} className="flex items-start gap-1 text-xs text-port-warning"><AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />{text}</span>
                ))}
              </span>
              <ChevronRight size={16} aria-hidden="true" className="text-port-text-muted" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
