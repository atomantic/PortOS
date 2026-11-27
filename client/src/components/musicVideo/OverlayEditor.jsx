import usePendingFieldEdits from '../../hooks/usePendingFieldEdits.js';
import { useId } from 'react';
import { inputXsClass as inputCls } from './controlClasses.js';
import { compositionDraft } from './compositionDraft.js';

const linesOf = (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
// "12.5 = 80" per line → [[12.5, 80], …]; unparseable lines are dropped.
const keyframesOf = (value) => linesOf(value)
  .map((line) => line.split(/[=:,\s]+/).map(Number))
  .filter(([t, v]) => Number.isFinite(t) && t >= 0 && Number.isFinite(v) && v >= 0 && v <= 100)
  .map(([t, v]) => [t, v]);

/**
 * HUD block the layered template draws (`composition.overlay`). Text fields
 * edit locally and persist on blur, replacing the whole manifest.
 */
export default function OverlayEditor({ project, onSave }) {
  const hudId = useId();
  const composition = compositionDraft(project);
  const overlay = composition.overlay || null;
  const draft = usePendingFieldEdits({
    timecodeStartSec: String(overlay?.timecodeStartSec ?? 0),
    titleLines: (overlay?.titleLines || []).join('\n'),
    ticker: (overlay?.ticker || []).join('\n'),
    meterLabel: overlay?.meter?.label || '',
    keyframes: (overlay?.meter?.keyframes || []).map(([t, v]) => `${t} = ${v}`).join('\n'),
  });
  const save = (patch = {}) => {
    const next = {
      enabled: overlay?.enabled ?? true,
      timecode: overlay?.timecode ?? true,
      timecodeStartSec: Math.max(0, Number(draft.value('timecodeStartSec')) || 0),
      titleLines: linesOf(draft.value('titleLines')).slice(0, 4),
      ticker: linesOf(draft.value('ticker')).slice(0, 40),
      meter: draft.value('meterLabel') || draft.value('keyframes') ? { label: draft.value('meterLabel').trim().slice(0, 40), keyframes: keyframesOf(draft.value('keyframes')) } : null,
      ...patch,
    };
    return onSave({ composition: { ...composition, overlay: next } });
  };
  const field = key => ({
    value: draft.value(key),
    onChange: event => draft.update(key, event.target.value),
    onBlur: () => draft.commit(key, () => save()),
  });
  return (
    <details className="rounded border border-port-border p-2 text-xs">
      <summary className="cursor-pointer select-none text-port-text-muted min-h-[44px] pointer-fine:sm:min-h-0 flex items-center">HUD overlay — {overlay?.enabled === false || !overlay ? 'off' : 'on'} (drawn by the layered template)</summary>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label htmlFor={`${hudId}-on`} className="flex items-center gap-1 min-h-[44px] pointer-fine:sm:min-h-0">
          <input id={`${hudId}-on`} type="checkbox" checked={Boolean(overlay) && overlay.enabled !== false} onChange={(e) => save({ enabled: e.target.checked })} /> Show HUD
        </label>
        <label htmlFor={`${hudId}-tc`} className="flex items-center gap-1 min-h-[44px] pointer-fine:sm:min-h-0">
          <input id={`${hudId}-tc`} type="checkbox" checked={overlay?.timecode ?? true} onChange={(e) => save({ timecode: e.target.checked })} /> Timecode
        </label>
        <label htmlFor={`${hudId}-tc-start`} className="flex items-center gap-1">
          Timecode starts at (s)
          <input id={`${hudId}-tc-start`} type="number" min={0} step={1} className={`${inputCls} w-24`} {...field('timecodeStartSec')} />
        </label>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        <div>
          <label htmlFor={`${hudId}-title`} className="block text-port-text-muted mb-0.5">Title lines (up to 4)</label>
          <textarea id={`${hudId}-title`} rows={3} className={`${inputCls} w-full`} {...field('titleLines')} />
        </div>
        <div>
          <label htmlFor={`${hudId}-ticker`} className="block text-port-text-muted mb-0.5">Ticker (one item per line)</label>
          <textarea id={`${hudId}-ticker`} rows={3} className={`${inputCls} w-full`} {...field('ticker')} />
        </div>
        <div>
          <label htmlFor={`${hudId}-meter`} className="block text-port-text-muted mb-0.5">Meter label</label>
          <input id={`${hudId}-meter`} type="text" maxLength={40} className={`${inputCls} w-full`} {...field('meterLabel')} />
        </div>
        <div>
          <label htmlFor={`${hudId}-keys`} className="block text-port-text-muted mb-0.5">Meter keyframes (seconds = percent, one per line)</label>
          <textarea id={`${hudId}-keys`} rows={3} placeholder={'0 = 100\n60 = 40'} className={`${inputCls} w-full`} {...field('keyframes')} />
        </div>
      </div>
    </details>
  );
}
