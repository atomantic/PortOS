import { useState, useCallback, useId } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { ISSUE_AUTHOR_FILTER_OPTIONS } from '../cos/constants';
import { WORK_TRACKER_LABELS, workItemNoun } from './constants';
import * as api from '../../services/api';

// Trackers with an author gate — PLAN.md items and JIRA sprint tickets have none.
const TRACKERS_WITH_AUTHOR_FILTER = new Set(['github', 'gitlab']);

// Why the tracker returned nothing to pick, in the user's terms. Sentence-form
// because these render standalone; the sibling map in hooks/useOnDemandTaskToast.js
// glosses the same sentinels as noun phrases for its "…: no claimable issues"
// toast, so a NEW server-side reason is worth adding to both.
const EMPTY_REASONS = {
  'no-repo-path': 'This app has no repo path configured.',
  'no-plan': 'No PLAN.md found in the repo.',
  'no-actionable-plan-items': 'Every PLAN.md item is checked, blocked, or already claimed.',
  'no-open-issues': 'The tracker has no open issues.',
  'no-authored-issues': 'Open issues exist, but none match the author filter — widen it to see them.',
  'no-actionable-issues': 'Every open issue is assigned, blocked, in flight, or an epic.',
  'owner-is-org': 'The repo owner is an organization, which never authors issues — switch the filter to "Any author".',
  'owner-is-group': 'The project namespace is a group, which never authors issues — switch the filter to "Any author".',
  'jira-not-configured': 'JIRA is not configured for this app.',
  'no-open-tickets': 'No unstarted tickets in the current sprint.',
  'no-detector': 'PortOS can\'t list this tracker\'s items — the agent can still pick one.'
};

const SELECT_CLASS = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]';

/** Sentinel-aware empty copy: never collapse "couldn't reach it" into "nothing to do". */
function emptyMessage(work) {
  if (work.transient) return `Couldn't reach the tracker (${work.reason}) — retry, or let the agent decide.`;
  return EMPTY_REASONS[work.reason] || `Nothing to pick (${work.reason || 'unknown'}).`;
}

/**
 * "Let the agent decide" vs "pick a specific item" for a `/do:next` run, plus
 * the item list itself. The list is only fetched once the user asks to pick —
 * the default run needs no forge round-trip.
 *
 * Controlled by the parent through `onChange({ mode, target, issueAuthorFilter })`.
 * `mode` is `'pick'` or `'auto'`; in `'pick'` mode `target` stays `''` until the
 * user selects an item, which is what lets the parent block submission rather
 * than silently falling back to an agent-picked run.
 */
export default function WorkItemPicker({ appId, target, onChange }) {
  const filterId = useId();
  const [pickSpecific, setPickSpecific] = useState(false);
  const [authorFilter, setAuthorFilter] = useState('');
  const [work, setWork] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadWork = useCallback(async (filter) => {
    setLoading(true);
    setError('');
    const data = await api.getAppWorkItems(appId, { issueAuthorFilter: filter || undefined })
      .catch((err) => {
        setError(err.message || 'Failed to load work items');
        return null;
      });
    setLoading(false);
    if (!data) return;
    setWork(data);
    // Adopt the server's effective filter so the select shows what was scanned.
    if (data.issueAuthorFilter) setAuthorFilter(data.issueAuthorFilter);
    // A pick from a previous (wider) filter must not survive a narrower scan.
    const items = data.items || [];
    onChange({
      mode: 'pick',
      target: items.some(i => i.ref === target) ? target : '',
      issueAuthorFilter: data.issueAuthorFilter || filter || ''
    });
  }, [appId, target, onChange]);

  // Load from the radio handler rather than an effect: "fetch once when the user
  // opts in" is structural here, so no request-guard state is needed.
  const choosePick = () => {
    setPickSpecific(true);
    onChange({ mode: 'pick', target, issueAuthorFilter: authorFilter });
    if (!work && !loading) loadWork(authorFilter);
  };

  const chooseAuto = () => {
    setPickSpecific(false);
    onChange({ mode: 'auto', target: '', issueAuthorFilter: authorFilter });
  };

  const changeFilter = (value) => {
    setAuthorFilter(value);
    setWork(null);
    loadWork(value);
  };

  const tracker = work?.tracker;
  const noun = workItemNoun(tracker);
  const items = work?.items || [];

  return (
    <section className="space-y-3">
      <div className="text-xs text-gray-500 uppercase tracking-wide">Work item</div>
      <div className="flex flex-col gap-2">
        <label className="flex items-start gap-2 cursor-pointer select-none">
          <input
            type="radio"
            name="do-next-scope"
            checked={!pickSpecific}
            onChange={chooseAuto}
            className="mt-1 w-4 h-4 border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
          />
          <span className="text-sm text-gray-300">
            Let the agent decide
            <span className="block text-xs text-gray-500">Claims the next eligible item from this app&apos;s work tracker.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer select-none">
          <input
            type="radio"
            name="do-next-scope"
            checked={pickSpecific}
            onChange={choosePick}
            className="mt-1 w-4 h-4 border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
          />
          <span className="text-sm text-gray-300">
            Pick a specific {noun}
            <span className="block text-xs text-gray-500">Pins the run to one item from PLAN.md / GitHub / GitLab / JIRA.</span>
          </span>
        </label>
      </div>

      {pickSpecific && (
        <div className="space-y-3 pl-6">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500">
              Tracker: <span className="text-gray-300">{WORK_TRACKER_LABELS[tracker] || (loading ? 'resolving…' : 'unknown')}</span>
            </span>
            <button
              type="button"
              onClick={() => loadWork(authorFilter)}
              disabled={loading}
              className="flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded-lg text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Refresh
            </button>
          </div>

          {TRACKERS_WITH_AUTHOR_FILTER.has(tracker) && (
            <div>
              <label htmlFor={filterId} className="block text-xs text-gray-500 mb-1">Author filter</label>
              <select
                id={filterId}
                value={authorFilter}
                onChange={e => changeFilter(e.target.value)}
                className={SELECT_CLASS}
              >
                {ISSUE_AUTHOR_FILTER_OPTIONS.map(o => (
                  <option key={o.value} value={o.value} title={o.description}>{o.label}</option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="text-xs text-port-error">{error}</p>}
          {!error && !loading && work && items.length === 0 && (
            <p className="text-xs text-port-warning">{emptyMessage(work)}</p>
          )}
          {items.length > 0 && (
            <div className="max-h-64 overflow-y-auto border border-port-border rounded-lg divide-y divide-port-border">
              {items.map(item => (
                <label
                  key={item.ref}
                  className="flex items-start gap-2 p-2 cursor-pointer select-none hover:bg-port-bg/60 transition-colors"
                >
                  <input
                    type="radio"
                    name="do-next-item"
                    checked={target === item.ref}
                    onChange={() => onChange({ mode: 'pick', target: item.ref, issueAuthorFilter: authorFilter })}
                    className="mt-1 w-4 h-4 border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
                  />
                  <span className="min-w-0">
                    <span className="text-xs font-mono text-port-accent">{item.ref}</span>
                    <span className="block text-sm text-gray-300 break-words">{item.title || '(no title)'}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
