import { BEAT_TOGGLE_OVERLAP, BEAT_TOGGLE_RATE_LABELS, BEAT_TOGGLE_RATES, MUSIC_VIDEO_CUT_EFFECT_LABELS, MUSIC_VIDEO_CUT_EFFECTS, sceneCutEffect } from '../../lib/musicVideoCutEffects.js';

const OVERLAPS = Object.freeze([0.5, 1, 1.5, 2, 3, 4]);
const OVERLAP_LABELS = { 0.5: '½ s', 1: '1 s', 1.5: '1½ s', 2: '2 s', 3: '3 s', 4: '4 s' };
const TITLES = {
  'beat-toggle': 'Both clips play over the end of this shot and the picture flips between them on the beats, then the next shot carries on',
  dissolve: 'The next shot fades in over the end of this one, fully in on the cut',
  'fade-black': 'This shot fades to black and the next fades in from it, half the length each side of the cut',
};

/**
 * How a shot hands over to the next one: a plain cut, a beat toggle, a dissolve
 * or a fade through black (on the last shot, a cut or a fade to black), with how
 * long it plays. Picking Cut switches the effect off but keeps its settings, so
 * picking it again brings them back. A storyboard row that plans a Dissolve or
 * Fade (`planned`) is the choice until one is picked. It never moves a cut or changes a lock.
 */
export default function SceneCutEffect({ fieldId, scene, planned = null, isLast = false, onChange, disabled = false }) {
  const effect = sceneCutEffect(scene, planned);
  const styles = isLast ? ['fade-black'] : MUSIC_VIDEO_CUT_EFFECTS;
  const style = effect?.enabled && styles.includes(effect.style) ? effect.style : '';
  const save = (patch) => onChange({
    cutEffect: { style: effect?.style ?? 'beat-toggle', enabled: !!style, overlapSec: effect?.overlapSec ?? BEAT_TOGGLE_OVERLAP.default, rate: effect?.rate ?? 'beat', ...patch },
  });
  const pick = (next) => {
    if (next) save({ style: next, enabled: true });
    else if (effect) save({ enabled: false });
  };
  const selectClass = 'bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50';
  const overlap = OVERLAPS.includes(effect?.overlapSec) ? effect.overlapSec : null;
  const label = isLast ? 'At the end' : 'Into next shot';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="scene-cut-effect">
      <span className="flex min-w-0 items-center gap-1">
        <label htmlFor={fieldId('cut-effect')} className={style ? 'text-port-accent' : 'text-port-text-muted'}>{label}</label>
        <select id={fieldId('cut-effect')} value={style} disabled={disabled} title={TITLES[style] || 'A plain cut'}
          onChange={(e) => pick(e.target.value)} className={`min-w-0 ${selectClass}`}>
          <option value="">Cut</option>
          {styles.map((s) => <option key={s} value={s}>{isLast && s === 'fade-black' ? 'Fade to black' : MUSIC_VIDEO_CUT_EFFECT_LABELS[s]}</option>)}
        </select>
      </span>
      {style && (
        <>
          <label htmlFor={fieldId('cut-effect-length')} className="sr-only">{`${label} length`}</label>
          <select id={fieldId('cut-effect-length')} value={overlap ?? ''} disabled={disabled} title="How long it plays"
            onChange={(e) => save({ overlapSec: Number(e.target.value) })} className={selectClass}>
            {overlap == null && <option value="">{`${effect.overlapSec} s`}</option>}
            {OVERLAPS.map((sec) => <option key={sec} value={sec}>{OVERLAP_LABELS[sec]}</option>)}
          </select>
          {style === 'beat-toggle' && (
            <>
              <label htmlFor={fieldId('beat-toggle-rate')} className="sr-only">Beat toggle speed</label>
              <select id={fieldId('beat-toggle-rate')} value={effect.rate} disabled={disabled}
                onChange={(e) => save({ rate: e.target.value })} className={selectClass}>
                {BEAT_TOGGLE_RATES.map((rate) => <option key={rate} value={rate}>{BEAT_TOGGLE_RATE_LABELS[rate]}</option>)}
              </select>
            </>
          )}
        </>
      )}
    </div>
  );
}
