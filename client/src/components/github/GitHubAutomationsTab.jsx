import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Bot, Pencil, Play, Undo2, X } from 'lucide-react';
import Pill from '../ui/Pill';
import ListLoadError from '../ui/ListLoadError';
import LoadFailedState from '../ui/LoadFailedState';
import PageSkeleton from '../ui/PageSkeleton';
import { timeAgo } from '../../utils/formatters';
import socket from '../../services/socket';
import {
  deleteGitHubLearnedRule,
  getGitHubAutomationActivity,
  getGitHubAutomations,
  getGitHubLearnedRules,
  setGitHubNotificationCadence,
  syncGitHubNotifications,
  undoGitHubAutomationAction,
  updateGitHubAccount,
} from '../../services/api';
import { ACTION_LABELS, AGENT_RULE_KINDS, LEARNED_DECISION_LABELS } from './githubTriageLabels';
import GitHubAgentRules from './GitHubAgentRules';
import GitHubAgentPinForm, { describeAgentPin } from './GitHubAgentPinForm';
import useRunWithPicker from '../../hooks/useRunWithPicker';

const MODE_OPTIONS = ['disabled', 'observe', 'assist', 'autopilot'];
const MODE_LABELS = { disabled: 'Disabled', observe: 'Observe', assist: 'Assist', autopilot: 'Autopilot' };

function modeHint(account) {
  if (account.mode === 'disabled') return 'This PortOS instance does not fetch or process this account\'s notifications.';
  if (account.mode === 'observe') return 'Records a decision for each notification; changes nothing on GitHub.';
  const where = account.trust === 'private'
    ? 'Text goes only to local AI providers unless you allow others in Accounts.'
    : 'Text goes to the GitHub notifications provider in Models › LLMs › Abuse Guard.';
  const assist = `Screens and sorts notifications no rule decided, marks CI noise and closed threads done. Never acts on outside or suspect threads. ${where}`;
  if (account.mode !== 'autopilot') return assist;
  const handoff = account.trust === 'private' && !account.allowAgents
    ? 'Private accounts hand threads off only after you allow agents on them below.'
    : 'Also hands outside review requests, outside issues and security alerts in your PortOS apps to Untrusted:Review, the issue watcher and dependency updates when those are on for the app, one run per app for each. A security alert in another repo of yours starts one CoS task per repo that fixes it in a pull request and merges it. Automation rules below turn kinds on or off per repo, mark them done or muted, and pick the provider.';
  return `${assist} ${handoff}`;
}

const CADENCE_TEXT = {
  'weekdays-15m': 'Every 15 minutes on weekdays',
  custom: 'On a custom schedule (CoS › System Tasks)',
  off: 'Only when you tap Run now',
};

