import { Zap } from 'lucide-react';
import { SHOT_EFFECT_SLOTS, SHOT_EFFECT_SLOT_LABELS, shotEffectLabel } from '../../lib/musicVideoShotEffects.js';
import { formatCount } from '../../utils/formatters.js';

const POSITIONS = { start: 'left-1', mid: 'left-1/2 -translate-x-1/2', end: 'right-1' };

/**
 * Bottom chips on a Board thumbnail: the shot's start effect at the left, its
 * mid-shot effects in the center and its end effect at the right. A slot with
 * more than one shows the first and how many more.
 */
export function SceneEffectBadges({ sceneId, effects }) {
  const filled = SHOT_EFFECT_SLOTS.filter((slot) => effects[slot].length);
  if (!filled.length) return null;
  return (
    <span id={`scene-effects-${sceneId}`}>
      {filled.map((slot) => {
        const [first, ...rest] = effects[slot];
        const names = effects[slot].map(shotEffectLabel).join(', ');
        return (
          <span key={slot} title={`${SHOT_EFFECT_SLOT_LABELS[slot]}: ${names}`}
            className={`port-media-overlay-strong absolute bottom-1 ${POSITIONS[slot]} inline-flex max-w-[32%] items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium leading-none`}>
            <Zap size={10} aria-hidden="true" className="shrink-0" />
            <span className="truncate" aria-hidden="true">{shotEffectLabel(first)}</span>
            {rest.length > 0 && <span className="shrink-0" aria-hidden="true">+{rest.length}</span>}
            <span className="sr-only">{SHOT_EFFECT_SLOT_LABELS[slot]}: {names}.</span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * The Shots page's effect totals: every effect option with how often the
 * video plays it at a shot's start, mid-shot and end, unused ones included,
 * most used first. Tapping an option shows only the shots that play it
 * (`onSelect(id)`, again to clear).
 */
export default function ShotEffectsCard({ counts, selected = null, onSelect }) {
  const rows = [...counts].sort((a, b) => b.total - a.total);
  const used = rows.filter((row) => row.total > 0);
  const top = used.slice(0, 3).map((row) => `${row.label} ${formatCount(row.total)}`).join(' · ');
  return (
    <details className="rounded-lg border border-port-border bg-port-card" open={!!selected || undefined}>
      <summary className="flex min-h-[44px] cursor-pointer flex-wrap items-center gap-x-2 px-3 py-2 text-sm sm:min-h-0">
        <span className="font-medium">Effects</span>
        <span className="min-w-0 truncate text-xs text-port-text-muted">{used.length ? top : 'None set yet'}</span>
      </summary>
      <table className="w-full table-fixed border-t border-port-border text-xs" aria-label="Effect counts">
        <thead>
          <tr className="text-port-text-muted">
            <th scope="col" className="w-2/5 px-3 py-1 text-left font-normal">Effect</th>
            {SHOT_EFFECT_SLOTS.map((slot) => <th key={slot} scope="col" className="px-1 py-1 text-right font-normal">{SHOT_EFFECT_SLOT_LABELS[slot]}</th>)}
            <th scope="col" className="px-3 py-1 text-right font-normal">Shots</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={`${row.id === selected ? 'bg-port-accent/10' : ''} ${row.total ? '' : 'text-port-text-muted'}`}>
              <th scope="row" className="px-1 py-0 text-left font-normal">
                <button type="button" onClick={() => onSelect?.(row.id === selected ? null : row.id)} disabled={!row.total}
                  aria-pressed={row.id === selected} aria-label={row.total ? `Show shots with ${row.label}` : `${row.label}: not used`}
                  className="min-h-[44px] w-full truncate rounded px-2 text-left hover:bg-port-border/40 disabled:hover:bg-transparent sm:min-h-[28px]">
                  {row.label}
                </button>
              </th>
              {SHOT_EFFECT_SLOTS.map((slot) => (
                <td key={slot} className="px-1 text-right tabular-nums">{row.slots.includes(slot) ? formatCount(row[slot], { fallback: '0' }) : '—'}</td>
              ))}
              <td className="px-3 text-right font-medium tabular-nums">{formatCount(row.shots, { fallback: '0' })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
