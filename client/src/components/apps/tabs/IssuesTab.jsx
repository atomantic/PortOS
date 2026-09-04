import { useState, useEffect, useCallback, useMemo, useId, useRef } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle, Bot, ChevronDown, ChevronRight, CircleDot, ClipboardCheck,
  ExternalLink, Loader2, MessageSquare, RefreshCw, Rocket, Search, Tag, User
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import Banner from '../../ui/Banner';
import Pill from '../../ui/Pill';
import toast from '../../ui/Toast';
import ProviderModelSelector from '../../ProviderModelSelector';
import { useThemeContext } from '../../ThemeContext';
import { useCosTaskUpdates } from '../../../hooks/useCosTaskUpdates';
import useProviderModels from '../../../hooks/useProviderModels';
import useClaimReviewers from '../../../hooks/useClaimReviewers';
import ClaimReviewerSource from '../ClaimReviewerSource';
import { chipColors } from '../../../lib/chipContrast';
import { isProcessProvider } from '../../../utils/providers';
import * as api from '../../../services/api';
import { timeAgo } from '../../../utils/formatters';

const FORGE_LABEL = { github: 'GitHub', gitlab: 'GitLab' };

const RUN_STATUS_RANK = { queuing: 0, queued: 1, active: 2, completed: 3, blocked: 3 };
const RUN_STATUS_LABEL = {
  queued: 'Queued — view',
  active: 'Active — view',
  completed: 'Completed — view',
  blocked: 'Blocked — view'
};

const runStatusForTask = (status) => ({
  pending: 'queued',
  in_progress: 'active',
  completed: 'completed',
  blocked: 'blocked'
}[status] || null);

// The two per-issue agent runs this tab can launch. Both POST the same
// `/tasks/slashdo` shape — a slashdo command pinned to one issue via `target` —
// and differ only in which command, which task-metadata key carries the pinned
// issue back over the socket, and how the row reads.
//
// They are tracked as SEPARATE runs (the state map is keyed `<action>:<number>`,
// and the server persists `claimTarget` / `replanTarget` under distinct keys) so
// replanning an issue never disables its Claim button, and neither run's
// lifecycle events can light up the other's.
// Every message this tab prints about a run is "<verb> #42 <happened>", so the
// per-action table carries only the two words that vary — the imperative the
// button promises and the noun the notice names it by — and one formatter
// renders all four sentences from them. A third action supplies two strings.
const runMessages = ({ verb, noun }) => ({
  queued: (number) => `Queued a CoS agent to ${verb} #${number}`,
  failed: (number) => `Failed to queue a ${verb} for #${number}`,
  transition: (number, to) => ({
    active: `${noun} #${number} is now active`,
    completed: `${noun} #${number} completed`,
    blocked: `${noun} #${number} was blocked`
  }[to])
});

const ISSUE_ACTIONS = {
  replan: {
    command: 'replan',
    targetKey: 'replanTarget',
    label: 'Replan',
    icon: ClipboardCheck,
    tone: 'bg-port-border/60 text-gray-300 enabled:hover:bg-port-border',
    title: (number) => `Queue a CoS agent to review the plan on issue #${number} and comment its refinements — it writes no code`,
    ...runMessages({ verb: 'replan', noun: 'Replan of' })
  },
  claim: {
    command: 'next',
    targetKey: 'claimTarget',
    label: 'Claim',
    icon: Rocket,
    tone: 'bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30',
    title: (number, appName) => `Queue a CoS agent to claim issue #${number} for ${appName}`,
    ...runMessages({ verb: 'claim', noun: 'Claim' })
  }
};

// Buttons render in table order — no second list to keep in sync.
const ACTION_ORDER = Object.keys(ISSUE_ACTIONS);

/** Run-map key. One issue can carry an independent run per action. */
const runKey = (action, issueNumber) => `${action}:${issueNumber}`;

