import { formatCount } from '../utils/formatters.js';

/**
 * "Where does this pipeline issue stand, and what is the user's next move" — the
 * one status line under the issue title (#9949), derived from the issue's stage
 * records plus the live auto-run frame so it can be tested without the page.
 *
 * `stages` is the ordered list of visible stage ids, `labels` maps id → label.
 * Returns `{ headline, tone, facts, next }`: `tone` is `error` for a failed
 * stage, `warn` while a stage waits on the user, `ok` when every stage is
 * ready, else `muted`. `next` is `{ id: 'cancel-auto-run' }` during a run or
 * `{ id: 'goto', stage, label, reason }` pointing at the stage to open (dropped
 * when that stage is already on screen).
 */

// Stage statuses that mean the stage has produced something the user can build on.
const READY = new Set(['ready', 'edited']);

// The auto-run SSE frame, in words. Null while nothing has been reported yet.
function describeFrame(frame, labels) {
  const label = labels[frame?.stage] || frame?.stage;
  switch (frame?.type) {
    case 'stage:start': return `Generating ${label}…`;
    case 'stage:complete':
      return frame.stage === 'episodeVideo'
        ? `${label} kicked off — ${frame.scenes} ${frame.scenes === 1 ? 'scene' : 'scenes'} queued in Creative Director`
        : `${label} ready (${formatCount(frame.length)} chars)`;
    case 'stage:error': return `${label} error — ${frame.error}`;
    case 'skip': return `${label} skipped — ${frame.reason}`;
    case 'start': return 'Starting auto-run…';
    default: return null;
  }
}

export function describePipelineIssueStatus(issue, { stages, labels, autoRunActive = false, latest = null, activeStage = null } = {}) {
  if (!issue) return null;
  const statusOf = (id) => issue.stages?.[id]?.status || 'empty';
  const ready = stages.filter((id) => READY.has(statusOf(id)));
  const facts = [{ id: 'progress', label: `${ready.length} of ${stages.length} stages ready`, tone: 'muted' }];
  const goto = (stage, verb) => (stage === activeStage ? null : { id: 'goto', stage, label: `${verb} ${labels[stage]}`, reason: `Open the ${labels[stage]} stage` });

  if (autoRunActive) {
    const frame = describeFrame(latest, labels);
    return {
      headline: `Auto-run in progress${frame ? ` · ${frame}` : ''}`,
      tone: latest?.type === 'stage:error' ? 'error' : 'muted',
      facts,
      next: { id: 'cancel-auto-run', label: 'Cancel auto-run', reason: 'Stop the auto-run after the current stage' },
    };
  }

  const failed = stages.find((id) => statusOf(id) === 'error');
  if (failed) {
    // `errorMessage` is the server's persisted failure text (up to 4000 chars) — one line here.
    const reason = (issue.stages?.[failed]?.errorMessage || '').slice(0, 160);
    return { headline: `${labels[failed]} failed${reason ? ` · ${reason}` : ''}`, tone: 'error', facts, next: goto(failed, 'Open') };
  }
  const generating = stages.find((id) => statusOf(id) === 'generating');
  if (generating) return { headline: `Generating ${labels[generating]}`, tone: 'muted', facts, next: null };
  const review = stages.find((id) => statusOf(id) === 'needs-review');
  if (review) return { headline: `${labels[review]} needs your review`, tone: 'warn', facts, next: goto(review, 'Review') };
  const empty = stages.find((id) => statusOf(id) === 'empty');
  if (empty) return { headline: `Next up: ${labels[empty]} · waiting for you to start it`, tone: 'warn', facts, next: goto(empty, 'Open') };
  return { headline: 'All stages ready', tone: 'ok', facts, next: null };
}
