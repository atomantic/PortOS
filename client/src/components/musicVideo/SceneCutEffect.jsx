import { BEAT_TOGGLE_OVERLAP, BEAT_TOGGLE_RATE_LABELS, BEAT_TOGGLE_RATES, sceneCutEffect } from '../../lib/musicVideoCutEffects.js';

const OVERLAPS = Object.freeze([0.5, 1, 1.5, 2]);
const OVERLAP_LABELS = { 0.5: '½ s', 1: '1 s', 1.5: '1½ s', 2: '2 s' };

/**
 * The beat toggle across the cut out of a shot: a switch, then how long before
 * the cut it plays and how fast it flips. Switching it off keeps the settings,
 * so turning it back on brings them back. It never moves a cut or changes a lock.
 */
export default function SceneCutEffect({ fieldId, scene, onChange, disabled = false }) {
  const effect = sceneCutEffect(scene);
  const on = !!effect?.enabled;
  const save = (patch) => onChange({
    cutEffect: { style: 'beat-toggle', enabled: on, overlapSec: effect?.overlapSec ?? BEAT_TOGGLE_OVERLAP.default, rate: effect?.rate ?? 'beat', ...patch },
  });
  const selectClass = 'bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50';
  const overlap = OVERLAPS.includes(effect?.overlapSec) ? effect.overlapSec : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="scene-cut-effect">
      <label htmlFor={fieldId('beat-toggle')} className="flex min-h-[44px] items-center gap-1.5 sm:min-h-0"
        title="Both clips play over the end of this shot and the picture flips between them on the beats, then the next shot carries on">
        <input id={fieldId('beat-toggle')} type="checkbox" checked={on} disabled={disabled}
          onChange={(e) => save({ enabled: e.target.checked })} className="accent-port-accent" />
        <span className={on ? 'text-port-accent' : 'text-port-text-muted'}>Beat toggle into next shot</span>
      </label>
      {effect && (
        <>
          <label htmlFor={fieldId('beat-toggle-overlap')} className="sr-only">Beat toggle length</label>
          <select id={fieldId('beat-toggle-overlap')} value={overlap ?? ''} disabled={disabled} title="How long before the cut it plays"
            onChange={(e) => save({ overlapSec: Number(e.target.value) })} className={selectClass}>
            {overlap == null && <option value="">{`${effect.overlapSec} s`}</option>}
            {OVERLAPS.map((sec) => <option key={sec} value={sec}>{OVERLAP_LABELS[sec]}</option>)}
          </select>
          <label htmlFor={fieldId('beat-toggle-rate')} className="sr-only">Beat toggle speed</label>
          <select id={fieldId('beat-toggle-rate')} value={effect.rate} disabled={disabled}
            onChange={(e) => save({ rate: e.target.value })} className={selectClass}>
            {BEAT_TOGGLE_RATES.map((rate) => <option key={rate} value={rate}>{BEAT_TOGGLE_RATE_LABELS[rate]}</option>)}
          </select>
        </>
      )}
    </div>
  );
}
