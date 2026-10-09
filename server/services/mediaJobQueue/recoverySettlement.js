/**
 * Recovery evidence for one media job lifecycle, and the one decision that
 * turns it into a maintenance-permit release.
 *
 * A recovered remote job may retire its maintenance ownership only when four
 * independent facts hold, each recorded by a different asynchronous actor:
 *
 * - `executorTerminated` — the provider's terminal event carried an executor
 *   teardown proof bound to THIS job and peer. Public terminal status alone does
 *   not prove physical teardown.
 * - `inputsDisposable` — the provider allows disposing the staged inputs. This
 *   can also mean "never submitted", so it never certifies termination of a
 *   previously admitted peer job.
 * - `terminalDurable` — the terminal snapshot was persisted. A watchdog can win
 *   this row before the provider's later verdict arrives.
 * - `ownedInputsCleaned` — every owned source-audio input was discarded under
 *   the captured permit, with a verified receipt.
 *
 * The record is transient: it lives in the lifecycle closure and the lane
 * finalizer only, and never enters persisted job state, route projections or
 * federated responses. Every operation here is synchronous; persistence,
 * cleanup, provider waits and permit effects stay at their call sites.
 */

import { isRemoteMediaJob } from './remoteMediaJob.js';

const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'];

export const createRecoveryEvidence = () => ({
  executorTerminated: false,
  inputsDisposable: false,
  terminalDurable: false,
  ownedInputsCleaned: false,
});

// The proof is created by the executor only after teardown (see
// federatedMedia/remoteExecutor.js); it must name this job, its peer and a
// terminal remote job, and only a reconciling recovery can be certified by it.
const certifiesExecutorTermination = (job, proof) => isRemoteMediaJob(job)
  && job.params?.remoteMedia?.reconcile === true
  && proof?.jobId === job.id && proof?.peerId === job.params.remoteMedia.peerId
  && typeof proof?.remoteJobId === 'string' && proof.remoteJobId.length > 0
  && TERMINAL_STATUSES.includes(proof.status) && proof.executorSettled === true;

// Each provider terminal event replaces the previous verdict: the latest real
// provider event is the one that describes physical settlement.
export function observeProviderTerminal(evidence, job, payload) {
  evidence.inputsDisposable = payload.remoteInputsDisposable === true;
  evidence.executorTerminated = certifiesExecutorTermination(job, payload.remoteRecoverySettlement);
}

export function recordTerminalDurable(evidence) {
  evidence.terminalDurable = true;
}

export function recordOwnedInputCleanup(evidence, cleaned) {
  evidence.ownedInputsCleaned = cleaned === true;
}

// Lifecycle evidence alone is sufficient, not final: the archive/queue flush
// that follows the lifecycle is still required before recovery completes.
const lifecycleCertifiesRecovery = (evidence) => evidence?.executorTerminated === true
  && evidence.inputsDisposable === true && evidence.terminalDurable === true
  && evidence.ownedInputsCleaned === true;

export const OWNERSHIP_RELEASE = Object.freeze({
  // Final persistence failed: keep ownership and mark it uncertain.
  UNSETTLED: 'unsettled',
  // Verified recovery: retire the exact observed uncertain operation.
  COMPLETE_RECOVERY: 'complete-recovery',
  // Ordinary finish, which deliberately preserves uncertain operations.
  FINISH: 'finish',
});

// `evidence` is null when the lifecycle threw before returning any.
export function decideOwnershipRelease({ evidence, flushed, canCompleteRecovery }) {
  if (!flushed) return OWNERSHIP_RELEASE.UNSETTLED;
  if (canCompleteRecovery && lifecycleCertifiesRecovery(evidence)) return OWNERSHIP_RELEASE.COMPLETE_RECOVERY;
  return OWNERSHIP_RELEASE.FINISH;
}
