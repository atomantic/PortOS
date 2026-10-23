import { useId, useState } from 'react';
import { Bot, Pencil, Plus, X } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import useRunWithPicker from '../../hooks/useRunWithPicker';
import { AGENT_RULE_KINDS, CI_RULE_ACTIONS } from './githubTriageLabels';
import { describeAgentPin } from './GitHubAgentPinForm';

const ALL_REPOS = '*';
const OTHER_REPO = '__other__';
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const newRuleId = () => `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const repoLabel = (repo) => (repo === ALL_REPOS ? 'All repos' : repo);

const ciActionLabel = (action) => CI_RULE_ACTIONS.find((option) => option.value === action)?.label || action;

function pinLabel(rule, providers) {
  if (rule.kind === 'ci-activity') return ciActionLabel(rule.action);
  return rule.agent ? `Start an agent · ${describeAgentPin(rule, providers)}` : "Don't start an agent";
}

function RuleForm({ rule, repos, takenKeys, onCancel, onSubmit, saving }) {
  const formId = useId();
  const picker = useRunWithPicker({ preselectDefaults: false, seed: rule });
  const [kind, setKind] = useState(rule?.kind || AGENT_RULE_KINDS[0].value);
  const knownRepo = !rule || rule.repo === ALL_REPOS || repos.includes(rule.repo);
  const [repoChoice, setRepoChoice] = useState(rule ? (knownRepo ? rule.repo : OTHER_REPO) : ALL_REPOS);
  const [otherRepo, setOtherRepo] = useState(knownRepo ? '' : rule?.repo || '');
  const [agent, setAgent] = useState(rule ? rule.agent !== false : true);
  const [ciAction, setCiAction] = useState(rule?.action || 'done');
  const isCi = kind === 'ci-activity';

  const repo = repoChoice === OTHER_REPO ? otherRepo.trim() : repoChoice;
  const repoValid = repo === ALL_REPOS || REPO_RE.test(repo);
  const clash = takenKeys.has(`${kind}#${repo.toLowerCase()}`);
  const submit = (event) => {
    event.preventDefault();
    if (!repoValid || clash) return;
    if (isCi) {
      onSubmit({ id: rule?.id || newRuleId(), kind, repo, action: ciAction });
      return;
    }
    onSubmit({
      id: rule?.id || newRuleId(),
      kind,
      repo,
      agent,
      provider: agent ? picker.pin.provider || null : null,
      model: agent ? picker.pin.model || null : null,
      effort: agent ? picker.pin.effort || null : null,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-port-border bg-port-bg p-3" aria-label={rule ? 'Edit agent rule' : 'New agent rule'}>
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
            {repos.map((name) => <option key={name} value={name}>{name}</option>)}
            <option value={OTHER_REPO}>Another repo…</option>
          </select>
        </label>
        <label htmlFor={`${formId}-agent`} className="space-y-1 text-xs text-gray-400">
          <span className="block">Then</span>
          {isCi ? (
            <select id={`${formId}-agent`} value={ciAction} onChange={(event) => setCiAction(event.target.value)} className="w-full rounded border border-port-border bg-port-card px-2 py-1.5 text-sm text-white">
              {CI_RULE_ACTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : (
            <select id={`${formId}-agent`} value={agent ? 'agent' : 'none'} onChange={(event) => setAgent(event.target.value === 'agent')} className="w-full rounded border border-port-border bg-port-card px-2 py-1.5 text-sm text-white">
              <option value="agent">Start a CoS agent</option>
              <option value="none">Don&apos;t start an agent</option>
            </select>
          )}
        </label>
      </div>
      {repoChoice === OTHER_REPO && (
        <label htmlFor={`${formId}-other`} className="block space-y-1 text-xs text-gray-400">
          <span className="block">Repo (owner/name)</span>
          <input id={`${formId}-other`} value={otherRepo} onChange={(event) => setOtherRepo(event.target.value)} placeholder="owner/repo" autoComplete="off" className="w-full rounded border border-port-border bg-port-card px-2 py-1.5 font-mono text-sm text-white" />
        </label>
      )}
      {agent && !isCi && (
        <div className="space-y-1">
          <span className="flex items-center gap-1.5 text-xs text-gray-400"><Bot size={12} aria-hidden="true" /> Run with</span>
          <ProviderModelSelector {...picker.selectorProps} compact />
        </div>
      )}
      <p className="text-xs text-gray-500">{AGENT_RULE_KINDS.find((option) => option.value === kind)?.hint}</p>
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
 * One account's agent rules: for each kind of notification, in one repo or all
 * of them, whether Autopilot starts a CoS agent and on which provider, model
 * and effort. A repo's own rule wins over its All repos rule.
 */
export default function GitHubAgentRules({ account, onSave, saving }) {
  const [editing, setEditing] = useState(null);
  const rules = account.agentRules || [];
  // Built-in rules apply until the operator saves a rule for the same kind and repo.
  const defaults = (account.defaultAgentRules || []).filter((rule) => !rules.some((entry) => entry.kind === rule.kind && entry.repo.toLowerCase() === rule.repo.toLowerCase()));
  const { providers } = useRunWithPicker({ preselectDefaults: false });
  const repos = account.repos || [];
  const kindLabel = (kind) => AGENT_RULE_KINDS.find((option) => option.value === kind)?.label || kind;

  const save = async (next) => {
    const saved = await onSave(account.id, next);
    if (saved) setEditing(null);
  };
  const upsert = (rule) => save(rules.some((entry) => entry.id === rule.id) ? rules.map((entry) => (entry.id === rule.id ? rule : entry)) : [...rules, rule]);
  const remove = (id) => save(rules.filter((rule) => rule.id !== id));
  const takenKeys = new Set(rules.filter((rule) => rule.id !== editing?.id).map((rule) => `${rule.kind}#${rule.repo.toLowerCase()}`));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Agent rules</h4>
        {!editing && (
          <button type="button" onClick={() => setEditing({ id: null })} className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300">
            <Plus size={12} aria-hidden="true" /> Add rule
          </button>
        )}
      </div>
      {account.mode !== 'autopilot' && rules.length > 0 && (
        <p className="text-xs text-port-warning">Autopilot follows these rules. This account is in {{ assist: 'Assist', disabled: 'Disabled' }[account.mode] || 'Observe'}, so nothing starts on its own yet.</p>
      )}
      {defaults.length > 0 && (
        <ul className="divide-y divide-port-border" aria-label="Default rules">
          {defaults.map((rule) => (
            <li key={rule.id} className="flex min-w-0 items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">{kindLabel(rule.kind)} · {repoLabel(rule.repo)}</p>
                <p className="truncate text-xs text-port-success">{ciActionLabel(rule.action)} · default</p>
              </div>
              <button type="button" onClick={() => setEditing({ id: null, kind: rule.kind, repo: rule.repo, action: rule.action })} disabled={Boolean(editing)} className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded px-2 text-xs text-gray-400 hover:text-white disabled:opacity-40" aria-label={`Override default ${kindLabel(rule.kind)} rule`}>
                Override
              </button>
            </li>
          ))}
        </ul>
      )}
      {rules.length === 0 && !editing && (
        <p className="text-xs text-gray-500">No rules: security alerts and outside issues and pull requests in your apps go to their usual agents, and other review requests wait for you.</p>
      )}
      {rules.length > 0 && (
        <ul className="divide-y divide-port-border">
          {rules.map((rule) => (editing?.id === rule.id ? (
            <li key={rule.id} className="py-2">
              <RuleForm rule={rule} repos={repos} takenKeys={takenKeys} onCancel={() => setEditing(null)} onSubmit={upsert} saving={saving} />
            </li>
          ) : (
            <li key={rule.id} className="flex min-w-0 items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">{kindLabel(rule.kind)} · <span className={rule.repo === ALL_REPOS ? '' : 'font-mono'}>{repoLabel(rule.repo)}</span></p>
                <p className={`truncate text-xs ${rule.agent ? 'text-port-success' : 'text-gray-400'}`}>{pinLabel(rule, providers)}</p>
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
        <RuleForm rule={editing.kind ? editing : null} repos={repos} takenKeys={takenKeys} onCancel={() => setEditing(null)} onSubmit={upsert} saving={saving} />
      )}
    </div>
  );
}
