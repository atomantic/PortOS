import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import Banner from '../../ui/Banner';
import toast from '../../ui/Toast';
import { syncGithubThreads } from '../../../services/apiBrainThreads.js';
import { getAppIssues } from '../../../services/apiApps.js';
import { formatCount } from '../../../utils/formatters';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import IssueFilterToolbar, { IssueFilterEmptyState, IssueLabelFilters, useIssueFilters } from './IssueFilterToolbar';
import IssueRunSettingsBar, { useIssueRunSettings } from './IssueRunSettingsBar';
import IssueRow from './IssueRow';
import useIssueRuns, { runKey } from './useIssueRuns';

const FORGE_LABEL = { github: 'GitHub', gitlab: 'GitLab' };
// Why the forge returned nothing, in the user's terms. Sentinel-aware: a
// definitive "no open issues" and a failed probe are different sentences, so an
// unreachable CLI can never read as an empty tracker.
const EMPTY_REASONS = {
  'no-repo-path': 'This app has no repo path configured.',
  'unsupported-forge': 'This app\'s git origin isn\'t GitHub or GitLab, so there are no forge issues to list.',
  'tracker-not-a-forge': 'This app\'s Work Tracker isn\'t a forge issue tracker, so a claim here wouldn\'t touch forge issues. Change it under Edit App → Workflow.',
  'tracker-forge-mismatch': 'This app\'s Work Tracker is pinned to a different forge than its git origin, so neither list would match what a claim runs against. Reconcile them under Edit App → Workflow.',
  'no-open-issues': 'No open issues on this tracker.'
};

export default function IssuesTab({ appId, appName }) {
  const [trackAssigned, trackingAssigned] = useAsyncAction(async () => {
    const result = await syncGithubThreads({ appId }, { silent: true });
    const summary = `${appName}: ${formatCount(result.created)} threads added, ${formatCount(result.updated)} updated`;
    if (result.possiblyTruncated) toast(`${summary}. More assigned issues may exist beyond this batch.`, { icon: '⚠️' });
    else toast.success(summary);
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  // Generation guard: a forge list can take seconds, so a Refresh (or a switch to
  // a different app, which updates this component in place rather than
  // remounting it) can leave an older request in flight. Without this, that older
  // response lands last and shows one app's issues under another's Claim buttons.
  const requestRef = useRef(0);

  const filters = useIssueFilters(appId, data);
  const { issues, total } = filters;
  const settings = useIssueRunSettings(appId);
  const { runs, handleRun } = useIssueRuns(appId, settings);

  const load = useCallback(async () => {
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    const isCurrent = () => requestRef.current === generation;

    setLoading(true);
    setError('');
    const result = await getAppIssues(appId).catch(err => {
      if (isCurrent()) setError(err?.message || 'Failed to load issues');
      return null;
    });
    if (!isCurrent()) return;
    setLoading(false);
    // A failed refresh keeps the last good list rather than blanking it.
    if (result) setData(result);
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const toggleExpanded = useCallback((number) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(number)) next.delete(number); else next.add(number);
    return next;
  }), []);

  if (loading && !data) return <BrailleSpinner text="Loading issues" />;

  const forgeLabel = FORGE_LABEL[data?.forge] || 'Issues';
  // A transient failure keeps the "couldn't ask" framing — never the lie that
  // the tracker is empty. The SENTENCE comes from the server, beside the
  // classifier that produced the reason: the reason vocabulary is open-ended
  // (`gh-${status}`), and only the classifier knows whether the forge was
  // unreachable or merely answered in a dialect we couldn't parse. A client-side
  // reason→copy table can only shadow one entry of that, which is how an
  // authenticated user got told to authenticate.
  const unavailable = data?.transient === true;

  return (
    <div className="space-y-4">
      <IssueFilterToolbar filters={filters} forgeLabel={forgeLabel} fullName={data?.fullName} load={load} loading={loading} />

      {error && (
        <Banner tone="error" size="md" icon={AlertTriangle}>
          Couldn&apos;t load issues — {error}
        </Banner>
      )}

      {!error && unavailable && (
        <Banner tone="warning" size="md" icon={AlertTriangle}>
          {data.headline || `Couldn't reach ${forgeLabel}`} ({data.reason})
          {data.remedy ? ` — ${data.remedy}.` : ''}
        </Banner>
      )}

      {data?.forge === 'github' && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button
            type="button"
            onClick={trackAssigned}
            disabled={trackingAssigned || loading}
            className="px-3 py-1.5 rounded-lg border border-port-border text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
          >
            {trackingAssigned ? 'Tracking assigned issues…' : 'Track my assigned issues in Brain'}
          </button>
          <Link to="/brain/threads" className="text-port-accent hover:underline">Open Threads</Link>
        </div>
      )}

      <IssueLabelFilters filters={filters} />
      <IssueRunSettingsBar settings={settings} />

      {!error && !unavailable && total === 0 && (
        <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg">
          {EMPTY_REASONS[data?.reason] ?? EMPTY_REASONS['no-open-issues']}
        </div>
      )}

      {issues.length === 0 && total > 0 && <IssueFilterEmptyState filters={filters} />}

      {issues.length > 0 && (
        <div className="border border-port-border rounded-lg divide-y divide-port-border overflow-hidden">
          {issues.map(issue => (
            <IssueRow
              key={issue.number}
              issue={issue}
              appId={appId}
              appName={appName}
              forge={data?.forge}
              forgeLabel={forgeLabel}
              isOpen={expanded.has(issue.number)}
              toggleExpanded={toggleExpanded}
              claimStatus={runs[runKey('claim', issue.number)]?.status}
              replanStatus={runs[runKey('replan', issue.number)]?.status}
              handleRun={handleRun}
              invalidReviewOverride={settings.invalidReviewOverride}
            />
          ))}
        </div>
      )}
    </div>
  );
}
