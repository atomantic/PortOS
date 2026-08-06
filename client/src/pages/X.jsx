import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AtSign, BarChart3, Check, ExternalLink, FilePen, Plus, RefreshCw, ShieldAlert, X as XIcon } from 'lucide-react';
import * as api from '../services/api';
import Drawer from '../components/Drawer';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import { useValidTab } from '../hooks/useValidTab';

const TABS = [
  { id: 'health', label: 'Reach & health', icon: BarChart3 },
  { id: 'posts', label: 'Posts', icon: AtSign },
  { id: 'drafts', label: 'Drafts', icon: FilePen },
  { id: 'accounts', label: 'Accounts & safety', icon: ShieldAlert },
];
const emptyAccount = { label: '', username: '', enabled: true, notes: '' };
const fieldClass = 'w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white';
const buttonClass = 'rounded bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton = 'rounded border border-port-border px-3 py-2 text-sm text-gray-200 disabled:cursor-not-allowed disabled:opacity-50';

const sameAccount = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const formatCount = (value) => Number.isInteger(value) ? value.toLocaleString() : '—';
const formatDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
const stateLabel = (state) => ({ draft: 'Draft', pending_review: 'Awaiting review', approved: 'Approved', rejected: 'Rejected', opened: 'Opened in X' }[state] || state);
const normalizeHandle = (value) => String(value || '').trim().replace(/^@/, '');

