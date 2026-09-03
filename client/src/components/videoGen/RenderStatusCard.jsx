/**
 * Video Gen render status (#5872) — what the render is doing, where the user
 * is looking.
 *
 * This replaces the full-size preview stage that used to carry the render's
 * status text. That stage sat above the form, so once the user scrolled down to
 * press Generate the only live feedback left on screen was a bare percentage —
 * and for a runner that reports no numeric progress until denoising begins
 * (FastH3 streams an ~89 GB INT4 DiT first) that percentage sat at 0 for many
 * minutes with no text at all. A video render also can't be usefully previewed
 * mid-flight, so the stage was spending a screen's worth of space on a
 * conditioning still to say something a status line says better.
 *
 * Three things a stalled-looking render needs and a percentage can't give:
 *   - the named step it is on, drawn from the runner's own STAGE: markers;
 *   - elapsed wall clock, so "silent" is visibly distinct from "stuck";
 *   - the display-sleep warning, BEFORE the screen goes dark. An MLX render
 *     sleeps the display on purpose (the Apple GPU watchdog panics when
 *     WindowServer contends with Metal). A user who isn't told reads the dark
 *     screen as a crash and wakes it, re-creating the exact contention.
 *
 * Presentational — every input is owned by the VideoGen page.
 */
import { AlertTriangle, Check, Film, MonitorOff } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import Banner from '../ui/Banner';
import ProgressBar from '../ui/ProgressBar';
import { useTimeTick } from '../../hooks/useTimeTick';
import { formatDurationMs } from '../../utils/formatters';
import { resolveVideoRenderSteps } from '../../lib/videoRenderPhase';

const STEP_STATE_STYLE = {
  done: { text: 'text-port-success', dot: 'bg-port-success' },
  active: { text: 'text-port-accent', dot: 'bg-port-accent' },
  pending: { text: 'text-gray-600', dot: 'bg-gray-700' },
};

/**
 * The elapsed clock, isolated in its own component so its one-second tick
 * re-renders a single span rather than the whole card (the step list, the
 * progress bar and the sleep warning all change far more rarely).
 */
function RenderElapsed({ startedAt }) {
  const now = useTimeTick(1000);
  if (!startedAt || now < startedAt) return null;
  return <span className="font-mono text-gray-500">{formatDurationMs(now - startedAt)}</span>;
}

export default function RenderStatusCard({
  generating = false,
  phase = null,
  progressPct = null,
  statusMsg = '',
  error = null,
  startedAt = null,
  sleepsDisplay = false,
}) {
  const { steps, activeId } = resolveVideoRenderSteps({ generating, phase, progressPct });

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Render status</h2>
        <div className="flex items-center gap-2 text-xs">
          {generating && <RenderElapsed startedAt={startedAt} />}
          {progressPct != null && <span className="font-mono text-port-accent">{progressPct}%</span>}
        </div>
      </div>

      {error ? (
        <Banner tone="error" icon={AlertTriangle}>{error}</Banner>
      ) : generating ? (
        <>
          <div className="flex items-center gap-2 text-sm text-gray-200">
            <BrailleSpinner />
            <span className="truncate" title={statusMsg || undefined}>
              {statusMsg || 'Starting render…'}
            </span>
          </div>

          <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {steps.map((step) => (
              <li
                key={step.id}
                data-testid={`render-step-${step.id}`}
                data-state={step.state}
                className={`flex items-center gap-1 ${STEP_STATE_STYLE[step.state].text}`}
              >
                {step.state === 'done'
                  ? <Check className="w-3 h-3" />
                  : <span className={`w-1.5 h-1.5 rounded-full ${STEP_STATE_STYLE[step.state].dot}`} />}
                <span>{step.label}</span>
              </li>
            ))}
          </ol>

          {progressPct != null && <ProgressBar percent={progressPct} label="Render progress" track="border" />}

          {/* Only shown once the job is past the queue: a render still waiting
              in line has not slept anything yet, and saying so would train the
              user to ignore the warning that matters. */}
          {sleepsDisplay && activeId && activeId !== 'queued' && (
            <Banner tone="warning" icon={MonitorOff}>
              Your display has been put to sleep on purpose for this render — it stops the window
              server from competing with the GPU and crashing it. Leave the screen off; the render
              keeps going and the display wakes when it finishes.
            </Banner>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Film className="w-4 h-4" />
          <span>{statusMsg || 'No render in progress.'}</span>
        </div>
      )}
    </div>
  );
}
