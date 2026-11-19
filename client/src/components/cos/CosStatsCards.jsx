/**
 * The Chief of Staff stat tiles (Active, Pending, Done, Issues, Learning) in the three layouts the page uses, plus the sidebar's queue and daemon controls.
 *
 * One list serves every placement so a tile change cannot drift between them: `sidebar` is the avatar panel's compact grid with the Pause/Resume/Stop/Start buttons, `collapsed` is the four-tile grid under the mobile header when the desktop rail is collapsed, and `bar` is the mini row the ascii/terminal avatar keeps in the content panel.
 */
import { useNavigate } from 'react-router';
import { Play, Pause, Square, Clock, CheckCircle, AlertCircle, Cpu, Brain } from 'lucide-react';
import StatCard from './StatCard';
import { summarizeHealthIssues, healthIssueTone } from './constants';

const ICON_SIZE = {
  compact: 'w-4 h-4',
  mini: 'w-3 h-3 sm:w-4 sm:h-4 lg:w-5 lg:h-5',
};

function QueueControls({ status, onStart, onStop, onPause, onResume }) {
  if (!status?.running) {
    return (
      <button
        type="button"
        onClick={onStart}
        className="bg-port-success/20 hover:bg-port-success/30 text-port-success border border-port-success/30 rounded px-2 py-1.5 flex items-center gap-2 transition-colors min-h-[52px]"
        aria-label="Start Chief of Staff agent"
      >
        <Play size={16} className="shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[10px] text-port-success/80">Agent</div>
          <div className="text-sm font-bold">Start</div>
        </div>
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={status.paused ? onResume : onPause}
        className={`border rounded px-2 py-1.5 flex items-center gap-2 transition-colors min-h-[52px] ${
          status.paused
            ? 'bg-port-success/20 hover:bg-port-success/30 text-port-success border-port-success/30'
            : 'bg-port-warning/20 hover:bg-port-warning/30 text-port-warning border-port-warning/30'
        }`}
        aria-label={status.paused ? 'Resume Chief of Staff scheduling' : 'Pause Chief of Staff scheduling'}
        title={status.paused
          ? 'Resume task evaluation and dispatch'
          : 'Pause new task evaluation and dispatch; running agents keep their work'}
      >
        {status.paused
          ? <Play size={16} className="shrink-0" aria-hidden="true" />
          : <Pause size={16} className="shrink-0" aria-hidden="true" />}
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[10px] text-gray-600">Queue</div>
          <div className={`${status.paused ? 'text-xs' : 'text-sm'} font-bold`}>{status.paused ? 'Resume' : 'Pause'}</div>
        </div>
      </button>
      <button
        type="button"
        onClick={onStop}
        className="bg-port-error/20 hover:bg-port-error/30 text-port-error border border-port-error/30 rounded px-2 py-1.5 flex items-center gap-2 transition-colors min-h-[52px]"
        aria-label="Stop Chief of Staff agent"
      >
        <Square size={16} className="shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[10px] text-gray-600">Agent</div>
          <div className="text-sm font-bold text-port-error">Stop</div>
        </div>
      </button>
    </>
  );
}

/** @param {{ cos: object, variant: 'sidebar' | 'collapsed' | 'bar' }} props `cos` is the `useCosPageData` result. */
export default function CosStatsCards({ cos, variant }) {
  const navigate = useNavigate();
  const { status, activeAgentCount, pendingTaskCount, learningSummary, health, healthLoaded, healthError } = cos;
  const bar = variant === 'bar';
  const size = bar ? 'mini' : 'compact';
  const sizeProp = { [size]: true };
  const iconSize = ICON_SIZE[size];

  // Historical learning recommendations do not indicate a scheduler pause.
  const learningLowSuccess = learningSummary?.lowSuccessCount ?? learningSummary?.skipped ?? 0;
  // `!= null`, not truthiness — a real 0% success rate is the highest-signal
  // state and must not render as the empty state. `null` is the sentinel each
  // tile falls back from to its own (differently sized) empty-state string.
  const learningRate = learningSummary?.overallSuccessRate != null ? `${learningSummary.overallSuccessRate}%` : null;

  // The Issues tile is the only place the UI admits CoS found something wrong,
  // so it has to click through to the detail. Without that, a warning-level
  // health issue parked the avatar on "Investigating" with Active 0, no agent
  // to open, and the offending message reachable only by guessing at the Health
  // tab. `title` surfaces the same summary on hover/touch-and-hold.
  const healthIssues = health?.issues || [];

  return (
    <>
      <StatCard
        label="Active"
        value={activeAgentCount}
        icon={<Cpu className={`${iconSize} text-port-accent`} />}
        active={activeAgentCount > 0}
        {...sizeProp}
      />
      <StatCard
        label="Pending"
        value={pendingTaskCount}
        icon={<Clock className={`${iconSize} text-port-warning`} />}
        {...sizeProp}
      />
      <StatCard
        label="Done"
        value={status?.stats?.tasksCompleted || 0}
        icon={<CheckCircle className={`${iconSize} text-port-success`} />}
        {...sizeProp}
      />
      <StatCard
        label="Issues"
        value={healthError || !healthLoaded ? '—' : healthIssues.length}
        tone={healthError ? 'warning' : healthIssueTone(healthIssues)}
        title={healthError ? 'Health unavailable — view last results and retry'
          : !healthLoaded ? 'Health not observed yet — view system health'
            : summarizeHealthIssues(healthIssues) || 'No issues detected — view system health'}
        onClick={() => navigate('/cos/health')}
        icon={<AlertCircle className={iconSize} />}
        {...sizeProp}
      />
      {variant !== 'collapsed' && (
        // Clickable through to the Learning tab.
        <StatCard
          label="Learning"
          tone={learningLowSuccess > 0 ? 'warning' : (learningSummary?.status || 'default')}
          active={learningLowSuccess > 0}
          activeLabel={learningLowSuccess > 0 ? `${learningLowSuccess} low success` : null}
          title={learningSummary?.statusMessage || 'View learning analytics'}
          onClick={() => navigate('/cos/learning')}
          value={learningRate ?? (bar ? '—' : 'No data')}
          icon={<Brain className={bar ? iconSize : 'w-4 h-4'} />}
          className={bar ? undefined : 'hidden lg:flex'}
          {...sizeProp}
        />
      )}
      {variant === 'sidebar' && (
        <QueueControls
          status={status}
          onStart={cos.handleStart}
          onStop={cos.handleStop}
          onPause={cos.handlePause}
          onResume={cos.handleResume}
        />
      )}
    </>
  );
}
