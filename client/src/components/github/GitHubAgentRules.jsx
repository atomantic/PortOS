import { useId, useState } from 'react';
import { Bot, Pencil, Plus, X } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import useRunWithPicker from '../../hooks/useRunWithPicker';
import { formatCount } from '../../utils/formatters';
import { AGENT_RULE_KINDS, RULE_ACTIONS, actionsForKind, ruleActionOf } from './githubTriageLabels';
import { describeAgentPin } from './GitHubAgentPinForm';

const ALL_REPOS = '*';
const OTHER_REPO = '__other__';
const OTHER_OWNER = '__owner__';
const OWNER_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/(?:\*|[A-Za-z0-9_.-]{1,100})$/;

const newRuleId = () => `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const repoLabel = (repo) => (repo === ALL_REPOS ? 'All repos' : repo.endsWith('/*') ? `${repo.slice(0, -2)} (all repos)` : repo);

const actionLabel = (action) => RULE_ACTIONS.find((option) => option.value === action)?.label || action;

function pinLabel(rule, providers) {
  const action = ruleActionOf(rule);
  return action === 'agent' ? `Start an agent · ${describeAgentPin(rule, providers)}` : actionLabel(action);
}

// Open threads a rule for this kind and repo would match now, from the
// server's per-kind counts: repo > owner > all. Done and mute never touch threads a pinned
// triage rule decided, so they count only `actionable`.
function ruleMatchCount({ openByKind, rules, editingId, kind, repo, action }) {
  if (!Array.isArray(openByKind)) return null;
  const metric = action === 'done' || action === 'mute' ? 'actionable' : 'total';
  const ofKind = openByKind.filter((entry) => entry.kind === kind);
  const scope = repo.toLowerCase();
  const other = rules.filter((rule) => rule.kind === kind && rule.id !== editingId).map((rule) => rule.repo.toLowerCase());
  return ofKind.filter((entry) => {
    const name = entry.repo.toLowerCase();
    const owner = `${name.split('/')[0]}/*`;
    if (scope === ALL_REPOS) return !other.includes(name) && !other.includes(owner);
    if (scope.endsWith('/*')) return owner === scope && !other.includes(name);
    return name === scope;
  }).reduce((sum, entry) => sum + entry[metric], 0);
}

// Whether a run of this account now would carry out the rule's action.
const actsNow = (mode, action) => (action === 'agent' ? mode === 'autopilot' : (action === 'done' || action === 'mute') && (mode === 'assist' || mode === 'autopilot'));

function RuleForm({ rule, repos, rules, account, takenKeys, onCancel, onSubmit, saving }) {
  const formId = useId();
  const picker = useRunWithPicker({ preselectDefaults: false, seed: rule });
  const [kind, setKind] = useState(rule?.kind || AGENT_RULE_KINDS[0].value);
  const owners = [...new Set(repos.map((name) => name.split('/')[0].toLowerCase()))].sort();
  const ownerRule = rule?.repo?.endsWith('/*');
  const knownRepo = !rule || rule.repo === ALL_REPOS || repos.includes(rule.repo) || (ownerRule && owners.includes(rule.repo.slice(0, -2).toLowerCase()));
  const [repoChoice, setRepoChoice] = useState(rule ? (knownRepo ? (ownerRule ? rule.repo.toLowerCase() : rule.repo) : ownerRule ? OTHER_OWNER : OTHER_REPO) : ALL_REPOS);
  const [otherRepo, setOtherRepo] = useState(knownRepo ? '' : ownerRule ? rule.repo.slice(0, -2) : rule?.repo || '');
  const [chosenAction, setAction] = useState(rule ? ruleActionOf(rule) : 'agent');
  const [applyNow, setApplyNow] = useState(false);
  const options = actionsForKind(kind);
  // A kind that cannot take the chosen action falls back to its first one.
  const action = options.some((option) => option.value === chosenAction) ? chosenAction : options[0].value;

  const repo = repoChoice === OTHER_REPO ? otherRepo.trim() : repoChoice === OTHER_OWNER ? `${otherRepo.trim()}/*` : repoChoice;
  const repoValid = repoChoice === OTHER_OWNER ? OWNER_RE.test(otherRepo.trim()) : repo === ALL_REPOS || REPO_RE.test(repo);
  const clash = takenKeys.has(`${kind}#${repo.toLowerCase()}`);
  const matches = repoValid ? ruleMatchCount({ openByKind: account.openByKind, rules, editingId: rule?.id, kind, repo, action }) : null;
  const canApplyNow = matches > 0 && actsNow(account.mode, action);
  const submit = (event) => {
    event.preventDefault();
    if (!repoValid || clash) return;
    const agent = action === 'agent';
    onSubmit({
      id: rule?.id || newRuleId(),
      kind,
      repo,
      action,
      ...(agent ? { provider: picker.pin.provider || null, model: picker.pin.model || null, effort: picker.pin.effort || null } : {}),
    }, { applyNow: canApplyNow && applyNow });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-port-border bg-port-bg p-3" aria-label={rule?.id ? 'Edit automation rule' : 'New automation rule'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label htmlFor={`${formId}-kind`} className="space-y-1 text-xs text-gray-400">
          <span className="block">When I get</span>
          <select id={`${formId}-kind`} value={kind} onChange={(event) => setKind(event.target.value)} className="w-full rounded border border-port-border bg-port-card px-2 py-1.5 text-sm text-white">
            {AGENT_RULE_KINDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label htmlFor={`${formId}-repo`} className="space-y-1 text-xs text-gray-400">
          <span className="block">In</span>
          <select id={`${formId}-repo`} value={repoChoice} onChange={(event) => setRepoChoice(event.target.value)} className="w-full rounded border border-port-border bg-port-card px-2 py-1.5 text-sm text-white">
            <option value={ALL_REPOS}>All repos</option>
            <optgroup label="Accounts and organizations">
              {owners.map((owner) => <option key={owner} value={`${owner}/*`}>{owner} (all repos)</option>)}
              <option value={OTHER_OWNER}>Another account or organization…</option>
            </optgroup>
            {repos.map((name) => <option key={name} value={name}>{name}</option>)}
            <option value={OTHER_REPO}>Another repo…</option>
          </select>
        </label>
        <label htmlFor={`${formId}-action`} className="space-y-1 text-xs text-gray-400">
          <span className="block">Then</span>
          <select id={`${formId}-action`} value={action} onChange={(event) => setAction(event.target.value)} className="w-full rounded border border-port-border bg-port-card px-2 py-1.5 text-sm text-white">
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      {(repoChoice === OTHER_REPO || repoChoice === OTHER_OWNER) && (
        <label htmlFor={`${formId}-other`} className="block space-y-1 text-xs text-gray-400">
          <span className="block">{repoChoice === OTHER_OWNER ? 'Account or organization name' : 'Repo (owner/name)'}</span>
          <input id={`${formId}-other`} value={otherRepo} onChange={(event) => setOtherRepo(event.target.value)} placeholder={repoChoice === OTHER_OWNER ? 'owner' : 'owner/repo'} autoComplete="off" className="w-full rounded border border-port-border bg-port-card px-2 py-1.5 font-mono text-sm text-white" />
        </label>
      )}
      {action === 'agent' && (
        <div className="space-y-1">
          <span className="flex items-center gap-1.5 text-xs text-gray-400"><Bot size={12} aria-hidden="true" /> Run with</span>
          <ProviderModelSelector {...picker.selectorProps} compact />
        </div>
      )}
      <p className="text-xs text-gray-500">{AGENT_RULE_KINDS.find((option) => option.value === kind)?.hint}</p>
      {matches !== null && (
        <p className="text-xs text-gray-300">
          {matches === 1 ? 'Matches 1 open thread now.' : `Matches ${formatCount(matches)} open threads now.`}
        </p>
      )}
      {canApplyNow && (
        <label htmlFor={`${formId}-apply`} className="flex items-center gap-2 text-xs text-gray-300">
          <input id={`${formId}-apply`} type="checkbox" checked={applyNow} onChange={(event) => setApplyNow(event.target.checked)} />
          Apply to {matches === 1 ? 'this 1' : `these ${formatCount(matches)}`} now
        </label>
      )}
      {clash && <p role="alert" className="text-xs text-port-error">There is already a rule for this kind of notification in {repoLabel(repo)}.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={saving || !repoValid || clash} className="rounded bg-port-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">
          {saving ? 'Saving…' : 'Save rule'}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-port-border px-3 py-1.5 text-xs text-gray-300">Cancel</button>
      </div>
    </form>
  );
}

/**
 * One account's automation rules: for each kind of notification, in one repo
 * an account/organization or all repos, whether Assist and Autopilot mark it done, mute it, leave it,
 * or (Autopilot) start a CoS agent and on which provider, model and effort. A
 * repo's own rule wins over its owner rule, then All repos. `prefill` ({ kind, repo }) opens
 * a new rule from an inbox row; `onApplyNow` runs the account's check at once.
 */
