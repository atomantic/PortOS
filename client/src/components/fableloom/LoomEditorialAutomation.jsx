import { BrainCircuit } from 'lucide-react';
import ListLoadError from '../ui/ListLoadError';
import useLoomEditorialAutopilot from './useLoomEditorialAutopilot';
import EditorialRunControls from './EditorialRunControls';
import EditorialFindingsSummary from './EditorialFindingsSummary';

const statusClass = (status) => {
  if (status === 'completed') return 'border-port-success/40 bg-port-success/5 text-port-success';
  if (status === 'failed') return 'border-port-error/40 bg-port-error/5 text-port-error';
  if (status === 'paused' || status === 'canceled') return 'border-port-warning/40 bg-port-warning/5 text-port-warning';
  return 'border-port-accent/30 bg-port-accent/5 text-port-accent';
};

/** Whole-series one-pass editor, bounded editor/reviewer autopilot, and playthrough QA. */
export default function LoomEditorialAutomation({ loom, dirty, onLoomUpdate }) {
  const { settings, actions, autopilotRun, autopilotActive, shownRun, result, readState, readError, retry } = useLoomEditorialAutopilot({ loom, onLoomUpdate });

  return (
    <section
      className="rounded-lg border border-port-accent/40 bg-port-card p-4 space-y-4"
      aria-label="AI editorial automation"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <BrainCircuit size={16} className="text-port-accent" /> AI editor, reviewer & playtest
          </h3>
          <p className="mt-1 text-xs text-port-text-muted max-w-3xl">
            {settings.mode === 'planning'
              ? 'Review the series arc and challenges, then draft and check each episode’s camera-cut outline. Resolve planning problems before writing the teleplay or generating media.'
              : 'Evaluate and repair the complete teleplay, then independently review every enumerated gameplay path. Autopilot repeats until the story passes or reaches its round limit.'}
          </p>
        </div>
        {shownRun ? (
          <span className={`shrink-0 rounded border px-2 py-1 text-xs ${statusClass(shownRun.status)}`}>
            {shownRun.status}
            {shownRun.stepIndex ? ` · step ${shownRun.stepIndex}/${shownRun.stepCount}` : ''}
            {` · round ${shownRun.round}/${shownRun.maxRounds}`}
          </span>
        ) : null}
      </div>

      {readError && <ListLoadError what="editorial autopilot status" error={readError} onRetry={retry} retrying={readState === 'loading'} />}
      <EditorialRunControls
        hasEpisodes={loom.episodes.length > 0}
        dirty={dirty}
        settings={settings}
        actions={actions}
        autopilotRun={autopilotRun}
        autopilotActive={autopilotActive}
        shownRun={shownRun}
      />
      <EditorialFindingsSummary loom={loom} result={result} shownRun={shownRun} />
    </section>
  );
}
