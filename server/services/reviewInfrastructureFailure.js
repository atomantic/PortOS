/**
 * Infrastructure failures are operator work, never a reason to send public
 * content to another provider. Only server-owned failure codes cross into the
 * investigation queue; no PR text, model output, or transport errors do.
 */
import { investigationFingerprint } from '../lib/investigationTasks.js';

const DIAGNOSES = Object.freeze({
  'public-review-provider-pin-unavailable': 'The selected PR review provider is missing, disabled, or cannot enforce a tool-free review.',
  'public-review-provider-unavailable': 'The selected PR review provider is unavailable.',
  'public-review-no-eligible-provider': 'No enabled provider can enforce the requested PR review mode.',
  'public-review-model-pin-unavailable': 'The selected PR review model is unavailable on its configured provider.',
  'public-review-provider-unsupported': 'The selected provider cannot enforce a tool-free PR review.',
  'public-review-model-required': 'The local PR review stage has no selected model.',
  'public-review-runtime-unsupported': 'The selected local runtime cannot run this PR review stage.',
  'public-review-model-catalog-unavailable': 'The local model catalog could not be read.',
  'public-review-model-not-installed': 'The selected local review model is not installed.',
  'public-review-model-not-tool-free': 'The selected local model cannot perform a tool-free review.',
  'public-review-model-unsupported': 'The selected local model could not be validated for PR review.',
  'security-guard-input-failed': 'The local abuse classifier could not receive its input.',
  'security-guard-not-ready': 'The local abuse classifier is not ready.',
  'security-guard-process-failed': 'The local abuse classifier process failed.',
  'security-guard-timeout': 'The local abuse classifier timed out.',
  'security-guard-verdict-invalid': 'The local abuse classifier returned an invalid verdict.',
});

let reportTail = Promise.resolve();

export function reportReviewInfrastructureFailure({ code, task } = {}) {
  if (typeof code !== 'string' || !Object.hasOwn(DIAGNOSES, code)) return Promise.resolve(null);
  const run = reportTail.then(() => reportFailure(code, task));
  reportTail = run.catch(() => {});
  return run;
}

async function reportFailure(code, task) {
  const { fileInvestigationTask, readAllTasksFlat, investigationCircuitOpen } = await import('./investigationTaskProducer.js');
  const { addNotification, exists, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('./notifications.js');
  const fingerprint = investigationFingerprint({ category: code, kind: 'review-infrastructure', scope: task?.metadata?.app });
  const backlog = await readAllTasksFlat().catch(() => null);
  let investigation = backlog?.find(candidate =>
    ['pending', 'in_progress', 'challenged', 'blocked'].includes(candidate.status)
    && candidate.metadata?.investigationFingerprint === fingerprint) || null;
  if (backlog && !investigation && !investigationCircuitOpen()) {
    // No affectedTasks: repairing infrastructure must not automatically replay
    // stale contributor evidence. Retry PR review through a fresh security scan.
    const filed = await fileInvestigationTask({
      fingerprint,
      priority: 'HIGH',
      description: `[Auto] Investigate PR review infrastructure [${fingerprint}]

${DIAGNOSES[code]}

Inspect the installed Abuse Guard and PR review stage settings, provider routing, runtime readiness and model availability. Reproduce with a trusted synthetic canary, repair the cause, and verify the configured local route. Do not fetch contributor content or read the failed review transcript. Do not replace the selected route with a subscription provider, disable screening, or loosen tool restrictions. Report the diagnosis and validation to the user. After repair, PR review must be retried through a fresh security scan.`,
    }).catch(() => null);
    investigation = filed?.task || null;
  }
  const incident = investigation?.id || code;
  if (!await exists(NOTIFICATION_TYPES.AGENT_WARNING, 'reviewInfrastructureIncident', incident)) {
    await addNotification({
      type: NOTIFICATION_TYPES.AGENT_WARNING,
      priority: PRIORITY_LEVELS.HIGH,
      title: 'PR review infrastructure needs attention',
      description: `${DIAGNOSES[code]} Review stopped without provider fallback. ${investigation ? 'An investigation is queued in CoS.' : 'The investigation could not be queued; check the CoS queue and retry.'}`,
      link: '/cos',
      metadata: { reviewInfrastructureIncident: incident, failureCode: code },
    });
  }
  return investigation;
}
