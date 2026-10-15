import { useEffect, useState } from 'react';
import { Play, RotateCcw, Scissors, Square, X } from 'lucide-react';
import FilmLookFrame from '../media/FilmLookFrame.jsx';
import StatsOutroCanvas from './StatsOutroCanvas.jsx';
import StatsOutroPanel from './StatsOutroPanel.jsx';
import useMusicVideoStatsOutro from '../../hooks/useMusicVideoStatsOutro.js';
import { getMusicVideoOutroStats } from '../../services/apiMusicVideo.js';
import { formatCount } from '../../utils/formatters.js';
import { STATS_OUTRO_DEFAULTS, normalizeStatsOutro, statsOutroRows } from '../../../../server/lib/musicVideoStatsOutro.js';

const PREVIEW_FPS = 24;

/** The ending's length: its own when on, else the length it would get when turned on. */
const endingSeconds = (project) => normalizeStatsOutro(project.statsOutro)?.durationSec ?? STATS_OUTRO_DEFAULTS.durationSec;

// The frame a still of the ending shows: every count landed, before it fades out.
const posterTime = (seconds) => Math.max(0, seconds - 1);

/**
 * The project's cutting room floor tally while the Ending card is open,
 * fetched each time it opens so it counts the latest choices. Null while it
 * loads or when it cannot be read.
 */
function useEndingStats(projectId) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let active = true;
    getMusicVideoOutroStats(projectId, { silent: true })
      .then((next) => { if (active) setStats(next?.stats || null); })
      .catch(() => {});
    return () => { active = false; };
  }, [projectId]);
  return stats;
}

/** The Ending's thumbnail after the last shot on the board: its run time after the song, or Off. */
export function EndingThumbnail({ project, open, onOpen }) {
  const outro = normalizeStatsOutro(project.statsOutro);
  const seconds = endingSeconds(project);
  return (
    <button type="button" aria-pressed={open} onClick={onOpen} aria-label="Open the ending: cutting room floor"
      className={`min-w-0 rounded border p-2 text-left ${open ? 'border-port-accent bg-port-accent/10' : 'border-dashed border-port-border bg-port-card'}`}>
      <span className={`flex aspect-video w-full flex-col items-center justify-center gap-1 rounded bg-black text-[#e8c27a] ${outro?.enabled ? '' : 'opacity-50'}`}>
        <Scissors size={20} aria-hidden="true" />
        <span className="px-1 text-center font-mono text-[10px] uppercase tracking-wider">The cutting room floor</span>
      </span>
      <span className="mt-1 block truncate text-sm">Ending · Cutting room floor</span>
      <span className="block text-xs text-port-text-muted">
        {outro?.enabled
          ? <><span className="font-medium text-port-text">{seconds.toFixed(2)}s · </span>after the song</>
          : 'Off'}
      </span>
    </button>
  );
}

/**
 * The open Ending on the board: a preview of the scene (with the project's
 * film look, as the render grades it), its on/off and length, and the counts
 * it shows. The counts and the floor's stills come from the project itself.
 */
export default function EndingCard({ project, onEditLocal, onSave, onClose }) {
  const seconds = endingSeconds(project);
  const stats = useEndingStats(project.id);
  const preview = useMusicVideoStatsOutro({ projectId: project.id, seconds });
  const shown = preview.stats || stats;
  const t = preview.active ? preview.t : posterTime(seconds);
  const running = preview.active && preview.t < seconds;
  const rows = shown ? statsOutroRows(shown) : [];
  return (
    <section aria-label="Ending: cutting room floor" className="space-y-2 rounded-lg border border-port-accent bg-port-card p-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Scissors size={14} className="shrink-0 text-port-accent" aria-hidden="true" />
          <span className="truncate">Ending · Cutting room floor</span>
        </h3>
        <button type="button" onClick={onClose} aria-label="Close the ending"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-port-text-muted sm:min-h-0 sm:min-w-0 sm:p-1">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-3 @2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-1.5">
          <figure className="relative aspect-video w-full overflow-hidden rounded border border-port-border bg-black">
            <FilmLookFrame look={project.filmLook} frame={Math.round(t * PREVIEW_FPS)} playing={running} className="h-full w-full">
              <StatsOutroCanvas stats={shown} t={t} durationSec={seconds} />
            </FilmLookFrame>
          </figure>
          <button type="button" onClick={running ? preview.stop : preview.start}
            className="flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-xs sm:min-h-0 sm:py-1">
            {running ? <><Square size={14} aria-hidden="true" /> Stop</>
              : preview.active ? <><RotateCcw size={14} aria-hidden="true" /> Replay</>
                : <><Play size={14} aria-hidden="true" /> Play {seconds}s</>}
          </button>
        </div>
        <div className="min-w-0 space-y-2">
          <StatsOutroPanel project={project} onEditLocal={onEditLocal} onSave={onSave} />
          {rows.length > 0 && (
            <dl aria-label="What the ending counts" className="space-y-0.5 text-xs">
              {rows.map((row) => (
                <div key={row.label} className={`flex justify-between gap-2 ${row.accent ? 'font-medium text-port-accent' : ''}`}>
                  <dt className="min-w-0 truncate">{row.label}</dt>
                  <dd className="tabular-nums">{formatCount(row.value, { fallback: '0' })}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="text-xs text-port-text-muted">Counted from your shots, takes, ✕ marks and this video&apos;s collection. Unused stills fill the floor.</p>
        </div>
      </div>
    </section>
  );
}
