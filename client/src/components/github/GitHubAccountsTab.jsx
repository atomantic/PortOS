import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Plus, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import LoadFailedState from '../ui/LoadFailedState';
import PageSkeleton from '../ui/PageSkeleton';
import { FormField } from '../ui/FormField';
import ListLoadError from '../ui/ListLoadError';
import useListResource from '../../hooks/useListResource';
import {
  getGitHubAccounts,
  createGitHubAccount,
  updateGitHubAccount,
  deleteGitHubAccount,
  getGitHubAccountStatus,
  getProviders,
} from '../../services/api';

const GITHUB_DOT_COM = 'github.com';
const TRUST_OPTIONS = [
  { value: 'public', label: 'Public', hint: 'Anyone can mention you; outside content is always screened' },
  { value: 'private', label: 'Private', hint: 'Enterprise: org members trusted; content stays on allowed AI providers' },
];
const MODE_LABELS = { disabled: 'Disabled', observe: 'Observe', assist: 'Assist', autopilot: 'Autopilot' };
const STATUS_VIEW = {
  ok: { tone: 'success', label: 'Signed in' },
  'wrong-account': { tone: 'warning', label: 'Other login active' },
  'not-authenticated': { tone: 'warning', label: 'Signed out' },
  'not-installed': { tone: 'error', label: 'gh missing' },
  unreachable: { tone: 'error', label: 'Unreachable' },
  error: { tone: 'error', label: 'Check failed' },
};

const defaultTrustForHost = (host) => (host.trim().toLowerCase() === GITHUB_DOT_COM ? 'public' : 'private');
const emptyForm = () => ({ host: GITHUB_DOT_COM, login: '', label: '', trust: 'public', trustTouched: false, allowedProviders: [] });
const formFromAccount = (account) => ({
  host: account.host,
  login: account.login || '',
  label: account.label || '',
  trust: account.trust,
  trustTouched: true,
  allowedProviders: account.allowedProviders || [],
});
// No provider ticked = the Private default, local providers only (null).
const payloadFromForm = (form) => ({
  host: form.host.trim(),
  login: form.login.trim() || null,
  label: form.label.trim(),
  trust: form.trust,
  allowedProviders: form.trust === 'private' && form.allowedProviders.length ? form.allowedProviders : null,
});

const fetchApiProviders = () => getProviders({ silent: true })
  .then((data) => (data?.providers || []).filter((provider) => provider.type === 'api'));

function AllowedProviders({ form, setForm }) {
  const { items: providers, state, error, retry } = useListResource(fetchApiProviders);
  const toggle = (id) => setForm((prev) => ({
    ...prev,
    allowedProviders: prev.allowedProviders.includes(id) ? prev.allowedProviders.filter((value) => value !== id) : [...prev.allowedProviders, id],
  }));
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm text-gray-300">AI providers allowed to read this account's notifications</legend>
      <p className="text-xs text-gray-500">None ticked keeps it to local providers on this machine.</p>
      {state === 'loading' && <p className="text-xs text-gray-500">Loading providers…</p>}
      {state === 'error' && <ListLoadError what="AI providers" error={error} onRetry={retry} />}
      {state === 'ready' && providers.length === 0 && <p className="text-xs text-gray-500">No API providers configured.</p>}
      {providers.map((provider) => {
        const id = `github-allowed-${provider.id}`;
        return (
          <div key={provider.id} className="flex items-center gap-2">
            <input id={id} type="checkbox" checked={form.allowedProviders.includes(provider.id)} onChange={() => toggle(provider.id)} />
            <label htmlFor={id} className="min-w-0 truncate text-sm text-gray-300">{provider.name || provider.id}</label>
          </div>
        );
      })}
    </fieldset>
  );
}

function AccountForm({ form, setForm, onSubmit, onCancel, saving, submitLabel }) {
  const setField = (field) => (event) => {
    const value = event.target.value;
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'host' && !prev.trustTouched) next.trust = defaultTrustForHost(value);
      if (field === 'trust') next.trustTouched = true;
      return next;
    });
  };
  const inputClass = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm';
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Host" hint="github.com or your Enterprise hostname">
          <input type="text" value={form.host} onChange={setField('host')} autoCapitalize="none" autoCorrect="off" spellCheck={false} className={`${inputClass} font-mono`} required />
        </FormField>
        <FormField label="Login" hint="Leave empty to use whoever gh has signed in">
          <input type="text" value={form.login} onChange={setField('login')} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="octocat" className={`${inputClass} font-mono`} />
        </FormField>
        <FormField label="Name">
          <input type="text" value={form.label} onChange={setField('label')} placeholder="Shown on the account card" maxLength={80} className={inputClass} />
        </FormField>
        <FormField label="Trust" hint={TRUST_OPTIONS.find((option) => option.value === form.trust)?.hint}>
          <select value={form.trust} onChange={setField('trust')} className={inputClass}>
            {TRUST_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </FormField>
      </div>
      {form.trust === 'private' && <AllowedProviders form={form} setForm={setForm} />}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={saving || !form.host.trim()} className="px-4 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50">
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={saving} className="px-4 py-2 rounded border border-port-border text-gray-300 text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}

function AccountStatus({ status, onRecheck }) {
  if (!status) return <p className="text-xs text-gray-500">Checking sign-in…</p>;
  const view = STATUS_VIEW[status.status] || STATUS_VIEW.error;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={view.tone}>{view.label}</Pill>
        {status.login && <span className="min-w-0 truncate font-mono text-xs text-gray-300">@{status.login}</span>}
        <button type="button" onClick={onRecheck} className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-400 hover:text-white" aria-label="Recheck sign-in">
          <RefreshCw size={12} aria-hidden="true" /> Recheck
        </button>
      </div>
      {status.remedy && <p className="text-xs text-gray-400 break-words">{status.remedy}</p>}
      {status.command && (
        <Link to={`/shell?cmd=${encodeURIComponent(status.command)}`} className="inline-block rounded bg-port-accent px-3 py-1.5 text-xs text-white">
          Sign in on {status.host}
        </Link>
      )}
    </div>
  );
}

