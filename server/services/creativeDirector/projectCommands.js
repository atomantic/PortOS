/**
 * Creative Director — which project status commands are legal (#15153).
 *
 * Start, pause, resume, stop, and the agent-failure write all change a project's
 * status. They share this one pure table so a command a state does not allow
 * (pause on `complete`, resume on `failed`) is refused instead of rewriting the
 * row. `applyProjectPatch` still validates only enum membership: it is the store
 * write, not the command API.
 *
 * Video-workspace projects run their own machine (videoExecution.js), so every
 * command except `agent-failed` resolves to `delegate` for them.
 *
 * Result shapes:
 *   { outcome: 'reject', httpStatus, code, message } — refuse; write nothing.
 *   { outcome: 'skip', skipped }                     — nothing to do; write nothing.
 *   { outcome: 'delegate' }                          — video workspace owns it.
 *   { outcome: 'apply', patch, advance, resetFailedScenes }
 *       `patch` is the project write, or null when the state already satisfies
 *       the command (an in-flight Start, a Stop on an already-parked project).
 *       A null patch writes nothing, so it never releases `peerReplica` state.
 */

import { PROJECT_TERMINAL_STATUSES } from '../../lib/creativeDirectorPresets.js';

export const PROJECT_COMMAND_EVENTS = Object.freeze(['start', 'pause', 'resume', 'stop', 'agent-failed']);

const IN_FLIGHT_STATUSES = new Set(['planning', 'rendering', 'stitching']);

const reject = (message) => ({ outcome: 'reject', httpStatus: 409, code: 'INVALID_STATE', message });
const skip = (skipped) => ({ outcome: 'skip', skipped });
const apply = (patch, { advance = false, resetFailedScenes = false } = {}) => ({ outcome: 'apply', patch, advance, resetFailedScenes });

// Restarting resumes where the work stands: scenes exist → render, else plan.
// The reason is cleared because a stop parks the project WITH one, and the
// overview/plan tabs render any non-empty failureReason as a red banner — the
// restarted pass would otherwise run under a report of the stop just undone.
const restart = (project, opts) => apply({ status: project.treatment ? 'rendering' : 'planning', failureReason: null }, { advance: true, ...opts });

const skipTerminalOr = (status) => skip(PROJECT_TERMINAL_STATUSES.has(status) ? 'terminal' : status);

// A failed agent exit is often the echo of a deliberate kill (Pause, Stop, a
// reaper) — only a project that was still working takes the failure.
function agentFailed(project, reason) {
  const { status } = project;
  if (project.workspace === 'video') {
    return PROJECT_TERMINAL_STATUSES.has(status) || status === 'paused'
      ? skipTerminalOr(status)
      : apply({ status: 'failed', failureReason: reason });
  }
  return IN_FLIGHT_STATUSES.has(status) ? apply({ status: 'failed', failureReason: reason }) : skipTerminalOr(status);
}

function start(project) {
  const { status } = project;
  if (status === 'draft') return apply({ status: 'planning' }, { advance: true });
  if (status === 'paused') return restart(project);
  if (status === 'failed') return restart(project, { resetFailedScenes: true });
  if (status === 'complete' && project.finalVideoId) return skip('complete');
  // In flight, or complete with no final (the advance is what stitches it).
  // Starting a peer's replica here takes it over: the same-status echo is what
  // releases the sender's running work (applyProjectPatch).
  if (IN_FLIGHT_STATUSES.has(status) || status === 'complete') return apply(project.peerReplica ? { status } : null, { advance: true });
  return reject(`Cannot start a ${status} project`);
}

function stop(project, reason) {
  const { status } = project;
  if (PROJECT_TERMINAL_STATUSES.has(status)) return skip('terminal');
  if (IN_FLIGHT_STATUSES.has(status)) return apply({ status: 'paused', failureReason: reason });
  // Draft and paused are already parked: no status write, but the caller's
  // teardown still runs — a paused project's render keeps going until stopped,
  // and a draft may own queued first-pass seed frames. A draft needs no park
  // write to fence the advance loop: nothing arms a dispatch on it (every
  // planner/treatment dispatch flips the project to `planning` first).
  return apply(null);
}

/**
 * @param {object|null} project
 * @param {'start'|'pause'|'resume'|'stop'|'agent-failed'} event
 * @param {{reason?: string|null}} [options] — stamped as `failureReason` by stop and agent-failed.
 */
export function resolveCreativeDirectorProjectCommand(project, event, { reason = null } = {}) {
  if (!PROJECT_COMMAND_EVENTS.includes(event)) throw new Error(`Unknown Creative Director project command: ${event}`);
  if (!project) {
    return event === 'stop' || event === 'agent-failed'
      ? skip('missing')
      : { outcome: 'reject', httpStatus: 404, code: 'NOT_FOUND', message: 'Project not found' };
  }
  if (event === 'agent-failed') return agentFailed(project, reason);
  if (project.workspace === 'video') {
    // A delivered video is finished; a failed one still holds work Stop must retire.
    return event === 'stop' && project.status === 'complete' ? skip('terminal') : { outcome: 'delegate' };
  }
  switch (event) {
    case 'start': return start(project);
    case 'pause': return IN_FLIGHT_STATUSES.has(project.status) ? apply({ status: 'paused' }) : reject(`Cannot pause a ${project.status} project`);
    case 'resume': return project.status === 'paused' ? restart(project) : reject('Project is not paused');
    default: return stop(project, reason);
  }
}
