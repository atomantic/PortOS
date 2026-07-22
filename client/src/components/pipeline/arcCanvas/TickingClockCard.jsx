import { Clock } from 'lucide-react';
import FieldLockToggle from './FieldLockToggle.jsx';

// Read-only ticking-clock card for the arc view. Hidden unless the clock is
// enabled (a disabled/absent clock means "this story has no countdown").
export default function TickingClockCard({ clock, series, onSeriesUpdate }) {
  if (!clock || clock.enabled !== true) return null;
  const span = clock.plantedAtArcPosition != null || clock.dueAtArcPosition != null
    ? `${clock.plantedAtArcPosition ?? '?'} → ${clock.dueAtArcPosition ?? '?'}`
    : null;
  const reminders = Array.isArray(clock.reminders) ? clock.reminders : [];
  return (
    <div className="rounded border border-port-warning/40 bg-port-bg/50 px-2 py-1.5 space-y-1">
      <div className="flex items-center gap-1.5">
        <Clock size={12} className="text-port-warning shrink-0" />
        <span className="text-xs font-medium text-white truncate">{clock.label || 'Ticking clock'}</span>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">{clock.kind || 'custom'}</span>
        {span ? <span className="text-[10px] text-gray-400 ml-auto">arc {span}</span> : null}
        <span className={span ? '' : 'ml-auto'}>
          <FieldLockToggle series={series} field="tickingClock" label="Ticking clock" onSeriesUpdate={onSeriesUpdate} />
        </span>
      </div>
      {clock.stakes ? <p className="text-[11px] text-gray-400 whitespace-pre-wrap">{clock.stakes}</p> : null}
      {reminders.length ? (
        <ul className="text-[11px] text-gray-500 list-disc list-inside">
          {reminders.map((r) => (
            <li key={r.id}>{r.note || `Reminder at issue ${r.atIssue ?? '?'}`}{r.note && r.atIssue != null ? ` (issue ${r.atIssue})` : ''}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