/** Split a run key back into its action + issue number (as a string). */
function parseRunKey(key) {
  const at = key.indexOf(':');
  return { action: key.slice(0, at), issueNumber: key.slice(at + 1) };
}

// Module-scoped so `useProviderModels` sees a stable predicate — an inline
// arrow would be a new identity every render, re-firing the hook's fetch
// effect forever. Matches SlashDoRunDrawer's filter: only CODING providers
// (CLI/TUI agents with a file-writing harness) can run a `/do:next` claim.
const enabledProcessProviderFilter = (p) => Boolean(p?.enabled) && isProcessProvider(p);

// `in-progress` is the forge label a `/do:next` claim stamps on an issue it is
// actively working (server/services/issueReconcile.js#IN_PROGRESS_LABEL), and
// `blocked` marks work that should not be picked up by default. Those rows
// aren't useful claim candidates, so the tab hides them until the user toggles
// the chip back on.
const DEFAULT_HIDDEN_LABELS = ['blocked', 'in-progress'];

const defaultLabelFilter = () => ({
  mode: 'exclude',
  names: new Set(DEFAULT_HIDDEN_LABELS),
});

/** Exclude: drop any issue that carries a named label. Include: keep only issues that carry at least one named label. */
function issuePassesLabelFilter(issue, { mode, names }) {
  const labels = issue.labels || [];
  if (mode === 'include') return labels.some(l => names.has(l.name));
  return names.size === 0 || !labels.some(l => names.has(l.name));
}

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

/**
 * Label chips carry the forge's own color, which is arbitrary per-repo data —
 * so it can't be a Tailwind class (those must be literal strings in source).
 * Render it as a tinted chip via inline style: a low-alpha wash of the label's
 * own color for the background, and `chipContrast` for the text/border, which
 * keeps the hue but moves its lightness until it clears WCAG AA on the ACTIVE
 * theme mode. Verbatim label color only ever worked on night themes — GitHub's
 * pale defaults (`plan` #fef2c0, `effort:*` #c5def5) rendered as ~1.1:1 on the
 * day themes, i.e. invisible.
 *
 * A label with no color — or a color we can't parse — gets no inline style, so
 * the chip keeps its own neutral look (the `muted` Pill tone on a row chip).
 */
function LabelChip({ label }) {
  const { theme } = useThemeContext();
  const style = chipColors(label.color, theme?.mode);
  return (
    <Pill
      size="xs"
      tone={style ? 'bare' : 'muted'}
      title={label.description || undefined}
      style={style}
    >
      {label.name}
    </Pill>
  );
}

/**
 * One label's show/hide toggle. Pressed (default) = issues carrying the label
 * are listed; un-pressed strikes the chip through and drops every issue that
 * carries it — so an issue tagged `bug` + `in-progress` disappears while
 * `in-progress` is off, which is what "hide in-progress work" has to mean.
 *
 * The count renders as a node adjacent to the name, so the computed accessible
 * name would be "bug1" — `aria-label` spells it out instead.
 *
 * NOT the shared `ui/ToggleChip`: that one is a fixed-accent pill wrapping a
 * real checkbox, which can't carry the forge's per-label color (the thing the
 * user recognizes a label by) and stacks a checkbox per chip into a row that
 * routinely runs 20+ labels wide.
 */