export default function GitHubAccountsTab() {
  const [accounts, setAccounts] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [statuses, setStatuses] = useState({});
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(null);

  const checkStatus = useCallback((id) => {
    setStatuses((prev) => ({ ...prev, [id]: null }));
    getGitHubAccountStatus(id, { silent: true })
      .then((status) => setStatuses((prev) => ({ ...prev, [id]: status })))
      .catch((err) => setStatuses((prev) => ({ ...prev, [id]: { id, status: 'error', remedy: err.message } })));
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    const list = await getGitHubAccounts({ silent: true }).catch(() => null);
    if (!list) {
      setLoadFailed(true);
      return;
    }
    setAccounts(list);
    list.forEach((account) => checkStatus(account.id));
  }, [checkStatus]);

  useEffect(() => { load(); }, [load]);

  const closeForm = () => {
    setAdding(false);
    setEditingId(null);
    setForm(emptyForm());
  };

  const handleCreate = async () => {
    setSaving(true);
    const created = await createGitHubAccount(payloadFromForm(form)).catch(() => null);
    setSaving(false);
    if (!created) return;
    setAccounts((prev) => [...(prev || []), created]);
    checkStatus(created.id);
    closeForm();
    toast.success(`Added ${created.label}`);
  };

  const handleUpdate = async () => {
    setSaving(true);
    const updated = await updateGitHubAccount(editingId, payloadFromForm(form)).catch(() => null);
    setSaving(false);
    if (!updated) return;
    setAccounts((prev) => prev.map((account) => (account.id === updated.id ? updated : account)));
    checkStatus(updated.id);
    closeForm();
  };

  const handleDelete = async (id) => {
    const removed = await deleteGitHubAccount(id).catch(() => null);
    setConfirmingDelete(null);
    if (!removed) return;
    setAccounts((prev) => prev.filter((account) => account.id !== id));
  };

  if (loadFailed) return <LoadFailedState title="Could not load GitHub accounts." hint="Retry the local account read." onRetry={load} />;
  if (!accounts) return <PageSkeleton label="Loading GitHub accounts" titleWidthClass="w-40" showAction={false} cards={2} />;

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-400">Each account is one login on one GitHub host.</p>
        {!adding && !editingId && (
          <button
            type="button"
            onClick={() => { setForm(emptyForm()); setAdding(true); }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded bg-port-accent px-3 py-2 text-sm text-white"
          >
            <Plus size={14} aria-hidden="true" /> Add account
          </button>
        )}
      </div>

      {adding && (
        <section className="rounded-lg border border-port-border bg-port-card p-4" aria-label="Add GitHub account">
          <h2 className="mb-3 font-semibold text-white">Add account</h2>
          <AccountForm form={form} setForm={setForm} onSubmit={handleCreate} onCancel={closeForm} saving={saving} submitLabel="Add account" />
        </section>
      )}

      {accounts.length === 0 && !adding && (
        <p className="rounded-lg border border-port-border bg-port-card p-4 text-sm text-gray-400">No GitHub accounts yet.</p>
      )}

      <ul className="grid grid-cols-1 gap-3 @3xl/page:grid-cols-2">
        {accounts.map((account) => (
          <li key={account.id} className="min-w-0 rounded-lg border border-port-border bg-port-card p-4">
            {editingId === account.id ? (
              <AccountForm form={form} setForm={setForm} onSubmit={handleUpdate} onCancel={closeForm} saving={saving} submitLabel="Save" />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold text-white">{account.label}</h2>
                    <p className="truncate font-mono text-xs text-gray-400">
                      {account.host}{account.login ? ` · @${account.login}` : ' · active gh login'}
                    </p>
                  </div>
                  <Pill tone={account.trust === 'private' ? 'accent' : 'muted'}>{account.trust === 'private' ? 'Private' : 'Public'}</Pill>
                  <Pill tone="muted">{MODE_LABELS[account.mode] || account.mode}</Pill>
                </div>
                <AccountStatus status={statuses[account.id]} onRecheck={() => checkStatus(account.id)} />
                {confirmingDelete === account.id ? (
                  <InlineConfirmRow
                    question={`Remove ${account.label}? gh keeps its sign-in.`}
                    confirmText="Remove"
                    onConfirm={() => handleDelete(account.id)}
                    onCancel={() => setConfirmingDelete(null)}
                  />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => { setAdding(false); setForm(formFromAccount(account)); setEditingId(account.id); }}
                      disabled={adding || Boolean(editingId)}
                      className="rounded border border-port-border px-3 py-1.5 text-xs text-gray-300 disabled:opacity-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(account.id)}
                      className="rounded border border-port-border px-3 py-1.5 text-xs text-gray-300"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