function StatusBadge({ value, children }) {
  const classes = value === true
    ? 'border-port-success/40 bg-port-success/10 text-port-success'
    : value === false
      ? 'border-port-error/40 bg-port-error/10 text-port-error'
      : 'border-port-warning/40 bg-port-warning/10 text-port-warning';
  return <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${classes}`}>{value === true ? <Check size={13} /> : value === false ? <XIcon size={13} /> : null}{children}</span>;
}

export default function XPage() {
  const navigate = useNavigate();
  const { accountId } = useParams();
  const activeRouteTab = useValidTab(TABS, 'health');
  const [searchParams, setSearchParams] = useSearchParams();
  const [accounts, setAccounts] = useState([]);
  const [posts, setPosts] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [resourcesAccountId, setResourcesAccountId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accountForm, setAccountForm] = useState(emptyAccount);
  const [savedAccountForm, setSavedAccountForm] = useState(emptyAccount);
  const [accountFormError, setAccountFormError] = useState('');
  const [deleteAccountId, setDeleteAccountId] = useState(null);
  const [draftBody, setDraftBody] = useState('');
  const selectedLoadRef = useRef(0);
  const currentAccountIdRef = useRef(accountId);
  const selectedAccountIdRef = useRef(null);
  const savedAccountRef = useRef(emptyAccount);
  currentAccountIdRef.current = accountId;

  const selected = accounts.find((account) => account.id === accountId) || null;
  const activeTab = selected ? activeRouteTab : 'accounts';
  const accountPath = (id, tab = activeRouteTab) => `/x/${id}/${tab}`;
  const accountFormMode = searchParams.get('xAccount');
  const accountDrawerOpen = accountFormMode === 'new' || (accountFormMode === 'edit' && Boolean(selected));
  const accountFormDirty = accountFormMode === 'edit' && !sameAccount(accountForm, savedAccountForm);
  const visiblePosts = resourcesAccountId === accountId ? posts : [];
  const visibleDrafts = resourcesAccountId === accountId ? drafts : [];

  const openAccountForm = useCallback((mode) => {
    setAccountFormError('');
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (mode) next.set('xAccount', mode);
      else next.delete('xAccount');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const closeAccountForm = useCallback(() => openAccountForm(null), [openAccountForm]);

  const openEditAccount = (account) => {
    setAccountForm({ label: account.label, username: account.username, enabled: account.enabled, notes: account.notes || '' });
    navigate(`/x/${account.id}/accounts?xAccount=edit`);
  };

  const loadAccounts = useCallback(async () => {
    const result = await api.getXAccounts({ silent: true }).catch((err) => ({ error: err.message, accounts: [] }));
    if (result.error) setError(result.error);
    setAccounts(result.accounts || []);
    setLoading(false);
  }, []);

  const loadSelected = useCallback(async () => {
    const requestId = ++selectedLoadRef.current;
    const requestedAccountId = accountId;
    setResourcesAccountId(null);
    setPosts([]);
    setDrafts([]);
    if (!accountId) return;
    const [postResult, draftResult] = await Promise.all([
      api.getXPosts(accountId, { silent: true }).catch((err) => ({ error: err.message, posts: [] })),
      api.getXDrafts(accountId, { silent: true }).catch((err) => ({ error: err.message, drafts: [] })),
    ]);
    if (selectedLoadRef.current !== requestId || currentAccountIdRef.current !== requestedAccountId) return;
    const failed = [postResult, draftResult].find((result) => result.error);
    if (failed) setError(failed.error);
    setPosts(postResult.posts || []);
    setDrafts(draftResult.drafts || []);
    setResourcesAccountId(requestedAccountId);
  }, [accountId]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadSelected(); }, [loadSelected]);
  useEffect(() => {
    if (!selected) {
      selectedAccountIdRef.current = null;
      return;
    }
    const next = { label: selected.label, username: selected.username, enabled: selected.enabled, notes: selected.notes || '' };
    const switched = selectedAccountIdRef.current !== selected.id;
    setAccountForm((current) => switched || sameAccount(current, savedAccountRef.current) ? next : current);
    setSavedAccountForm(next);
    savedAccountRef.current = next;
    selectedAccountIdRef.current = selected.id;
  }, [selected]);

  const finish = (key, promise, onSuccess) => {
    setBusy(key);
    setError('');
    setNotice('');
    promise.then(onSuccess, (err) => setError(err.message)).finally(() => setBusy(''));
  };

  const updateAccountForm = (key, value) => setAccountForm((previous) => ({ ...previous, [key]: value }));
  const saveAccount = (event) => {
    event.preventDefault();
    const label = accountForm.label.trim();
    const username = normalizeHandle(accountForm.username);
    if (!label || !username) {
      setAccountFormError('A local label and X username are required.');
      return;
    }
    setAccountFormError('');
    const payload = { label, username, enabled: accountForm.enabled, notes: accountForm.notes };
    if (accountFormMode === 'edit' && selected) {
      const savedId = selected.id;
      finish('save-account', api.updateXAccount(savedId, payload, { silent: true }), (result) => {
        setAccounts((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
        if (currentAccountIdRef.current === savedId) {
          const next = { label: result.label, username: result.username, enabled: result.enabled, notes: result.notes || '' };
          setAccountForm(next);
          setSavedAccountForm(next);
          savedAccountRef.current = next;
        }
        closeAccountForm();
        setNotice('X account settings saved.');
      });
      return;
    }
    finish('create-account', api.createXAccount(payload, { silent: true }), (result) => {
      setAccounts((previous) => [...previous, result]);
      setAccountForm(emptyAccount);
      closeAccountForm();
      navigate(accountPath(result.id, 'health'));
      setNotice('X account added.');
    });
  };

  const removeAccount = (id) => finish(`delete-account-${id}`, api.deleteXAccount(id, { silent: true }), () => {
    setAccounts((previous) => previous.filter((candidate) => candidate.id !== id));
    setDeleteAccountId(null);
    if (id === accountId) navigate('/x');
    setNotice('X account removed.');
  });

  const sync = () => selected && finish('sync', api.syncXAccount(selected.id, { silent: true }), (result) => {
    setAccounts((previous) => previous.map((candidate) => candidate.id === result.account.id ? result.account : candidate));
    setPosts(result.posts || []);
    setResourcesAccountId(selected.id);
    setNotice(`Diagnostic complete: ${result.ingested} public post(s) captured.`);
  });

  const openDestination = (kind) => selected && finish(`open-${kind}`, api.openXAccountDestination(selected.id, kind, { silent: true }), () => {
    setNotice('Opened the requested X page in the managed browser.');
  });

  const createDraft = (event) => {
    event.preventDefault();
    if (!selected || !draftBody.trim()) return;
    finish('create-draft', api.createXDraft({ accountId: selected.id, body: draftBody.trim() }, { silent: true }), (result) => {
      setDrafts((previous) => [result, ...previous]);
      setDraftBody('');
      setNotice('Draft saved locally. Submit it for review when you are ready.');
    });
  };

  const reviewDraft = (draft, state) => finish(`review-${draft.id}`, api.reviewXDraft(draft.id, { state }, { silent: true }), (result) => {
    setDrafts((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
    setNotice(state === 'pending_review' ? 'Draft submitted to Review Hub.' : `Draft ${state}.`);
  });

  const openDraft = (draft) => finish(`open-draft-${draft.id}`, api.openXDraft(draft.id, { silent: true }), (result) => {
    setDrafts((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
    setNotice('Opened the approved draft in X for a final manual check. Nothing was posted.');
  });

  const accountSwitcher = <div className="flex flex-wrap items-center gap-2">
    <label htmlFor="x-account-switcher" className="sr-only">X account in scope</label>
    <select id="x-account-switcher" className={`${fieldClass} w-auto min-w-48`} value={selected?.id || ''} onChange={(event) => navigate(event.target.value ? accountPath(event.target.value) : '/x')}>
      <option value="">Choose an X account</option>
      {accounts.map((account) => <option key={account.id} value={account.id}>@{account.username}</option>)}
    </select>
    <button type="button" className={secondaryButton} onClick={() => { setAccountForm(emptyAccount); openAccountForm('new'); }}><Plus size={15} className="mr-1 inline" />Add account</button>
  </div>;

  const renderHealth = () => {
    const snapshot = selected?.profileSnapshot || {};
    const profile = snapshot.profile || {};
    const checks = snapshot.diagnostics || {};
    const checkRows = [
      { label: 'Public profile reachable', value: checks.profilePublic, detail: 'The profile page returned the configured handle.' },
      { label: 'Exact account search', value: checks.appearsInPeopleSearch, detail: 'The handle appeared in X People search.' },
      { label: 'Recent posts in Latest search', value: checks.recentPostsInLatestSearch, detail: `${formatCount(checks.latestSearchPostCount)} matching original post(s) were returned.` },
      { label: 'Recommendation eligibility', value: null, detail: 'X does not expose a public yes/no recommendation-eligibility signal here.' },
    ];
    return <div className="space-y-4">
      <section className="rounded border border-port-border bg-port-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-semibold text-white">Reach diagnostics for @{selected.username}</h2><p className="mt-1 text-sm text-gray-400">Read-only checks of the public profile, X search, and visible post metrics.</p></div>
          <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={sync}><RefreshCw size={15} className="mr-1 inline" />Run diagnostic</button><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => openDestination('profile')}><ExternalLink size={15} className="mr-1 inline" />Open profile</button></div>
        </div>
        {!selected.profileSnapshot?.diagnostics && <div className="mt-4 rounded border border-port-warning/40 bg-port-warning/10 p-3 text-sm text-port-warning">No snapshot yet. Run a diagnostic to capture the evidence PortOS can verify.</div>}
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          {[['Followers', profile.followers], ['Following', profile.following], ['Lifetime posts', profile.postCount], ['Captured posts', visiblePosts.length]].map(([label, value]) => <div key={label} className="rounded border border-port-border p-3"><div className="text-xs uppercase tracking-wide text-gray-500">{label}</div><div className="mt-1 text-2xl font-semibold text-white">{formatCount(value)}</div></div>)}
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {checkRows.map((check) => <div key={check.label} className="rounded border border-port-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm text-gray-200">{check.label}</span><StatusBadge value={check.value}>{check.value === true ? 'Observed' : check.value === false ? 'Not observed' : 'Unknown'}</StatusBadge></div><p className="mt-2 text-xs text-gray-500">{check.detail}</p></div>)}
        </div>
        {selected.lastSyncAt && <p className="mt-3 text-xs text-gray-500">Last checked {formatDate(selected.lastSyncAt)}{selected.lastError ? ` · Last error: ${selected.lastError}` : ''}</p>}
      </section>
      <section className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">What this can and cannot conclude</h2><div className="mt-2 space-y-2 text-sm text-gray-300"><p>These checks rule out several hard visibility failures: the profile is public, the handle is searchable, and recent posts are returned in Latest search when a snapshot succeeds.</p><p>They cannot prove that X is recommending the account in Home or Explore. PortOS intentionally reports that as unknown instead of calling ordinary low reach a shadowban.</p><p className="text-gray-400">Automatic posting, follow/unfollow behavior, and background AI activity are off. Approved drafts only open X’s compose screen for a final human check.</p></div><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => openDestination('people')}>Open account search</button><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => openDestination('latest')}>Open Latest search</button><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => openDestination('settings')}>Open X account settings</button></div></section>
    </div>;
  };

  const renderPosts = () => <section className="rounded border border-port-border bg-port-card p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-white">Captured post reach</h2><p className="mt-1 text-sm text-gray-400">Public metrics from the last browser diagnostic; counts are impressions, not unique people.</p></div><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={sync}><RefreshCw size={15} className="mr-1 inline" />Refresh</button></div>{!visiblePosts.length ? <p className="mt-4 text-sm text-gray-500">No captured posts yet. Run a diagnostic from Reach &amp; health.</p> : <div className="mt-4 space-y-2">{visiblePosts.map((post) => <article key={post.id} className="rounded border border-port-border p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500"><span>{post.kind === 'reply' ? 'Reply' : 'Post'} · {formatDate(post.remoteCreatedAt)}</span><span>{post.sourceUrl ? <a className="text-port-accent hover:underline" href={post.sourceUrl} target="_blank" rel="noreferrer">Open on X</a> : null}</span></div><p className="mt-2 whitespace-pre-wrap text-sm text-gray-200">{post.body || '(no text captured)'}</p><div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-400"><span><strong className="text-white">{formatCount(post.impressions)}</strong> impressions</span><span><strong className="text-white">{formatCount(post.engagements)}</strong> engagements</span><span>{formatCount(post.likes)} likes</span><span>{formatCount(post.reposts)} reposts</span><span>{formatCount(post.replies)} replies</span></div></article>)}</div>}</section>;

  const renderDrafts = () => <div className="space-y-4"><section className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">Draft a post for review</h2><p className="mt-1 text-sm text-gray-400">Drafts stay local until you submit them to Review Hub. PortOS will never publish automatically.</p><form className="mt-3 space-y-3" onSubmit={createDraft}><label htmlFor="x-draft-body" className="sr-only">X draft text</label><textarea id="x-draft-body" className={fieldClass} rows="5" maxLength="4000" placeholder="Write something you actually want to say…" value={draftBody} onChange={(event) => setDraftBody(event.target.value)} /><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-gray-500">{draftBody.length}/4000</span><button className={buttonClass} disabled={!draftBody.trim() || Boolean(busy)}>Save draft</button></div></form></section><section className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">Draft queue</h2>{!visibleDrafts.length ? <p className="mt-3 text-sm text-gray-500">No drafts for @{selected.username}.</p> : <div className="mt-3 space-y-2">{visibleDrafts.map((draft) => <article key={draft.id} className="rounded border border-port-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><StatusBadge value={draft.state === 'approved' || draft.state === 'opened'}>{stateLabel(draft.state)}</StatusBadge><span className="text-xs text-gray-500">{formatDate(draft.updatedAt)}</span></div><p className="mt-3 whitespace-pre-wrap text-sm text-gray-200">{draft.body}</p><div className="mt-3 flex flex-wrap gap-2">{draft.state === 'draft' && <button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => reviewDraft(draft, 'pending_review')}>Submit for review</button>}{draft.state === 'pending_review' && <><button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={() => reviewDraft(draft, 'approved')}>Approve</button><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => reviewDraft(draft, 'rejected')}>Reject</button></>}{draft.state === 'approved' && <button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={() => openDraft(draft)}><ExternalLink size={15} className="mr-1 inline" />Open compose in X</button>}{draft.reviewNote && <span className="self-center text-xs text-gray-500">{draft.reviewNote}</span>}</div></article>)}</div>}</section></div>;

  const renderAccounts = () => <section className="rounded border border-port-border bg-port-card p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-white">X accounts</h2><p className="mt-1 text-sm text-gray-400">Browser-only diagnostics and review-gated compose handoffs. No X credentials are stored.</p></div><button type="button" className={buttonClass} onClick={() => { setAccountForm(emptyAccount); openAccountForm('new'); }}><Plus size={15} className="mr-1 inline" />Add account</button></div>{!accounts.length ? <div className="mt-4 rounded border border-port-border p-4 text-sm text-gray-400">Add an X account to begin. Sync is manual, so nothing contacts X at boot.</div> : <div className="mt-4 grid gap-3 md:grid-cols-2">{accounts.map((account) => <article key={account.id} className="rounded border border-port-border p-4"><div className="flex items-start justify-between gap-2"><div><h3 className="font-semibold text-white">{account.label}</h3><p className="text-sm text-gray-400">@{account.username}</p></div><StatusBadge value={account.enabled}>{account.enabled ? 'Enabled' : 'Disabled'}</StatusBadge></div><p className="mt-3 text-xs text-gray-500">{account.lastSyncAt ? `Last diagnostic ${formatDate(account.lastSyncAt)}` : 'No diagnostic yet'}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={secondaryButton} onClick={() => openEditAccount(account)}>Edit</button><button type="button" className={secondaryButton} onClick={() => navigate(accountPath(account.id, 'health'))}>Open</button>{deleteAccountId === account.id ? <><button type="button" className="rounded border border-port-error px-3 py-2 text-sm text-port-error disabled:opacity-50" disabled={Boolean(busy)} onClick={() => removeAccount(account.id)}>Delete</button><button type="button" className={secondaryButton} onClick={() => setDeleteAccountId(null)}>Cancel</button></> : <button type="button" className={secondaryButton} onClick={() => setDeleteAccountId(account.id)}>Remove</button>}</div></article>)}</div>}</section>;

  const accountDrawer = <Drawer open={accountDrawerOpen} onClose={closeAccountForm} title={accountFormMode === 'edit' ? 'Edit X account' : 'Add X account'} subtitle="Read-only diagnostics with human-reviewed drafts" size="md"><form className="space-y-4" onSubmit={saveAccount}><label className="block text-sm text-gray-300" htmlFor="x-account-label">Local label<input id="x-account-label" className={`${fieldClass} mt-1`} required value={accountForm.label} onChange={(event) => updateAccountForm('label', event.target.value)} /></label><label className="block text-sm text-gray-300" htmlFor="x-account-username">X username<input id="x-account-username" className={`${fieldClass} mt-1`} required placeholder="example_user" value={accountForm.username} onChange={(event) => updateAccountForm('username', event.target.value)} /><span className="mt-1 block text-xs text-gray-500">Enter the handle without or with @. PortOS normalizes it.</span></label><label className="block text-sm text-gray-300" htmlFor="x-account-notes">Notes<textarea id="x-account-notes" className={`${fieldClass} mt-1`} rows="4" value={accountForm.notes} onChange={(event) => updateAccountForm('notes', event.target.value)} /></label><label className="flex items-center gap-2 text-sm text-gray-300" htmlFor="x-account-enabled"><input id="x-account-enabled" type="checkbox" checked={accountForm.enabled} onChange={(event) => updateAccountForm('enabled', event.target.checked)} /> Allow diagnostics and compose handoffs</label><div className="rounded border border-port-border bg-port-bg p-3 text-xs text-gray-400">The managed browser reads public X pages. PortOS does not store your X password or API token, does not run background posting, and only opens an approved draft for final manual submission.</div>{accountFormError && <p className="text-sm text-port-error">{accountFormError}</p>}<div className="flex justify-end gap-2"><button type="button" className={secondaryButton} onClick={closeAccountForm}>Cancel</button><button className={buttonClass} disabled={Boolean(busy) || accountFormDirty && accountFormMode === 'edit' && !accountForm.label.trim()}>{accountFormMode === 'edit' ? 'Save account' : 'Add account'}</button></div></form></Drawer>;

  const notFound = Boolean(accountId && !selected);
  if (loading) return <PageSkeleton header="bar" label="Loading X" tabs={TABS.length} cards={3} />;
  return <div className="flex h-full min-h-0 flex-col"><PageHeader icon={AtSign} title="X" subtitle="Account health, reach diagnostics, and review-gated drafts" actions={accountSwitcher} /><TabPills tabs={TABS} activeTab={activeTab} onChange={(nextTab) => selected ? navigate(accountPath(selected.id, nextTab)) : navigate('/x')} ariaLabel="X sections" /><main className="flex-1 overflow-auto p-4">{error && <div className="mb-3 rounded border border-port-error p-3 text-sm text-port-error">{error}</div>}{notice && <div className="mb-3 rounded border border-port-border p-3 text-sm text-gray-200">{notice}</div>}{notFound && <div className="mb-3 rounded border border-port-error p-4 text-sm text-port-error">This X account was not found. <button type="button" className="underline" onClick={() => navigate('/x')}>Return to accounts.</button></div>}{activeTab === 'health' && selected && renderHealth()}{activeTab === 'posts' && selected && renderPosts()}{activeTab === 'drafts' && selected && renderDrafts()}{activeTab === 'accounts' && renderAccounts()}{accountDrawer}</main></div>;
}
