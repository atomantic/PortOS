import { Link } from 'react-router';
import { getNavPageForPath } from '../../../../server/lib/navManifest.js';

/**
 * Where a claim's reviewer list came from, as one compact link.
 *
 * Shared by the two manual claim surfaces because they were already drifting on
 * the answer: a claim resolves the claim-work task metadata FIRST and only falls
 * back to the install-wide Code Review Defaults, so a user who changed the
 * defaults and sees a different chain needs to be sent to whichever one is
 * actually supplying it — and being sent to the wrong panel is the same class of
 * confusion as not being told at all.
 *
 * The link target is deliberate and verified: the reviewer picker (and the "Use
 * system Code Review Defaults" reset beside it) is rendered ONLY by
 * `GlobalConfigControls`, reachable only through Chief of Staff → Schedule's
 * TaskConfigDrawer. The per-app `claim-work` override the server merges on top
 * carries reviewer keys too, but the app's Automation tab has no picker for
 * them — naming it here would send the user to a screen with no such control.
 */
export default function ClaimReviewerSource({ source }) {
  const override = source === 'task-override';
  return (
    <>
      {' · '}
      <Link
        to={override ? '/cos/schedule' : '/models/code-reviewers'}
        title={override
          ? `Set by the claim-work reviewer override in Chief of Staff → Schedule, not ${getNavPageForPath('/models/code-reviewers')?.breadcrumb || 'Code Reviewers'}.`
          : undefined}
        className={`hover:underline ${override ? 'text-port-warning' : 'text-port-accent'}`}
      >
        {override ? 'claim-work override' : 'defaults'}
      </Link>
    </>
  );
}
