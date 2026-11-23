import { RotateCcw } from 'lucide-react';
import { controlBlocked, jointLabel } from '../../lib/blenderModelPose.js';
import { formatCount } from '../../utils/formatters.js';
import { buttonCls, labelCls } from '../musicVideo/blender/blenderStyles.js';

const percent = (value) => Number(value.toFixed(2));

function Control({ control, controls, values, onMove }) {
  const value = values[control.id];
  const reason = controlBlocked(control, values, controls);
  const id = `bm-control-${control.id}`;
  return (
    <li className="min-w-0 px-2 py-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <label htmlFor={id} className={`${labelCls} min-w-0 flex-1 break-words`}>{control.label}</label>
        <output htmlFor={id} className="text-xs tabular-nums">{percent(value)} · {jointLabel(control, value)}</output>
      </div>
      <input id={id} type="range" min={0} max={1} step={0.01} value={value} disabled={!!reason} aria-describedby={reason ? `${id}-reason` : undefined}
        aria-valuetext={jointLabel(control, value)} className="min-h-[44px] w-full accent-port-accent disabled:opacity-50 pointer-fine:sm:min-h-0"
        onChange={(event) => onMove(control.id, Number(event.target.value))} />
      {reason && <p id={`${id}-reason`} className="text-xs text-port-warning">{reason}</p>}
    </li>
  );
}

function sweepLine({ sweep }) {
  const poses = `${formatCount(sweep.poses)} poses checked`;
  if (sweep.clean) return `${poses}; no parts pass through each other.`;
  const problems = [
    sweep.overlaps.length ? `${formatCount(sweep.overlaps.length)} pair(s) of parts pass through each other` : null,
    sweep.unmeasured.length ? 'some poses were not checked' : null,
  ].filter(Boolean);
  return `${poses}; ${problems.join(' and ') || 'see the findings'}.`;
}

/** Pose sliders: each control from 0 to 1, driving the GLB's own clips in the viewer. */
export default function BlenderModelPose({ motion, values, highlight, canReset, onMove, onReset }) {
  const { controls } = motion;
  return (
    <section aria-label="Pose" className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">Pose</h2>
        {canReset && <button type="button" className={buttonCls} onClick={onReset}><RotateCcw size={14} aria-hidden="true" /> Reset pose</button>}
      </div>
      <ul className="max-h-[40dvh] min-w-0 divide-y divide-port-border overflow-y-auto rounded border border-port-border">
        {controls.map((control) => <Control key={control.id} control={control} controls={controls} values={values} onMove={onMove} />)}
      </ul>
      {highlight && <p role="status" className="break-words text-xs">Showing where {highlight.join(' and ')} pass through each other.</p>}
      <p className="text-xs text-port-text-muted">{sweepLine(motion)}</p>
    </section>
  );
}
