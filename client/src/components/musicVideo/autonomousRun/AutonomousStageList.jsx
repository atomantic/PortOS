import { CheckCircle2, Circle, CircleDot, Loader2, XCircle } from 'lucide-react';
import {
  AUTONOMOUS_LYRICS_STEP_LABELS, AUTONOMOUS_PRODUCE_STEP_LABELS, AUTONOMOUS_SONG_STEP_LABELS, AUTONOMOUS_VIEWABLE_STAGES,
} from '../../../lib/musicVideoAutonomous.js';

// The stages that report a sub-step while they run (the server's `stages[id].step`).
const STEP_LABELS = { lyrics: AUTONOMOUS_LYRICS_STEP_LABELS, produce: AUTONOMOUS_PRODUCE_STEP_LABELS, song: AUTONOMOUS_SONG_STEP_LABELS };

const STAGE_MARKS = {
  done: { Icon: CheckCircle2, cls: 'text-port-success', label: 'done' },
  running: { Icon: Loader2, cls: 'text-port-accent animate-spin', label: 'running' },
  failed: { Icon: XCircle, cls: 'text-port-error', label: 'failed' },
  pending: { Icon: Circle, cls: 'text-port-text-muted', label: 'not started' },
};

export default function AutonomousStageList({ rows, selected, onSelectStage }) {
  return (
    <ol aria-label="Autonomous stages" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-x-3 gap-y-1 text-xs">
      {rows.map((row) => {
        const { Icon, cls, label } = STAGE_MARKS[row.status] || STAGE_MARKS.pending;
        const mark = row.current && row.status === 'pending' ? <CircleDot size={13} className="shrink-0 text-port-accent" aria-hidden="true" /> : <Icon size={13} className={`shrink-0 ${cls}`} aria-hidden="true" />;
        const content = (
          <>
            {mark}
            <span className="truncate">{row.label}</span>
            <span className="sr-only">({label})</span>
          </>
        );
        const rowTone = row.current ? 'font-medium text-port-text' : 'text-port-text-muted';
        // Only a stage that finished and keeps something to show opens.
        const openable = row.status === 'done' && AUTONOMOUS_VIEWABLE_STAGES.includes(row.id) && onSelectStage;
        return (
          <li key={row.id} aria-current={row.current ? 'step' : undefined} className="min-w-0">
            {openable ? (
              <button
                type="button"
                aria-expanded={selected === row.id}
                aria-controls={`mv-run-stage-${row.id}`}
                onClick={() => onSelectStage(selected === row.id ? null : row.id)}
                className={`flex w-full min-w-0 items-center gap-1 rounded px-1 -mx-1 min-h-[44px] pointer-fine:sm:min-h-0 hover:bg-port-bg ${selected === row.id ? 'bg-port-bg' : ''} ${rowTone}`}
              >
                {content}
              </button>
            ) : (
              <span className={`flex min-w-0 items-center gap-1 ${rowTone}`}>{content}</span>
            )}
            {STEP_LABELS[row.id] && row.status === 'running' && row.step && (
              <p role="status" className="pl-[17px] text-port-accent break-words">{STEP_LABELS[row.id][row.step] || row.step}…</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