export default function GitHubAgentRules({ account, onSave, saving, prefill = null, onPrefillDone, onApplyNow }) {
  const [editingState, setEditing] = useState(null);
  // A row's Add automation rule opens a new rule for its kind and repo.
  // It starts on Mark done, the usual reason to add one from a row.
  const editing = editingState || (prefill ? { id: null, kind: prefill.kind, repo: prefill.repo, action: prefill.kind === 'security-alert' ? 'agent' : 'done' } : null);
  const close = () => {
    setEditing(null);
    onPrefillDone?.();
  };
  const rules = account.agentRules || [];
  // Built-in rules apply until the operator saves a rule for the same kind and repo.
  const defaults = (account.defaultAgentRules || []).filter((rule) => !rules.some((entry) => entry.kind === rule.kind && entry.repo.toLowerCase() === rule.repo.toLowerCase()));
  const { providers } = useRunWithPicker({ preselectDefaults: false });
  const repos = account.repos || [];
  const kindLabel = (kind) => AGENT_RULE_KINDS.find((option) => option.value === kind)?.label || kind;

  const save = async (next, { applyNow = false } = {}) => {
    const saved = await onSave(account.id, next);
    if (!saved) return;
    close();
    if (applyNow) onApplyNow?.(account.id);
  };
  const upsert = (rule, options) => save(rules.some((entry) => entry.id === rule.id) ? rules.map((entry) => (entry.id === rule.id ? rule : entry)) : [...rules, rule], options);
  const remove = (id) => save(rules.filter((rule) => rule.id !== id));
  const takenKeys = new Set(rules.filter((rule) => rule.id !== editing?.id).map((rule) => `${rule.kind}#${rule.repo.toLowerCase()}`));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Automation rules</h4>
        {!editing && (
          <button type="button" onClick={() => setEditing({ id: null })} className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300">
            <Plus size={12} aria-hidden="true" /> Add rule
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500">Scope rules to an account or organization to cover its repos, including future ones. Specific repo rules override account or organization rules, which override All repos.</p>
      {account.mode !== 'autopilot' && rules.length > 0 && (
        <p className="text-xs text-port-warning">
          {account.mode === 'assist'
            ? 'Assist follows the done and mute rules; only Autopilot starts agents.'
            : `Assist and Autopilot follow these rules. This account is in ${account.mode === 'disabled' ? 'Disabled' : 'Observe'}, so nothing happens on its own yet.`}
        </p>
      )}
      {defaults.length > 0 && (
        <ul className="divide-y divide-port-border" aria-label="Default rules">
          {defaults.map((rule) => (
            <li key={rule.id} className="flex min-w-0 items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">{kindLabel(rule.kind)} · {repoLabel(rule.repo)}</p>
                <p className="truncate text-xs text-port-success">{actionLabel(rule.action)} · default</p>
              </div>
              <button type="button" onClick={() => setEditing({ id: null, kind: rule.kind, repo: rule.repo, action: rule.action })} disabled={Boolean(editing)} className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded px-2 text-xs text-gray-400 hover:text-white disabled:opacity-40" aria-label={`Override default ${kindLabel(rule.kind)} rule`}>
                Override
              </button>
            </li>
          ))}
        </ul>
      )}
      {rules.length === 0 && !editing && (
        <p className="text-xs text-gray-500">No rules: security alerts and outside issues and pull requests in your apps go to their usual agents, and other review requests wait for you. Add a rule here or from any inbox row.</p>
      )}
      {rules.length > 0 && (
        <ul className="divide-y divide-port-border">
          {rules.map((rule) => (editing?.id === rule.id ? (
            <li key={rule.id} className="py-2">
              <RuleForm rule={rule} repos={repos} rules={rules} account={account} takenKeys={takenKeys} onCancel={close} onSubmit={upsert} saving={saving} />
            </li>
          ) : (
            <li key={rule.id} className="flex min-w-0 items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">{kindLabel(rule.kind)} · <span className={rule.repo === ALL_REPOS ? '' : 'font-mono'}>{repoLabel(rule.repo)}</span></p>
                <p className={`truncate text-xs ${ruleActionOf(rule) === 'leave' ? 'text-gray-400' : 'text-port-success'}`}>{pinLabel(rule, providers)}</p>
              </div>
              <button type="button" onClick={() => setEditing(rule)} disabled={Boolean(editing)} className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded text-gray-400 hover:text-white disabled:opacity-40" aria-label={`Edit ${kindLabel(rule.kind)} rule for ${repoLabel(rule.repo)}`}>
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button type="button" onClick={() => remove(rule.id)} disabled={saving} className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded text-gray-400 hover:text-white disabled:opacity-40" aria-label={`Remove ${kindLabel(rule.kind)} rule for ${repoLabel(rule.repo)}`}>
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          )))}
        </ul>
      )}
      {editing && !editing.id && (
        <RuleForm key={`${editing.kind || ''}#${editing.repo || ''}`} rule={editing.kind ? editing : null} repos={repos} rules={rules} account={account} takenKeys={takenKeys} onCancel={close} onSubmit={upsert} saving={saving} />
      )}
    </div>
  );
}
