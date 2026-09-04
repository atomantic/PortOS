import { Link } from 'react-router';

/**
 * Where a claim's reviewer list came from, in one sentence.
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
  if (source === 'task-override') {
    return (
      <>
        {' — from the '}<strong className="text-port-warning">claim-work</strong>{' reviewer override in '}
        <Link to="/cos/schedule" className="text-port-accent hover:underline">Chief of Staff → Schedule</Link>
        {', not Models → Code Reviewers. Clear it there to follow the install default again.'}
      </>
    );
  }
  return (
    <>
      {' — from '}
      <Link to="/models/code-reviewers" className="text-port-accent hover:underline">Models → Code Reviewers</Link>.
    </>
  );
}
