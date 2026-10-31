import { useSearchParams } from 'react-router';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import ScenePoster from './ScenePoster.jsx';
import { planShotRows } from '../../lib/musicVideoStages.js';
import { musicVideoImageSrc, scenePosterSrc } from '../../lib/musicVideoPreview.js';
import { formatTimecode } from '../../utils/formatters.js';
import { preMusicSoundSummary } from '../../../../server/lib/musicVideoColdOpen.js';

const FILTERS = [['all', 'All'], ['fix', 'Needs a fix']];

/**
 * The timing check on Shots: every shot in song order, read rather than watched —
 * its start and length, its storyboard panel (else its frame), the lyric it was
 * planned on, its action and camera, and each storyboard problem on its own
 * row; untimed shots follow, unnumbered. A row opens that shot's card, where
 * it is fixed and made. Shots before the song (the cold open) lead the list with
 * their length and sound. `?shots=fix` narrows the list to the shots with a problem.
 */
export default function PlanShotList({ project, readiness, onOpenShot }) {
  const rows = planShotRows(project, readiness);
  const [searchParams, setSearchParams] = useSearchParams();

  const setFilter = (next) => setSearchParams((prev) => {
    const params = new URLSearchParams(prev);
    if (next === 'all') params.delete('shots'); else params.set('shots', next);
    return params;
  }, { replace: true });
  const flagged = rows.filter((row) => row.flags.length > 0);
  const songRows = rows.filter((row) => !row.coldOpen);
  // With nothing left to fix the filter controls are gone, so a lingering ?shots=fix shows every shot.
  const filter = searchParams.get('shots') === 'fix' && flagged.length > 0 ? 'fix' : 'all';
  const listed = filter === 'fix' ? flagged : rows;
  const counts = { all: rows.length, fix: flagged.length };
  const songSec = project.audioAnalysis?.durationSec;
  const covered = !(readiness?.storyboard?.coverage?.length);

  if (!rows.length) return <p className="text-sm text-port-text-muted">No shots yet. Make them from the storyboard, or run AI Plan below.</p>;
  return (
    <section aria-label="Shot list" className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className={`rounded-full border px-2 py-0.5 ${covered ? 'border-port-success text-port-success' : 'border-port-warning text-port-warning'}`}>
          {songRows.length} shot{songRows.length === 1 ? '' : 's'}{Number.isFinite(songSec) ? (covered ? ` cover ${formatTimecode(songSec)}` : ` · gaps in ${formatTimecode(songSec)}`) : ''}
        </span>
        {flagged.length > 0
          ? <span className="rounded-full border border-port-warning px-2 py-0.5 text-port-warning">{flagged.length} need{flagged.length === 1 ? 's' : ''} a fix</span>
          : <span className="rounded-full border border-port-success px-2 py-0.5 text-port-success">Timing checks out</span>}
        {rows.length > songRows.length && (
          <span className="rounded-full border border-port-accent px-2 py-0.5 text-port-accent">
            {formatTimecode(rows.reduce((sum, row) => sum + (row.durationSec || 0), 0))} before the song
          </span>
        )}
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
        {listed.map(({ scene, number, coldOpen, durationSec, lyric, action, camera, flags }) => (
          <li key={scene.sceneId}>
            <button type="button" onClick={() => onOpenShot(scene.sceneId)} aria-label={`Edit ${coldOpen ? `cold open shot ${coldOpen}` : number ? `Shot ${number}` : `untimed shot ${scene.label || scene.sceneId}`}`}
              className={`grid w-full min-w-0 grid-cols-[3.75rem_4.5rem_minmax(0,1fr)_1rem] items-center gap-2 rounded border p-1.5 text-left ${flags.length ? 'border-port-warning bg-port-warning/5' : 'border-port-border bg-port-card'}`}>
              <span className="text-xs tabular-nums text-port-text-muted">
                <span className="block font-medium text-port-text">{coldOpen ? 'Before song' : number ? formatTimecode(scene.startSec) : 'Untimed'}</span>
                {coldOpen ? <span className="block">{durationSec.toFixed(2)}s</span>
                  : number && Number.isFinite(scene.endSec) && <span className="block">{(scene.endSec - scene.startSec).toFixed(2)}s</span>}
              </span>
              <ScenePoster scene={scene} src={musicVideoImageSrc(scene.panelArt) || scenePosterSrc(scene)} className="aspect-video w-full rounded" iconSize={16} />
              <span className="min-w-0">
                <span className={`block truncate text-sm ${lyric && !coldOpen ? 'italic text-port-text' : 'text-port-text-muted'}`}>{coldOpen ? preMusicSoundSummary(scene.preMusic) : lyric ? `“${lyric}”` : 'Instrumental'}</span>
                <span className="block truncate text-xs text-port-text-muted">{[coldOpen ? `Cold open ${coldOpen}` : number ? `Shot ${number}` : scene.label, camera, action].filter(Boolean).join(' · ')}</span>
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
