import { ServerError } from '../lib/errorHandler.js';

/** Check the resolved roster before any claim prompt is rendered. */
export async function preflightClaimReviewers(app, config, { metadata = {}, appOverrideMetadata = {}, explicit = {}, taskType = 'claim-work' } = {}) {
  if (!config.usernames.length && !config.optionalReviewers.some(r => r.startsWith('@'))) return '';
  // Keep forge I/O out of the common local-reviewer-only dispatch graph.
  const { resolveAppForgeTarget } = await import('../lib/workTracker.js');
  const { target } = await resolveAppForgeTarget(app);
  if (!target) return ''; // An unresolved target is not proof an identity is missing.
  const { preflightReviewerIdentities } = await import('./reviewerIdentity.js');
  const result = await preflightReviewerIdentities({
    usernames: config.usernames,
    optionalReviewers: config.optionalReviewers,
    forge: target.forge,
    host: target.apiHost,
  });
  const describe = entry => {
    const field = config.usernames.some(u => u.toLowerCase() === entry.token.toLowerCase())
      ? 'usernames' : 'optionalReviewers';
    const setting = Array.isArray(explicit[field])
      ? `the claim request (${field})`
      : Array.isArray(appOverrideMetadata[field])
        ? `Apps → Automation → ${taskType} → Reviewers (taskMetadata.${field})`
        : Array.isArray(metadata[field])
          ? `Tasks → Schedule → ${taskType} → Reviewers (taskMetadata.${field})`
          : `Settings → Code Reviewers (${field})`;
    return `@${entry.token}: ${entry.reason}. Repair the @${entry.token} entry in ${setting}.`;
  };
  if (result.requiredMissing.length) {
    throw new ServerError(`Claim dispatch blocked: required reviewer identity configuration fault. ${result.requiredMissing.map(describe).join(' ')}`, {
      status: 409,
      code: 'REVIEWER_IDENTITY_NOT_FOUND',
      context: { reviewers: result.requiredMissing.map(e => e.token) },
    });
  }
  if (!result.optionalMissing.length) return '';
  return `\n\n## Reviewer identity preflight\n${result.optionalMissing.map(describe).join(' ')} These reviewers remain optional and were not verified as available. Report this configuration fault in the run summary; do not change the saved roster.\n`;
}
