import { useMemo } from 'react';
import { Clapperboard, Play, RotateCcw, Square, X } from 'lucide-react';
import FilmLookFrame from '../media/FilmLookFrame.jsx';
import CreditsOutroCanvas from './CreditsOutroCanvas.jsx';
import CreditsOutroPanel from './CreditsOutroPanel.jsx';
import useMusicVideoStatsOutro from '../../hooks/useMusicVideoStatsOutro.js';
import { CREDITS_OUTRO_DEFAULTS, normalizeCreditsOutro } from '../../../../server/lib/musicVideoCreditsOutro.js';

const PREVIEW_FPS = 24;

/** The credits as they show: their own record, else the defaults they get when turned on. */
const creditsLook = (project) => normalizeCreditsOutro(project.creditsOutro || CREDITS_OUTRO_DEFAULTS);

// A still shows the held card (or the roll's middle) once it has faded in.
const posterTime = (seconds) => seconds / 2;

/** The credits' thumbnail after the cutting room floor on the board: their run time, or Off. */
export function CreditsThumbnail({ project, open, onOpen }) {
  const credits = normalizeCreditsOutro(project.creditsOutro);
  return (
    <button type="button" aria-pressed={open} onClick={onOpen} aria-label="Open the ending: credits"
      className={`min-w-0 rounded border p-2 text-left ${open ? 'border-port-accent bg-port-accent/10' : 'border-dashed border-port-border bg-port-card'}`}>
      <span className={`flex aspect-video w-full flex-col items-center justify-center gap-1 rounded bg-black text-[#f4efe6] ${credits?.enabled ? '' : 'opacity-50'}`}>
        <Clapperboard size={20} aria-hidden="true" />
        <span className="px-1 text-center font-serif text-[10px] uppercase tracking-[0.2em]">Credits</span>
      </span>
      <span className="mt-1 block truncate text-sm">Ending · Credits</span>
      <span className="block text-xs text-port-text-muted">
        {credits?.enabled
          ? <><span className="font-medium text-port-text">{credits.durationSec.toFixed(2)}s · </span>after the song</>
          : 'Off'}
      </span>
    </button>
  );
}

/**
 * The open credits on the board: a preview of the page (with the project's
 * film look, as the render grades it) beside its editor.
 */
export default function CreditsEndingCard({ project, onEditLocal, onSave, onClose }) {
  const credits = useMemo(() => creditsLook(project), [project]);
  const seconds = credits.durationSec;
  const preview = useMusicVideoStatsOutro({ projectId: project.id, seconds });
  const t = preview.active ? preview.t : posterTime(seconds);
  const running = preview.active && preview.t < seconds;
  return (
    <section aria-label="Ending: credits" className="space-y-2 rounded-lg border border-port-accent bg-port-card p-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Clapperboard size={14} className="shrink-0 text-port-accent" aria-hidden="true" />
          <span className="truncate">Ending · Credits</span>
        </h3>
        <button type="button" onClick={onClose} aria-label="Close the credits"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-port-text-muted sm:min-h-0 sm:min-w-0 sm:p-1">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-3 @2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-1.5">
          <figure className="relative aspect-video w-full overflow-hidden rounded border border-port-border bg-black">
            <FilmLookFrame look={project.filmLook} frame={Math.round(t * PREVIEW_FPS)} playing={running} className="h-full w-full">
              <CreditsOutroCanvas credits={credits} t={t} durationSec={seconds} />
            </FilmLookFrame>
          </figure>
          <button type="button" onClick={running ? preview.stop : preview.start}
            className="flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-xs sm:min-h-0 sm:py-1">
            {running ? <><Square size={14} aria-hidden="true" /> Stop</>
              : preview.active ? <><RotateCcw size={14} aria-hidden="true" /> Replay</>
                : <><Play size={14} aria-hidden="true" /> Play {seconds}s</>}
          </button>
        </div>
        <div className="min-w-0">
          <CreditsOutroPanel project={project} onEditLocal={onEditLocal} onSave={onSave} />
        </div>
      </div>
    </section>
  );
}