// A Private account's agent rules only start agents once the operator allows
// it; the switch sits beside the rules so both ways are reachable from here.
function AgentAccess({ account, onAllow, saving }) {
  if (account.trust !== 'private') return null;
  const allowed = account.allowAgents === true;
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-xs ${allowed ? 'border-port-border text-gray-400' : 'border-port-warning/40 bg-port-warning/10 text-gray-300'}`}>
      <p className="min-w-0 flex-1">
        {allowed
          ? 'Agents are allowed on this Private account. They use their own AI providers, not the ones this account allows.'
          : 'Rules here start no agent until you allow agents on this Private account. Agents use their own AI providers, which this account\'s provider list cannot limit.'}
      </p>
      <button
        type="button"
        onClick={() => onAllow(account.id, !allowed)}
        disabled={saving}
        aria-pressed={allowed}
        className={`shrink-0 rounded px-3 py-1.5 text-xs disabled:opacity-50 ${allowed ? 'border border-port-border text-gray-300' : 'bg-port-accent text-white'}`}
      >
        {allowed ? 'Stop allowing agents' : 'Allow agents on this account'}
      </button>
    </div>
  );
}

// The provider/model/effort Resolve with agent starts from on this account
// when no agent rule pins one. Each run can still pick its own.
function AgentDefaults({ account, onSave, saving }) {
  const [editing, setEditing] = useState(false);
  const { providers } = useRunWithPicker({ preselectDefaults: false });
  const defaults = account.agentDefaults || null;
  const isSet = Boolean(defaults && (defaults.provider || defaults.model || defaults.effort));
  const save = async (pin) => {
    const empty = !pin.provider && !pin.model && !pin.effort;
    if (await onSave(account.id, { agentDefaults: empty ? null : pin })) setEditing(false);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400"><Bot size={12} aria-hidden="true" /> Agent defaults</h4>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="inline-flex min-h-[36px] items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300">
            <Pencil size={12} aria-hidden="true" /> Edit
          </button>
        )}
      </div>
      {editing ? (
        <GitHubAgentPinForm
          pin={defaults}
          label={`Agent defaults for ${account.label}`}
          submitLabel={saving ? 'Saving…' : 'Save defaults'}
          busy={saving}
          onSubmit={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p className="text-xs text-gray-400">
          {isSet ? describeAgentPin(defaults, providers) : 'CoS defaults'}
          {' · '}Resolve with agent starts here unless an agent rule pins its own; each run can change it.
        </p>
      )}
    </div>
  );
}

// An inbox row's Add automation rule links here with the thread's kind and
// repo, so the form opens prefilled and the link stays shareable.
const RULE_PARAMS = ['ruleAccount', 'ruleKind', 'ruleRepo'];
const RULE_REPO_RE = /^(?:\*|[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/;
function rulePrefillFrom(params) {
  const kind = params.get('ruleKind');
  const repo = params.get('ruleRepo') || '*';
  if (!params.get('ruleAccount') || !AGENT_RULE_KINDS.some((option) => option.value === kind) || !RULE_REPO_RE.test(repo)) return null;
  return { accountId: params.get('ruleAccount'), kind, repo };
}

function AccountCard({ account, running, onRun, onMode, savingMode, onAllowAgents, onSaveRules, savingRules, onSaveAccount, prefill, onPrefillDone }) {
  const selectId = `github-mode-${account.id}`;
  return (
    <li className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-card p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-white">{account.label}</h3>
          <p className="truncate font-mono text-xs text-gray-400">{account.host}</p>
        </div>
        {!account.enabled && <Pill tone="warning">Off</Pill>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-xs text-gray-400">Mode</label>
        <select
          id={selectId}
          value={account.mode}
          onChange={(event) => onMode(account.id, event.target.value)}
          disabled={savingMode}
          className="rounded border border-port-border bg-port-bg px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          {MODE_OPTIONS.map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
          {!MODE_OPTIONS.includes(account.mode) && <option value={account.mode}>{MODE_LABELS[account.mode] || account.mode}</option>}
        </select>
      </div>
      <p className="text-xs text-gray-400">{modeHint(account)}</p>
      <p className="text-xs text-gray-300">
        {account.lastSyncAt ? `Checked ${timeAgo(account.lastSyncAt)}` : 'Not checked yet'}
        {' · '}{account.needsYou} open{account.suspect ? ` · ${account.suspect} suspect` : ''}{account.pending ? ` · ${account.pending} waiting for triage` : ''}
      </p>
      {account.lastError && <p role="alert" className="break-words text-xs text-port-error">{account.lastError}</p>}
      <button
        type="button"
        onClick={() => onRun(account.id)}
        disabled={running || !account.enabled}
        className="inline-flex items-center gap-1.5 rounded border border-port-border px-3 py-1.5 text-xs text-gray-300 disabled:opacity-50"
      >
        <Play size={12} aria-hidden="true" /> {running ? 'Checking…' : 'Run now'}
      </button>
      <AgentAccess account={account} onAllow={onAllowAgents} saving={savingMode} />
      <AgentDefaults account={account} onSave={onSaveAccount} saving={savingMode} />
      <GitHubAgentRules account={account} onSave={onSaveRules} saving={savingRules} prefill={prefill} onPrefillDone={onPrefillDone} onApplyNow={onRun} />
    </li>
  );
}

function ActivityList({ actions, onUndo, undoingId }) {
  if (!actions.length) return <p className="text-xs text-gray-500">Assist and Autopilot have not acted on anything yet.</p>;
  return (
    <ul className="divide-y divide-port-border">
      {actions.map((action) => (
        <li key={action.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2">
          <div className="min-w-0 flex-1">
            <Link to={`/devtools/github/inbox/${encodeURIComponent(action.accountId)}/${encodeURIComponent(action.threadId)}`} className="block truncate text-sm text-white">
              {action.title}
            </Link>
            <p className="truncate text-xs text-gray-400">
              {ACTION_LABELS[action.action] || action.action} · {action.repoFullName} · {timeAgo(action.at)}
            </p>
          </div>
          {action.undoable && (
            <button
              type="button"
              onClick={() => onUndo(action.id)}
              disabled={undoingId === action.id}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300 disabled:opacity-50"
            >
              <Undo2 size={12} aria-hidden="true" /> Undo
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function RuleList({ rules, onDelete }) {
  if (!rules.length) return <p className="text-xs text-gray-500">None yet. When you handle a thread differently than suggested, Assist remembers it for that repo and person.</p>;
  return (
    <ul className="divide-y divide-port-border">
      {rules.map((rule) => (
        <li key={rule.id} className="flex min-w-0 items-center gap-3 py-2">
          <p className="min-w-0 flex-1 break-words text-xs text-gray-300">
            <span className="font-mono">{rule.repoFullName}</span> · {rule.reason}{rule.actor ? <> · <span className="font-mono">@{rule.actor}</span></> : null}
            {' → '}<span className="text-white">{LEARNED_DECISION_LABELS[rule.decision] || rule.decision}</span>
            {rule.hits > 1 ? ` (${rule.hits}×)` : ''}
          </p>
          <button type="button" onClick={() => onDelete(rule.id)} className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded text-gray-400 hover:text-white" aria-label={`Forget rule for ${rule.repoFullName}`}>
            <X size={14} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function GitHubAutomationsTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rulePrefill = rulePrefillFrom(searchParams);
  const clearRulePrefill = () => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    RULE_PARAMS.forEach((key) => next.delete(key));
    return next;
  }, { replace: true });
  const [overview, setOverview] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [runningId, setRunningId] = useState(null);
  const [savingCadence, setSavingCadence] = useState(false);

  const [actions, setActions] = useState([]);
  const [rules, setRules] = useState([]);
  // Which list read failed on the latest load. A failed read keeps the
  // last good list on screen beside a Retry row instead of the "nothing yet"
  // copy, which would hide every Undo for actions Assist took on GitHub.
  const [failed, setFailed] = useState({ activity: false, rules: false });
  const loadRequestRef = useRef(0);
  const [savingModeId, setSavingModeId] = useState(null);
  const [savingRulesId, setSavingRulesId] = useState(null);
  const [undoingId, setUndoingId] = useState(null);

  // Every github:notifications:changed event reloads, and one check emits once
  // per account, so only the newest request may write.
  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    const [result, activity, learned] = await Promise.all([
      getGitHubAutomations({ silent: true }).catch(() => null),
      getGitHubAutomationActivity({ silent: true }).catch(() => null),
      getGitHubLearnedRules({ silent: true }).catch(() => null),
    ]);
    if (request !== loadRequestRef.current) return;
    const activityOk = Array.isArray(activity?.actions);
    const rulesOk = Array.isArray(learned?.rules);
    setFailed({ activity: !activityOk, rules: !rulesOk });
    if (activityOk) setActions(activity.actions);
    if (rulesOk) setRules(learned.rules);
    if (!result) {
      setLoadFailed(true);
      return;
    }
    setLoadFailed(false);
    setOverview(result);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    socket.on('github:notifications:changed', load);
    socket.on('connect', load);
    return () => {
      socket.off('github:notifications:changed', load);
      socket.off('connect', load);
    };
  }, [load]);

  const runNow = async (accountId) => {
    setRunningId(accountId);
    // A failed check is recorded on the account and shown on its card.
    await syncGitHubNotifications(accountId, { silent: true }).catch(() => null);
    setRunningId(null);
    await load();
  };

  const changeAccount = async (accountId, patch) => {
    setSavingModeId(accountId);
    const updated = await updateGitHubAccount(accountId, patch).catch(() => null);
    setSavingModeId(null);
    if (!updated) return false;
    setOverview((prev) => ({
      ...prev,
      accounts: prev.accounts.map((account) => (account.id === accountId
        ? { ...account, mode: updated.mode, allowAgents: updated.allowAgents === true, agentDefaults: updated.agentDefaults || null }
        : account)),
    }));
    return true;
  };
  const changeMode = (accountId, mode) => changeAccount(accountId, { mode });
  const allowAgents = (accountId, allow) => changeAccount(accountId, { allowAgents: allow });

  const saveRules = async (accountId, agentRules) => {
    setSavingRulesId(accountId);
    const updated = await updateGitHubAccount(accountId, { agentRules }).catch(() => null);
    setSavingRulesId(null);
    if (!updated) return false;
    setOverview((prev) => ({ ...prev, accounts: prev.accounts.map((account) => (account.id === accountId ? { ...account, agentRules: updated.agentRules || [] } : account)) }));
    return true;
  };

  const undo = async (id) => {
    setUndoingId(id);
    const undone = await undoGitHubAutomationAction(id).catch(() => null);
    setUndoingId(null);
    if (undone) await load();
  };

  const forgetRule = async (id) => {
    const removed = await deleteGitHubLearnedRule(id).catch(() => null);
    if (removed) setRules((prev) => prev.filter((rule) => rule.id !== id));
  };

  const toggleCadence = async () => {
    setSavingCadence(true);
    const next = overview.cadence === 'weekdays-15m' ? 'off' : 'weekdays-15m';
    const updated = await setGitHubNotificationCadence(next).catch(() => null);
    setSavingCadence(false);
    if (updated) setOverview(updated);
  };

  if (loadFailed && !overview) return <LoadFailedState title="Could not load GitHub automations." hint="Retry the local read." onRetry={load} />;
  if (!overview) return <PageSkeleton label="Loading GitHub automations" titleWidthClass="w-40" showAction={false} cards={2} />;

  return (
    <div className="min-w-0 space-y-4">
      {loadFailed && <ListLoadError what="the latest GitHub automation status" onRetry={load} />}
      <section className="space-y-2 rounded-lg border border-port-border bg-port-card p-4" aria-label="Notification check schedule">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-semibold text-white">Notification check</h2>
            <p className="text-xs text-gray-400">{CADENCE_TEXT[overview.cadence] || CADENCE_TEXT.off}</p>
          </div>
          <button
            type="button"
            onClick={toggleCadence}
            disabled={savingCadence || overview.cadence === 'custom'}
            aria-pressed={overview.cadence === 'weekdays-15m'}
            className="shrink-0 rounded bg-port-accent px-3 py-2 text-xs text-white disabled:opacity-50"
          >
            {overview.cadence === 'weekdays-15m' ? 'Turn off schedule' : 'Check every 15 min on weekdays'}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Each check applies fixed rules first. Only accounts in Assist use AI, and only for notifications no rule decided.
          {overview.lastSummary ? ` Last run: ${overview.lastSummary}.` : ''}
        </p>
      </section>

      {overview.accounts.length === 0 ? (
        <p className="rounded-lg border border-port-border bg-port-card p-4 text-sm text-gray-400">
          No GitHub accounts yet. <Link to="/devtools/github/accounts" className="text-port-accent">Add one</Link>
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 @3xl/page:grid-cols-2">
          {overview.accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              running={runningId === account.id}
              onRun={runNow}
              onMode={changeMode}
              savingMode={savingModeId === account.id}
              onAllowAgents={allowAgents}
              onSaveRules={saveRules}
              savingRules={savingRulesId === account.id}
              onSaveAccount={changeAccount}
              prefill={rulePrefill?.accountId === account.id ? rulePrefill : null}
              onPrefillDone={clearRulePrefill}
            />
          ))}
        </ul>
      )}

      <section className="space-y-2 rounded-lg border border-port-border bg-port-card p-4" aria-label="Recent Assist actions">
        <h2 className="font-semibold text-white">Recent actions</h2>
        {failed.activity && <ListLoadError what="recent actions" onRetry={load} />}
        {(!failed.activity || actions.length > 0) && <ActivityList actions={actions} onUndo={undo} undoingId={undoingId} />}
      </section>

      <section className="space-y-2 rounded-lg border border-port-border bg-port-card p-4" aria-label="Learned rules">
        <h2 className="font-semibold text-white">Learned rules</h2>
        {failed.rules && <ListLoadError what="learned rules" onRetry={load} />}
        {(!failed.rules || rules.length > 0) && <RuleList rules={rules} onDelete={forgetRule} />}
      </section>
    </div>
  );
}
