import { useEffect, useState } from 'react';
import { Scissors } from 'lucide-react';
import { STATS_OUTRO_DEFAULTS, STATS_OUTRO_LIMITS, STATS_OUTRO_LINES, normalizeStatsOutro } from '../../../../server/lib/musicVideoStatsOutro.js';

// Lengths offered for the scene, in seconds (inside STATS_OUTRO_LIMITS).
const LENGTHS = [4, 6, 8, 10, 12, 15, 20];

const FIELD = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-sm sm:min-h-0';

/** One heading line: edited in place, saved when it loses focus. Empty leaves the line out. */
function HeadingField({ id, label, value, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-0.5 block text-xs text-port-text-muted">{label}</label>
      <input id={id} type="text" value={draft} maxLength={STATS_OUTRO_LIMITS.textMax} placeholder="Optional"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim() !== value) onCommit(draft.trim()); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className={`${FIELD} w-full`} />
    </div>
  );
}

/**
 * The cutting room floor ending (lib/musicVideoStatsOutro.js): an optional
 * scene after the song with a heading, an orange subheading and a tally of
 * what was made, used and left on the floor. Off by default; on, it plays in
 * the storyboard animatic when the song ends (or from its Ending button) and
 * is added after the song in the final render. Its heading lines and which
 * tally lines show are set here.
 */
export default function StatsOutroPanel({ project, onEditLocal, onSave }) {
  const outro = normalizeStatsOutro(project.statsOutro);
  const on = !!outro?.enabled;
  const commit = (patch) => {
    const next = normalizeStatsOutro({ ...(outro || STATS_OUTRO_DEFAULTS), ...patch });
    onEditLocal({ statsOutro: next });
    return onSave({ statsOutro: next });
  };
  const toggleLine = (key, shown) => {
    const hidden = new Set(outro.hidden);
    if (shown) hidden.delete(key); else hidden.add(key);
    return commit({ hidden: [...hidden] });
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
        <div className="space-y-2">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
            <HeadingField id="mv-stats-outro-title" label="Heading" value={outro.title} onCommit={(title) => commit({ title })} />
            <HeadingField id="mv-stats-outro-subtitle" label="Subheading (orange)" value={outro.subtitle} onCommit={(subtitle) => commit({ subtitle })} />
            <div>
              <label htmlFor="mv-stats-outro-length" className="mb-0.5 block text-xs text-port-text-muted">Length</label>
              <select id="mv-stats-outro-length" value={outro.durationSec} onChange={(e) => commit({ durationSec: Number(e.target.value) })} className={FIELD}>
                {lengths.map((sec) => <option key={sec} value={sec}>{sec}s</option>)}
              </select>
            </div>
          </div>
          <fieldset className="min-w-0">
            <legend className="mb-0.5 text-xs text-port-text-muted">Show</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {STATS_OUTRO_LINES.map(({ key, label }) => (
                <label key={key} htmlFor={`mv-stats-outro-line-${key}`} className="inline-flex min-h-[44px] items-center gap-1.5 text-xs sm:min-h-0">
                  <input id={`mv-stats-outro-line-${key}`} type="checkbox" checked={!outro.hidden.includes(key)}
                    onChange={(e) => toggleLine(key, e.target.checked)} className="h-4 w-4" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-port-text-muted">Unused stills fill the floor behind it. Ending plays it in the player.</p>
        </div>
      )}
    </section>
  );
}