function LabelFilterChip({ facet, hidden, onToggle }) {
  const { theme } = useThemeContext();
  const style = hidden ? null : chipColors(facet.color, theme?.mode);
  // The theme utilities carry `!important` (index.css remaps `.bg-port-bg`,
  // `.border-port-border`, and day-mode `.text-gray-300`), and author
  // `!important` beats an inline declaration — so a chip that ships BOTH renders
  // in theme neutrals with its graded color silently dead. Emit the neutrals
  // only when there's no graded style to paint, the way `Pill tone="bare"` does.
  const neutral = hidden
    ? 'border-port-border bg-port-bg text-gray-500 line-through opacity-60 hover:opacity-100'
    : 'border-port-border bg-port-bg text-gray-300 hover:opacity-80';
  return (
    <button
      type="button"
      onClick={() => onToggle(facet.name)}
      aria-pressed={!hidden}
      aria-label={`${facet.name} (${facet.count})`}
      title={facet.description
        ? `${facet.description} — click to ${hidden ? 'show' : 'hide'} these issues`
        : `Click to ${hidden ? 'show' : 'hide'} issues labeled ${facet.name}`}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-opacity ${
        style ? 'hover:opacity-80' : neutral
      }`}
      style={style}
    >
      {facet.name}
      <span className="font-mono opacity-70">{facet.count}</span>
    </button>
  );
}

/**
 * Open issues from the app's forge (GitHub or GitLab, resolved from the git
 * `origin` remote), each with its labels, assignees, expandable description, and
 * a one-click "Claim with CoS agent" button.
 *
 * Claiming queues the SAME `/do:next` task the Agent Operations panel does,
 * pinned to this issue via `target` — so the run honors the app's configured
 * Work Tracker, worktree, and PR settings instead of a parallel code path.
 *
 * Replan is the same mechanism pointed at `replan`: a SECOND model re-derives
 * the plan on one already-planned issue (and, for an epic, its children) and
 * comments its refinements. It writes no code and claims nothing, so it is
 * offered alongside Claim rather than instead of it.
 */
export default function IssuesTab({ appId, appName }) {
  const searchId = useId();
  const overrideContextId = useId();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  // Exclude mode tracks labels to hide (a later refresh's new label stays
  // visible). Include mode — entered by Hide all labels — tracks labels to
  // keep, so turning `critical` back on lists every issue that carries it,
  // even when the issue also has labels that are still off.
  const [labelFilter, setLabelFilter] = useState(defaultLabelFilter);
  const [expanded, setExpanded] = useState(() => new Set());
  // Per-issue run lifecycle: 'queuing' while the POST is in flight, then the
  // task's live CoS state. Keyed `<action>:<issue number>` so neither one row's
  // run nor its sibling action can disable the others' buttons.
  const [runs, setRuns] = useState({});
  const runsRef = useRef({});
  // Generation guard: a forge list can take seconds, so a Refresh (or a switch to
  // a different app, which updates this component in place rather than
  // remounting it) can leave an older request in flight. Without this, that older
  // response lands last and shows one app's issues under another's Claim buttons.
  const requestRef = useRef(0);

  // Page-level provider/model/effort pin for every Claim AND Replan button on this tab —
  // left untouched (blank), a claim resolves the install's active provider,
  // same as the bare button always did (POST /tasks/slashdo -> resolveAgentProviderAndModel;
  // this manual path does NOT consult the app's scheduled claim-work override for
  // the PROVIDER — that pin is read only by the automated claim-work task).
  // Scoped to the provider deliberately: the REVIEWERS below do come from that
  // override, which is precisely the mismatch `claimReviewers` exists to surface.
  // This picker never persists across a reload; it's a session convenience for
  // "claim the next several issues with model X" without reopening the Agent
  // Operations drawer each time.
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel
  } = useProviderModels({ filter: enabledProcessProviderFilter, allowDefault: true, silent: true, withEffort: true });
  const [effort, setEffort] = useState('');
  const [overrideContext, setOverrideContext] = useState('');
  // The reviewers a Claim launched from this tab will actually run — NOT the
  // Models → Code Reviewers list, whenever a claim-work override is in play (see
  // `GET /apps/:id/claim-reviewers`). This tab has no reviewer picker, so it
  // names them read-only beside the provider pin.
  const claimReviewers = useClaimReviewers(appId);

  // Keep the event-driven path based on the latest runs without putting a
  // mutable state snapshot in its effect dependencies. Socket callbacks can
  // arrive between the POST response and the next React render.
  const replaceRuns = useCallback((updater) => {
    const next = updater(runsRef.current);
    runsRef.current = next;
    setRuns(next);
  }, []);

  useEffect(() => {
    runsRef.current = {};
    setRuns({});
    setOverrideContext('');
    setLabelFilter(defaultLabelFilter());
    setUnassignedOnly(false);
  }, [appId]);

  const applyTaskUpdate = useCallback((task) => {
    if (!task?.id) return;
    const nextStatus = runStatusForTask(task.status);
    if (!nextStatus) return;

    const currentRuns = runsRef.current;
    const nextRuns = { ...currentRuns };
    const transitions = [];

    for (const [key, rawRun] of Object.entries(currentRuns)) {
      const { action, issueNumber } = parseRunKey(key);
      const spec = ISSUE_ACTIONS[action];
      if (!spec) continue;
      const run = typeof rawRun === 'string' ? { status: rawRun } : rawRun;
      // Before the POST resolves there is no task id to match on, so fall back
      // to the durable per-action target the server stamped. Reading THIS
      // action's key is what keeps a claim's events off a replan's row.
      const matchesTask = run.taskId === task.id || (
        !run.taskId && task.metadata?.app === appId &&
        String(task.metadata?.[spec.targetKey]) === issueNumber
      );
      if (!matchesTask) continue;

      const currentStatus = run.status || 'queuing';
      if ((RUN_STATUS_RANK[nextStatus] ?? 0) < (RUN_STATUS_RANK[currentStatus] ?? 0)) continue;
      if (run.taskId === task.id && currentStatus === nextStatus) continue;

      nextRuns[key] = { ...run, taskId: run.taskId || task.id, status: nextStatus };
      transitions.push({ action, issueNumber, from: currentStatus, to: nextStatus });
    }

    if (transitions.length === 0) return;
    replaceRuns(() => nextRuns);

    for (const { action, issueNumber, from, to } of transitions) {
      if (to === from) continue;
      const message = ISSUE_ACTIONS[action].transition(issueNumber, to);
      if (!message) continue;
      if (to === 'active') toast(message, { icon: '▶️' });
      else if (to === 'completed') toast.success(message);
      else if (to === 'blocked') toast.error(message);
    }
  }, [appId, replaceRuns]);

  useCosTaskUpdates(applyTaskUpdate);

  const load = useCallback(async () => {
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    const isCurrent = () => requestRef.current === generation;

    setLoading(true);
    setError('');
    const result = await api.getAppIssues(appId).catch(err => {
      if (isCurrent()) setError(err?.message || 'Failed to load issues');
      return null;
    });
    if (!isCurrent()) return;
    setLoading(false);
    // A failed refresh keeps the last good list rather than blanking it.
    if (result) setData(result);
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  // Lowercase each issue's searchable text ONCE per fetch, not once per
  // keystroke: bodies are capped at 8000 chars and the list at 200 issues, so
  // re-deriving inside the filter churned up to 1.6 MB of throwaway strings on
  // every character typed. Digits are case-invariant, so the issue number folds
  // into the same haystack.
  const haystacks = useMemo(() => (data?.issues || []).map(issue => ({
    issue,
    hay: [
      String(issue.number),
      issue.title,
      issue.body || '',
      issue.labels.map(l => l.name).join(' '),
      issue.assignees.join(' ')
    ].join('\n').toLowerCase()
  })), [data]);

  // Every label present on the fetched issues, with how many issues carry it,
  // alphabetical so the chip row doesn't reshuffle between refreshes.
  const labelFacets = useMemo(() => {
    const byName = new Map();
    for (const issue of data?.issues || []) {
      for (const label of issue.labels || []) {
        const seen = byName.get(label.name);
        if (seen) seen.count += 1;
        else byName.set(label.name, { ...label, count: 1 });
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const issues = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = haystacks.filter(h =>
      issuePassesLabelFilter(h.issue, labelFilter)
      && (!unassignedOnly || h.issue.assignees.length === 0)
      && (!q || h.hay.includes(q))
    );
    return rows.map(h => h.issue);
  }, [haystacks, query, labelFilter, unassignedOnly]);

  const total = data?.issues?.length ?? 0;
  // Only labels actually on this tracker count as "filtering something" — the
  // seeded defaults must not claim to hide anything in a repo that never uses
  // them. Include mode is always a filter, even with an empty keep-set.
  const hidingByLabel = labelFilter.mode === 'include'
    || labelFacets.some(f => labelFilter.names.has(f.name));
  const canHideAll = labelFilter.mode !== 'include' || labelFilter.names.size > 0;

  const toggleLabel = (name) => setLabelFilter(prev => {
    const names = new Set(prev.names);
    if (names.has(name)) names.delete(name); else names.add(name);
    return { mode: prev.mode, names };
  });

  const hideAllLabels = () => setLabelFilter({ mode: 'include', names: new Set() });
  const showAllLabels = () => setLabelFilter({ mode: 'exclude', names: new Set() });
  const labelChipHidden = (name) => (labelFilter.mode === 'include'
    ? !labelFilter.names.has(name)
    : labelFilter.names.has(name));

  const toggleExpanded = (number) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(number)) next.delete(number); else next.add(number);
    return next;
  });

  // One launcher for both per-issue actions: they POST the same body to the same
  // endpoint and differ only in the slashdo command. Keeping them on one path is
  // what guarantees the provider pin, override context, and prefetched issue
  // content reach a replan exactly as they reach a claim.
  const handleRun = async (issue, action) => {
    const spec = ISSUE_ACTIONS[action];
    const key = runKey(action, issue.number);
    replaceRuns(prev => ({ ...prev, [key]: { status: 'queuing', taskId: null } }));
    const trimmedOverrideContext = overrideContext.trim();
    const result = await api.createSlashdoTask(spec.command, appId, {
      target: String(issue.number),
      issueContext: {
        number: issue.number,
        title: issue.title || '',
        body: issue.body || '',
        ...(issue.url ? { url: issue.url } : {})
      },
      provider: selectedProviderId || undefined,
      model: selectedModel || undefined,
      effort: effort || undefined,
      ...(trimmedOverrideContext ? { overrideContext: trimmedOverrideContext } : {}),
    }, { silent: true })
      .catch(err => {
        toast.error(err?.message || spec.failed(issue.number));
        return null;
      });
    if (!result) {
      replaceRuns(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    replaceRuns(prev => {
      const current = prev[key];
      const currentStatus = typeof current === 'string' ? current : current?.status;
      const resultStatus = runStatusForTask(result.status) || 'queued';
      const status = (RUN_STATUS_RANK[resultStatus] ?? 0) >= (RUN_STATUS_RANK[currentStatus] ?? 0)
        ? resultStatus
        : currentStatus;
      return {
        ...prev,
        [key]: {
          ...(typeof current === 'object' ? current : {}),
          status,
          taskId: current?.taskId || result.id || null
        }
      };
    });
    toast.success(spec.queued(issue.number));
  };

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
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-semibold text-white">
          {forgeLabel} Issues
          {data?.fullName && <span className="ml-2 text-xs font-mono text-gray-500">{data.fullName}</span>}
        </h3>
        {total > 0 && (
          <span className="text-xs text-gray-500">
            {issues.length === total ? `${total} open` : `${issues.length} of ${total} open`}
          </span>
        )}
        <button
          type="button"
          onClick={() => setUnassignedOnly(prev => !prev)}
          aria-pressed={unassignedOnly}
          title={unassignedOnly ? 'Show assigned issues too' : 'Show only issues without assignees'}
          className={`px-3 py-1.5 rounded-lg text-xs border flex items-center gap-1.5 transition-colors ${unassignedOnly
            ? 'bg-port-accent/20 text-port-accent border-port-accent/40'
            : 'bg-port-bg text-gray-400 border-port-border hover:text-white'
          }`}
        >
          <User size={13} /> Unassigned only
        </button>
        <div className="relative ml-auto">
          <label htmlFor={searchId} className="sr-only">Filter issues</label>
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by title, label, assignee…"
            className="w-full sm:w-72 pl-8 pr-3 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
          />
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {labelFacets.length > 0 && (
        <div
          role="group"
          aria-label="Label filters"
          className="flex flex-wrap items-center gap-1.5 px-3 py-2 bg-port-card border border-port-border rounded-lg"
        >
          <span className="flex items-center gap-1.5 text-xs text-gray-500 uppercase tracking-wide shrink-0">
            <Tag size={14} /> Labels
          </span>
          {labelFacets.map(facet => (
            <LabelFilterChip
              key={facet.name}
              facet={facet}
              hidden={labelChipHidden(facet.name)}
              onToggle={toggleLabel}
            />
          ))}
          {(canHideAll || hidingByLabel) && (
            <div className="ml-auto flex items-center gap-3">
              {canHideAll && (
                <button
                  type="button"
                  onClick={hideAllLabels}
                  className="text-xs text-gray-500 hover:text-port-accent transition-colors"
                >
                  Hide all labels
                </button>
              )}
              {hidingByLabel && (
                <button
                  type="button"
                  onClick={showAllLabels}
                  className="text-xs text-gray-500 hover:text-port-accent transition-colors"
                >
                  Show all labels
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-3 px-3 py-2 bg-port-card border border-port-border rounded-lg">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-gray-500 uppercase tracking-wide shrink-0">
            <Bot size={14} /> Run with
          </span>
          <div className="flex-1">
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={(id) => { setSelectedProviderId(id); setEffort(''); }}
              onModelChange={setSelectedModel}
              effort={effort}
              onEffortChange={setEffort}
              emptyProviderOption="Auto (default)"
              emptyModelOption="Default model"
              compact
              highlightToolUse
            />
          </div>
        </div>
        {claimReviewers && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-gray-500 uppercase tracking-wide shrink-0">
              <ClipboardCheck size={14} /> Reviewed by
            </span>
            {/* No empty-list branch: the route resolves through
                `claimSafeReviewers`, which falls back to a non-empty list rather
                than ever handing a claim agent nothing to run. */}
            <p className="flex-1 text-xs text-gray-400">
              <code className="text-gray-300">{claimReviewers.csv}</code>
              <ClaimReviewerSource source={claimReviewers.source} />
            </p>
          </div>
        )}
        <div className="space-y-1">
          <label htmlFor={overrideContextId} className="block text-xs text-gray-400">
            Override context or instructions <span className="text-gray-600">(optional)</span>
          </label>
          <textarea
            id={overrideContextId}
            value={overrideContext}
            onChange={e => setOverrideContext(e.target.value)}
            maxLength={4000}
            rows={2}
            placeholder="Add guidance for the run you launch below, such as a preferred implementation focus…"
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm placeholder:text-gray-600 focus:border-port-accent focus:outline-hidden resize-y"
          />
          <p className="text-xs text-gray-600">
            Applies to every Claim and Replan you launch below — appended to that run&apos;s instructions; blank leaves its prompt unchanged.
          </p>
        </div>
      </div>

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

      {!error && !unavailable && total === 0 && (
        <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg">
          {EMPTY_REASONS[data?.reason] ?? EMPTY_REASONS['no-open-issues']}
        </div>
      )}

      {/* A failed REFRESH deliberately shows the error banner above AND the last
          good list below — blanking issues the user was reading is worse than
          showing them alongside a "couldn't refresh" notice. */}
      {issues.length === 0 && total > 0 && (
        <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg">
          {query.trim()
            ? <>No open issues match &ldquo;{query}&rdquo;{hidingByLabel ? ' with the current label filters' : ''}.</>
            : unassignedOnly
              ? <>No unassigned open issues{hidingByLabel ? ' match the current label filters' : ''}.</>
              : 'No open issues match the current label filters.'}
        </div>
      )}

      {issues.length > 0 && (
        <div className="border border-port-border rounded-lg divide-y divide-port-border overflow-hidden">
          {issues.map(issue => {
            const isOpen = expanded.has(issue.number);
            return (
              <div key={issue.number} className="bg-port-card">
                <div className="flex flex-col sm:flex-row sm:items-start gap-3 p-3">
                  <button
                    onClick={() => toggleExpanded(issue.number)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} description for issue ${issue.number}`}
                    className="hidden sm:flex text-gray-500 hover:text-white transition-colors mt-0.5 shrink-0"
                  >
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <CircleDot size={14} className="text-port-success shrink-0 self-center" />
                      <span className="text-xs font-mono text-gray-500">#{issue.number}</span>
                      <button
                        onClick={() => toggleExpanded(issue.number)}
                        aria-expanded={isOpen}
                        className="text-sm text-white text-left hover:text-port-accent transition-colors break-words"
                      >
                        {issue.title || '(no title)'}
                      </button>
                      {issue.url && (
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open issue ${issue.number} on ${forgeLabel}`}
                          className="text-gray-500 hover:text-port-accent transition-colors self-center"
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>

                    {issue.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-gray-500">
                      {issue.author && <span>opened by {issue.author}</span>}
                      {issue.updatedAt && <span>updated {timeAgo(issue.updatedAt)}</span>}
                      {issue.milestone && <span className="text-cyan-400">{issue.milestone}</span>}
                      {issue.commentCount > 0 && (
                        <span className="flex items-center gap-1">
                          <MessageSquare size={12} /> {issue.commentCount} comment{issue.commentCount === 1 ? '' : 's'}
                        </span>
                      )}
                      {issue.assignees.length > 0 ? (
                        <span className="flex items-center gap-1 text-gray-300">
                          <User size={12} /> {issue.assignees.join(', ')}
                        </span>
                      ) : (
                        <span className="italic">unassigned</span>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center gap-2">
                    {ACTION_ORDER.map(action => {
                      const spec = ISSUE_ACTIONS[action];
                      const run = runs[runKey(action, issue.number)];
                      const state = typeof run === 'string' ? run : run?.status;
                      const Icon = spec.icon;
                      // A launched run swaps its button for a link to the agent
                      // queue: the run is no longer this row's to start, and the
                      // one thing the user wants next is to watch it.
                      if (state && state !== 'queuing') {
                        return (
                          <Link
                            key={action}
                            to="/cos/agents"
                            aria-label={`${spec.label} #${issue.number}: ${RUN_STATUS_LABEL[state] || 'Queued — view'}`}
                            className="px-3 py-1.5 bg-port-success/20 text-port-success hover:bg-port-success/30 border border-port-border rounded-lg text-xs flex items-center gap-1.5 transition-colors"
                          >
                            <Icon size={14} /> {spec.label} · {RUN_STATUS_LABEL[state] || 'Queued — view'}
                          </Link>
                        );
                      }
                      return (
                        <button
                          key={action}
                          onClick={() => handleRun(issue, action)}
                          disabled={state === 'queuing'}
                          title={spec.title(issue.number, appName)}
                          className={`px-3 py-1.5 ${spec.tone} border border-port-border rounded-lg text-xs flex items-center gap-1.5 disabled:opacity-50 transition-colors`}
                        >
                          {state === 'queuing'
                            ? <Loader2 size={14} className="animate-spin" />
                            : <Icon size={14} />}
                          {state === 'queuing' ? 'Queuing…' : spec.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {isOpen && (
                  <div className="px-3 pb-3 sm:pl-10">
                    {issue.body?.trim() ? (
                      <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words font-sans bg-port-bg border border-port-border rounded-lg p-3 max-h-96 overflow-auto">
                        {issue.body}
                      </pre>
                    ) : (
                      <p className="text-xs text-gray-500 italic">No description.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
