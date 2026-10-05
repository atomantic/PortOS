// Bounds mirror musicVideoPacingSchema so an out-of-range value is refused
// by the input rather than applied locally and then rejected by the server.
const PACING_FIELDS = [
  ['minShotSec', 'Shortest shot (s)', 'Floor for a planned shot; a shorter section stays one shot.', 0.5, 60],
  ['maxShotSec', 'Longest shot (s)', 'Ceiling for a planned shot, never longer than one generated clip (5s local, 6/10s Grok).', 1, 120],
  ['hookSec', 'Opening hook (s)', 'Cap on the very first shot so the video opens on a cut.', 0.5, 60],
];

const inputCls = 'bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0 w-24';

/**
 * Shot pacing for AI Plan (#8964), edited beside the AI Plan button on the
 * Board because it only affects planning. Edits apply to the board at once
 * (`onEditLocal`) and persist on blur (`onSave`, a project PATCH).
 */
export default function ShotPacingFields({ project, onEditLocal, onSave }) {
  const pacing = project.pacing || {};

  const commitPacing = (key, raw, min, max) => {
    const value = Number(raw);
    if (raw !== '' && !(Number.isFinite(value) && value >= min && value <= max)) return false;
    const next = { ...pacing };
    if (raw === '') delete next[key];
    else next[key] = value;
    const nextPacing = Object.keys(next).length > 0 ? next : null;
    onEditLocal({ pacing: nextPacing });
    onSave({ pacing: nextPacing });
    return true;
  };

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 text-xs" role="group" aria-label="Shot pacing">
      <span className="font-medium text-port-text self-center">Shot pacing</span>
      {PACING_FIELDS.map(([key, label, help, min, max]) => (
        <div key={key}>
          <label htmlFor={`mv-pacing-${key}`} className="block text-port-text-muted mb-0.5" title={help}>{label}</label>
          <input id={`mv-pacing-${key}`} type="number" min={min} max={max} step={0.5}
            defaultValue={pacing[key] ?? ''} key={`${project.id}-${key}-${pacing[key] ?? ''}`}
            placeholder="default" title={help}
            onBlur={(e) => {
              if (e.target.value === String(pacing[key] ?? '')) return;
              // Out of range: restore the saved value instead of showing an unsaved one.
              if (!commitPacing(key, e.target.value, min, max)) e.target.value = pacing[key] ?? '';
            }}
            className={inputCls} />
        </div>
      ))}
    </div>
  );
}
