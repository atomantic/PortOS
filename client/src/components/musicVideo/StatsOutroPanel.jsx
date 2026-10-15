import { Scissors } from 'lucide-react';
import { STATS_OUTRO_DEFAULTS, normalizeStatsOutro } from '../../../../server/lib/musicVideoStatsOutro.js';

// Lengths offered for the scene, in seconds (inside STATS_OUTRO_LIMITS).
const LENGTHS = [4, 6, 8, 10, 12, 15, 20];

/**
 * The cutting room floor ending (lib/musicVideoStatsOutro.js): an optional
 * scene after the song tallying what was made, kept and turned down. Off by
 * default; on, it plays in the storyboard animatic when the song ends (or from
 * its Ending button) and is added after the song in the final render.
 */
export default function StatsOutroPanel({ project, onEditLocal, onSave }) {
  const outro = normalizeStatsOutro(project.statsOutro);
  const on = !!outro?.enabled;
  const commit = (patch) => {
    const next = normalizeStatsOutro({ ...(outro || STATS_OUTRO_DEFAULTS), ...patch });
    onEditLocal({ statsOutro: next });
    return onSave({ statsOutro: next });
  };
  const lengths = LENGTHS.includes(outro?.durationSec) || !outro ? LENGTHS : [...LENGTHS, outro.durationSec].sort((a, b) => a - b);
  return (
    <section aria-label="Cutting room floor ending" className="space-y-2 rounded-lg border border-port-border bg-port-card p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Scissors size={14} className="text-port-accent" aria-hidden="true" /> Cutting room floor ending
          <span className="text-xs font-normal text-port-text-muted">Optional</span>
        </h3>
        <label htmlFor="mv-stats-outro-on" className="inline-flex min-h-[44px] items-center gap-2 text-xs text-port-text-muted sm:min-h-0">
          {on ? `On · ${outro.durationSec}s after the song` : 'Off'}
          <input id="mv-stats-outro-on" type="checkbox" checked={on} onChange={(e) => commit({ enabled: e.target.checked })} className="h-4 w-4" />
        </label>
      </div>
      {on && (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div>
            <label htmlFor="mv-stats-outro-length" className="mb-0.5 block text-xs text-port-text-muted">Length</label>
            <select id="mv-stats-outro-length" value={outro.durationSec} onChange={(e) => commit({ durationSec: Number(e.target.value) })}
              className="min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-sm sm:min-h-0">
              {lengths.map((sec) => <option key={sec} value={sec}>{sec}s</option>)}
            </select>
          </div>
          <p className="min-w-0 flex-1 basis-48 text-xs text-port-text-muted">
            A “Human directed” card: renders reviewed, images and videos generated against the ones used, and cuts, moves and effects, over the unused stills. Ending plays it in the player.
          </p>
        </div>
      )}
    </section>
  );
}
