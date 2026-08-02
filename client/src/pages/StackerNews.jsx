import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Newspaper, Plus, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react';
import * as api from '../services/api';
import Drawer from '../components/Drawer';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import useDrawerTab from '../hooks/useDrawerTab';
import useLocalModels from '../hooks/useLocalModels';
import useVisionModelIds from '../hooks/useVisionModelIds';
import { useValidTab } from '../hooks/useValidTab';
import { visionLocalModelFilter } from '../utils/providers';

// Stacker News analysis is hard-wired to Ollama (every call site is
// `runOllamaAnalysis`), so the vision filter's provider key is always `ollama`.
// Module-level so the reference is stable across renders.
const OLLAMA_PROVIDER = { id: 'ollama' };
const TABS = [
  { id: 'review', label: 'Review', icon: ShieldCheck },
  { id: 'territory', label: 'Territory', icon: Newspaper },
  { id: 'drafts', label: 'Drafts', icon: Plus },
  { id: 'activity', label: 'Activity', icon: RefreshCw },
  { id: 'accounts', label: 'Accounts & Safety', icon: ShieldAlert },
];
// The account form is a 19-field config surface, so it lives in the shared
// tabbed Drawer rather than a page-length flat scroll (client/src/CLAUDE.md).
const ACCOUNT_TABS = [
  { id: 'identity', label: 'Identity' },
  { id: 'monitoring', label: 'Monitoring & models' },
  { id: 'stewardship', label: 'Stewardship' },
  { id: 'budgets', label: 'Budgets' },
];
const ACCOUNT_TAB_IDS = ACCOUNT_TABS.map((accountTab) => accountTab.id);
// Every numeric account field, with the tab it lives on, so a Save fired from a
// different tab can still report which one is wrong.
const ACCOUNT_NUMBER_FIELDS = [
  { key: 'monitoringIntervalMinutes', label: 'Monitoring interval (minutes)', tab: 'monitoring', min: 5, max: 1440 },
  { key: 'maxPerHour', label: 'Max/hour', tab: 'budgets', min: 1, max: 50 },
  { key: 'maxPerDay', label: 'Max/day', tab: 'budgets', min: 1, max: 200 },
  { key: 'minMinutesBetween', label: 'Spacing min', tab: 'budgets', min: 0, max: 1440 },
];
// The Drawer body remounts per tab, so fields on an inactive tab are unmounted
// and the browser's `required` / `min` / `max` constraint validation never runs
// for them. Re-check every rule here and return the tab to surface. Note the
// explicit digits test: `Number('')` is 0, so an emptied box would otherwise
// slip past a `min: 0` bound.
const validateAccountForm = (form) => {
  if (!String(form.label || '').trim() || !String(form.username || '').trim()) {
    return { tab: 'identity', message: 'Local label and Stacker News username are required.' };
  }
  const invalid = ACCOUNT_NUMBER_FIELDS.find((field) => {
    const raw = String(form[field.key] ?? '').trim();
    return !/^\d+$/.test(raw) || Number(raw) < field.min || Number(raw) > field.max;
  });
  return invalid ? { tab: invalid.tab, message: `${invalid.label} must be a whole number from ${invalid.min} to ${invalid.max}.` } : null;
};
const emptyAccount = { label: '', username: '', apiKey: '', clearApiKey: false, enabled: true, monitoringEnabled: false, monitoringIntervalMinutes: 30, analysisEnabled: false, textModel: '', visionModel: '', guidance: '', tone: '', allowedThemes: '', disallowedThemes: '', escalationCues: '', desiredEngagement: '', maxPerHour: 3, maxPerDay: 12, minMinutesBetween: 5 };
const emptyTerritory = { slug: '', label: '', isOwned: false, monitoringEnabled: '', inheritAccountRules: true, guidance: '', tone: '', allowedThemes: '', disallowedThemes: '', escalationCues: '' };
const emptyDraft = { kind: 'publish_comment', itemId: '', territoryId: '', title: '', body: '', destination: 'item' };
const fieldClass = 'w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white';
const buttonClass = 'rounded bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton = 'rounded border border-port-border px-3 py-2 text-sm text-gray-200 disabled:opacity-50';
const splitList = (value) => value.split(',').map((entry) => entry.trim()).filter(Boolean);
const accountRules = (form) => ({ guidance: form.guidance, tone: form.tone, allowedThemes: splitList(form.allowedThemes), disallowedThemes: splitList(form.disallowedThemes), escalationCues: splitList(form.escalationCues), desiredEngagement: splitList(form.desiredEngagement), actionBudget: { maxPerHour: Number(form.maxPerHour), maxPerDay: Number(form.maxPerDay), minMinutesBetween: Number(form.minMinutesBetween) } });
const territoryRules = (form) => ({ guidance: form.guidance, tone: form.tone, allowedThemes: splitList(form.allowedThemes), disallowedThemes: splitList(form.disallowedThemes), escalationCues: splitList(form.escalationCues) });
const territoryPayload = (form) => ({
  slug: form.slug,
  label: form.label,
  isOwned: form.isOwned,
  monitoringEnabled: form.monitoringEnabled === '' ? null : form.monitoringEnabled === 'true',
  inheritAccountRules: form.inheritAccountRules,
  rules: territoryRules(form),
});
const accountToForm = (account) => ({
  label: account.label, username: account.username, apiKey: '', clearApiKey: false, enabled: account.enabled,
  monitoringEnabled: account.monitoringEnabled, monitoringIntervalMinutes: account.monitoringIntervalMinutes,
  analysisEnabled: account.analysisEnabled, textModel: account.textModel, visionModel: account.visionModel,
  guidance: account.rules?.guidance || '', tone: account.rules?.tone || '', allowedThemes: (account.rules?.allowedThemes || []).join(', '),
  disallowedThemes: (account.rules?.disallowedThemes || []).join(', '), escalationCues: (account.rules?.escalationCues || []).join(', '),
  desiredEngagement: (account.rules?.desiredEngagement || []).join(', '), maxPerHour: account.rules?.actionBudget?.maxPerHour ?? 3,
  maxPerDay: account.rules?.actionBudget?.maxPerDay ?? 12, minMinutesBetween: account.rules?.actionBudget?.minMinutesBetween ?? 5,
});
const territoryToForm = (territory) => ({
  slug: territory.slug,
  label: territory.label,
  isOwned: territory.isOwned,
  monitoringEnabled: territory.monitoringEnabled == null ? '' : String(territory.monitoringEnabled),
  inheritAccountRules: territory.inheritAccountRules,
  guidance: territory.rules?.guidance || '',
  tone: territory.rules?.tone || '',
  allowedThemes: (territory.rules?.allowedThemes || []).join(', '),
  disallowedThemes: (territory.rules?.disallowedThemes || []).join(', '),
  escalationCues: (territory.rules?.escalationCues || []).join(', '),
});
const sameAccountForm = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export default function StackerNews() {
  const navigate = useNavigate();
  const { accountId } = useParams();
  const tab = useValidTab(TABS, 'review');
  const [searchParams, setSearchParams] = useSearchParams();
  const [accountDrawerTab, setAccountDrawerTab] = useDrawerTab('snAccountTab', 'identity', ACCOUNT_TAB_IDS);
  const localModels = useLocalModels();
  const { idsByProvider: visionIds, loaded: visionLoaded } = useVisionModelIds();
  const [accounts, setAccounts] = useState([]);
  const [territories, setTerritories] = useState([]);
  const [items, setItems] = useState([]);
  const [actions, setActions] = useState([]);
  const [resourcesAccountId, setResourcesAccountId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newAccount, setNewAccount] = useState(emptyAccount);
  const [editAccount, setEditAccount] = useState(emptyAccount);
  const [savedAccount, setSavedAccount] = useState(emptyAccount);
  const [newTerritory, setNewTerritory] = useState(emptyTerritory);
  const [editingTerritoryId, setEditingTerritoryId] = useState(null);
  const [editTerritory, setEditTerritory] = useState(emptyTerritory);
  const [deleteTerritoryId, setDeleteTerritoryId] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [accountFormError, setAccountFormError] = useState('');
  const [analysisResults, setAnalysisResults] = useState({});
  const [feedbackDrafts, setFeedbackDrafts] = useState({});
  const selectedLoadRef = useRef(0);
  const currentAccountIdRef = useRef(accountId);
  const selectedAccountIdRef = useRef(null);
  const savedAccountRef = useRef(emptyAccount);
  currentAccountIdRef.current = accountId;

  const selected = accounts.find((account) => account.id === accountId) || null;
  const activeTab = selected ? tab : 'accounts';
  const accountPath = (id, nextTab = tab) => `/stacker-news/${id}/${nextTab}`;
  // Which account form the drawer is showing, in the URL so the open panel is
  // shareable and reload-safe. `edit` needs a selected account to edit; every
  // account switch navigates by path, which drops the param and closes the drawer.
  const accountFormMode = searchParams.get('snAccount');
  const accountDrawerOpen = accountFormMode === 'new' || (accountFormMode === 'edit' && Boolean(selected));
  const openAccountForm = useCallback((mode) => {
    setAccountFormError('');
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (mode) next.set('snAccount', mode);
      else { next.delete('snAccount'); next.delete('snAccountTab'); }
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const closeAccountForm = useCallback(() => openAccountForm(null), [openAccountForm]);
  const models = useMemo(() => [...new Set(localModels.ollama)], [localModels.ollama]);
  // The vision stage sends images to whatever id is configured, so only models
  // that can actually see one belong in that picker: the server's capability map
  // unioned with the id regex (the regex alone goes stale as new VLM families
  // ship). The text picker keeps the full installed list.
  const visionModels = useMemo(
    () => models.filter((id) => visionLocalModelFilter(id, OLLAMA_PROVIDER, visionIds)),
    [models, visionIds],
  );
  // Distinguish "still asking which models can see" from "asked, none installed" —
  // either fetch still in flight leaves the filtered list empty for a reason that
  // is not "you have no vision model".
  const visionPending = !visionLoaded || localModels.loading;
  const accountFormDirty = selected ? !sameAccountForm(editAccount, savedAccount) : false;
  const accountActionsDisabled = accountFormDirty || Boolean(busy);
  const visibleTerritories = resourcesAccountId === accountId ? territories : [];
  const visibleItems = resourcesAccountId === accountId ? items : [];
  const visibleActions = resourcesAccountId === accountId ? actions : [];

  const loadAccounts = useCallback(async () => {
    const result = await api.getStackerNewsAccounts({ silent: true }).catch((err) => ({ error: err.message }));
    if (result?.error) setError(result.error);
    else setAccounts(result?.accounts || []);
    setLoading(false);
  }, []);

  const loadSelected = useCallback(async () => {
    const requestId = ++selectedLoadRef.current;
    const requestedAccountId = accountId;
    setResourcesAccountId(null);
    setTerritories([]); setItems([]); setActions([]);
    if (!accountId) {
      return;
    }
    const [territoryResult, itemResult, actionResult] = await Promise.all([
      api.getStackerNewsTerritories(accountId, { silent: true }).catch((err) => ({ error: err.message, territories: [] })),
      api.getStackerNewsItems(accountId, { silent: true }).catch((err) => ({ error: err.message, items: [] })),
      api.getStackerNewsActions(accountId, { silent: true }).catch((err) => ({ error: err.message, actions: [] })),
    ]);
    if (selectedLoadRef.current !== requestId || currentAccountIdRef.current !== requestedAccountId) return;
    const failed = [territoryResult, itemResult, actionResult].find((result) => result.error);
    if (failed) setError(failed.error);
    setTerritories(territoryResult.territories || []);
    setItems(itemResult.items || []);
    setActions(actionResult.actions || []);
    setResourcesAccountId(requestedAccountId);
  }, [accountId]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadSelected(); }, [loadSelected]);
  useEffect(() => {
    setEditingTerritoryId(null);
    setEditTerritory(emptyTerritory);
    setDeleteTerritoryId(null);
  }, [accountId]);
  useEffect(() => {
    if (!selected) {
      selectedAccountIdRef.current = null;
      return;
    }
    const nextSaved = accountToForm(selected);
    const switchedAccounts = selectedAccountIdRef.current !== selected.id;
    setEditAccount((current) => switchedAccounts || sameAccountForm(current, savedAccountRef.current) ? nextSaved : current);
    selectedAccountIdRef.current = selected.id;
    savedAccountRef.current = nextSaved;
    setSavedAccount(nextSaved);
  }, [selected]);

  const finish = (key, promise, onSuccess) => {
    setBusy(key); setError(''); setNotice('');
    promise.then(onSuccess, (err) => setError(err.message)).finally(() => setBusy(''));
  };

  // Save can fire from any drawer tab, so reject on the first invalid field and
  // switch to the tab that holds it rather than failing silently server-side.
  const rejectInvalidAccount = (form) => {
    const invalid = validateAccountForm(form);
    if (!invalid) { setAccountFormError(''); return false; }
    setAccountDrawerTab(invalid.tab);
    setAccountFormError(invalid.message);
    return true;
  };

  const createAccount = (event) => {
    event.preventDefault();
    if (rejectInvalidAccount(newAccount)) return;
    finish('create-account', api.createStackerNewsAccount({
      label: newAccount.label, username: newAccount.username, enabled: newAccount.enabled, ...(newAccount.apiKey ? { apiKey: newAccount.apiKey } : {}),
      monitoringEnabled: newAccount.monitoringEnabled, monitoringIntervalMinutes: Number(newAccount.monitoringIntervalMinutes),
      analysisEnabled: newAccount.analysisEnabled, textModel: newAccount.textModel, visionModel: newAccount.visionModel,
      rules: accountRules(newAccount),
    }, { silent: true }), (result) => {
      setAccounts((previous) => [...previous, result]); setNewAccount(emptyAccount); navigate(accountPath(result.id, 'accounts'));
    });
  };

  const saveAccount = (event) => {
    event.preventDefault();
    if (!selected) return;
    if (rejectInvalidAccount(editAccount)) return;
    const savedAccountId = selected.id;
    finish('save-account', api.updateStackerNewsAccount(savedAccountId, {
      label: editAccount.label, username: editAccount.username, enabled: editAccount.enabled,
      ...(editAccount.clearApiKey ? { apiKey: '' } : editAccount.apiKey ? { apiKey: editAccount.apiKey } : {}),
      monitoringEnabled: editAccount.monitoringEnabled, monitoringIntervalMinutes: Number(editAccount.monitoringIntervalMinutes),
      analysisEnabled: editAccount.analysisEnabled, textModel: editAccount.textModel, visionModel: editAccount.visionModel,
      rules: accountRules(editAccount),
    }, { silent: true }), (result) => {
      setAccounts((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
      if (currentAccountIdRef.current !== savedAccountId) return;
      const nextSaved = accountToForm(result);
      savedAccountRef.current = nextSaved;
      setSavedAccount(nextSaved);
      setEditAccount(nextSaved);
      closeAccountForm();
      setNotice('Account rules and schedule saved.');
    });
  };

  const createTerritory = (event) => {
    event.preventDefault();
    if (!selected) return;
    finish('create-territory', api.createStackerNewsTerritory({
      accountId: selected.id, ...territoryPayload(newTerritory),
    }, { silent: true }), (result) => {
      setTerritories((previous) => [...previous, result]); setNewTerritory(emptyTerritory);
    });
  };

  const saveTerritory = (event) => {
    event.preventDefault();
    if (!editingTerritoryId) return;
    finish(`save-territory-${editingTerritoryId}`, api.updateStackerNewsTerritory(editingTerritoryId, territoryPayload(editTerritory), { silent: true }), (result) => {
      setTerritories((previous) => previous.map((territory) => territory.id === result.id ? result : territory));
      setEditingTerritoryId(null); setEditTerritory(emptyTerritory); setNotice('Community settings saved.');
    });
  };

  const removeTerritory = (territory) => finish(`delete-territory-${territory.id}`, api.deleteStackerNewsTerritory(territory.id, { silent: true }), () => {
    setTerritories((previous) => previous.filter((candidate) => candidate.id !== territory.id));
    setDeleteTerritoryId(null);
    if (editingTerritoryId === territory.id) { setEditingTerritoryId(null); setEditTerritory(emptyTerritory); }
    setNotice('Community removed.');
  });

  const checkConnection = () => selected && finish('verify', api.verifyStackerNewsAccount(selected.id, { silent: true }), (result) => {
    setNotice(!result.connected ? 'Add an API key before testing.' : `API identity: @${result.username}. ${result.matchesConfigured ? 'Matches this account.' : 'Mismatch: writes are blocked.'}`);
  });
  const checkBrowser = () => selected && finish('browser', api.getStackerNewsBrowserIdentity(selected.id, { silent: true }), (result) => {
    setNotice(`Pinned browser identity: @${result.username || 'unknown'}. ${result.matchesConfigured ? 'Matches this account.' : 'Mismatch: handoffs are blocked.'}`);
  });
  const syncNow = () => selected && finish('sync', api.syncStackerNewsAccount(selected.id, { silent: true }), async (result) => {
    setNotice(`Sync complete: ${result.ingested} item(s), ${result.analyzed} analyzed.`); await Promise.all([loadAccounts(), loadSelected()]);
  });
  const analyze = (item) => finish(`analyze-${item.id}`, api.analyzeStackerNewsItem(item.id, { silent: true }), (result) => {
    setAnalysisResults((previous) => ({ ...previous, [item.id]: result }));
    setNotice(result.stale ? 'Content changed during analysis; the stale result cannot drive an action.' : `Policy decision: ${result.policy?.decision || 'review'}.`);
  });
  const saveFeedback = (item) => {
    const analysisId = analysisResults[item.id]?.analysisId;
    const feedback = feedbackDrafts[item.id]?.trim();
    if (!analysisId || !feedback) return;
    finish(`feedback-${item.id}`, api.addStackerNewsAnalysisFeedback(analysisId, feedback, { silent: true }), () => {
      setFeedbackDrafts((previous) => ({ ...previous, [item.id]: '' })); setNotice('Moderator feedback recorded with the policy version.');
    });
  };

  const createAction = (event) => {
    event.preventDefault();
    if (!selected) return;
    const isPost = draft.kind.endsWith('_post');
    const isComment = draft.kind.endsWith('_comment');
    const data = {
      accountId: selected.id,
      kind: draft.kind,
      ...(isPost || draft.destination === 'territory_settings' ? { territoryId: draft.territoryId } : {}),
      ...(isComment || draft.destination === 'item' ? { itemId: draft.itemId } : {}),
      ...(draft.kind === 'open_browser' ? { destination: draft.destination, payload: {} } : {}),
      ...(isPost ? { payload: { title: draft.title, body: draft.body } } : {}),
      ...(isComment ? { payload: { body: draft.body } } : {}),
    };
    finish('create-action', api.createStackerNewsAction(data, { silent: true }), (result) => {
      setActions((previous) => [result, ...previous]); setDraft(emptyDraft); navigate(accountPath(selected.id, 'review'));
    });
  };

  const reviewAction = (action, state) => finish(`review-${action.id}`, api.reviewStackerNewsAction(action.id, { state }, { silent: true }), (result) => {
    setActions((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
  });
  const executeAction = (action) => finish(`execute-${action.id}`, api.executeStackerNewsAction(action.id, { silent: true }), (result) => {
    setActions((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
    setNotice(result.state === 'completed' ? 'Reviewed action completed.' : `Action failed safely: ${result.error}`);
  });

  // Every scoped list is filtered to the selected account, so each section says
  // whose workspace it is showing rather than reading as a global list.
  const scope = selected ? `@${selected.username}` : '';

  const renderReview = () => (
    <div className="grid gap-3 xl:grid-cols-2">
      <section className="rounded border border-port-border bg-port-card p-4">
        <h2 className="font-semibold text-white">Approval queue for {scope}</h2>
        <p className="mt-1 text-sm text-gray-400">Approval and execution are separate. Identity, content freshness, rules, budgets, and idempotency are rechecked at execution.</p>
        <div className="mt-3 space-y-2">
          {visibleActions.filter((action) => ['pending_review', 'approved'].includes(action.state)).map((action) => (
            <div key={action.id} className="rounded border border-port-border p-3 text-sm">
              <div className="flex items-center justify-between gap-2"><span className="font-medium text-white">{action.kind.replaceAll('_', ' ')}</span><span className="text-xs text-gray-400">{action.state.replaceAll('_', ' ')}</span></div>
              <div className="mt-1 whitespace-pre-wrap text-gray-400">{action.payload?.title || action.payload?.body || `Fixed ${action.destination || 'local'} action`}</div>
              <div className="mt-1 text-xs text-gray-400">Reviewed target: @{action.reviewedTarget?.username || selected.username}{action.reviewedTarget?.territorySlug ? ` · ${action.reviewedTarget.territorySlug}` : ''}{action.reviewedTarget?.remoteItemId ? ` · item ${action.reviewedTarget.remoteItemId}` : ''}</div>
              <div className="mt-1 font-mono text-[11px] text-gray-500">content {action.sourceContentHash?.slice(0, 10) || 'n/a'} · rules {action.rulesHash?.slice(0, 10) || 'n/a'} · {action.policyVersion}</div>
              {action.state === 'pending_review' && <div className="mt-2 flex gap-2"><button className={buttonClass} disabled={busy === `review-${action.id}`} onClick={() => reviewAction(action, 'approved')}>Approve</button><button className={secondaryButton} onClick={() => reviewAction(action, 'rejected')}>Reject</button></div>}
              {action.state === 'approved' && <button className={`${buttonClass} mt-2`} disabled={busy === `execute-${action.id}`} onClick={() => executeAction(action)}>Execute reviewed action</button>}
            </div>
          ))}
          {!visibleActions.some((action) => ['pending_review', 'approved'].includes(action.state)) && <p className="text-sm text-gray-500">No actions are waiting for {scope}.</p>}
        </div>
      </section>
      <section className="rounded border border-port-border bg-port-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold text-white">Monitored content for {scope}</h2><p className="text-sm text-gray-400">Remote text and images remain untrusted data.</p></div><button className={secondaryButton} disabled={accountActionsDisabled} onClick={syncNow}>Sync now</button></div>
        <div className="mt-3 space-y-2">{visibleItems.map((item) => <div key={item.id} className="rounded border border-port-border p-3"><div className="text-sm font-medium text-white">{item.title || `${item.kind} by @${item.authorName}`}</div><div className="mt-1 line-clamp-3 text-sm text-gray-400">{item.body}</div>{analysisResults[item.id] && <div className="mt-2 rounded bg-port-bg p-2 text-xs text-gray-300">Policy: {analysisResults[item.id].stale ? 'stale' : analysisResults[item.id].policy?.decision || 'review'}{analysisResults[item.id].policy?.reasons?.length ? ` · ${analysisResults[item.id].policy.reasons.join(', ')}` : ''}<div className="mt-2 flex gap-2"><input aria-label={`Feedback for ${item.title || item.id}`} className={fieldClass} placeholder="Moderator feedback" value={feedbackDrafts[item.id] || ''} onChange={(event) => setFeedbackDrafts((previous) => ({ ...previous, [item.id]: event.target.value }))} /><button className={secondaryButton} disabled={!analysisResults[item.id].analysisId || busy === `feedback-${item.id}`} onClick={() => saveFeedback(item)}>Save feedback</button></div></div>}<button className={`${secondaryButton} mt-2`} disabled={busy === `analyze-${item.id}`} onClick={() => analyze(item)}>Run local analysis</button></div>)}{!visibleItems.length && <p className="text-sm text-gray-500">No stored content for {scope}. Add a territory, then sync explicitly or enable a schedule.</p>}</div>
      </section>
    </div>
  );

  const renderTerritory = () => (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded border border-port-border bg-port-card p-4">
        <h2 className="font-semibold text-white">Communities for {scope}</h2>
        <div className="mt-3 space-y-2">
          {visibleTerritories.map((territory) => editingTerritoryId === territory.id ? (
            <TerritoryForm key={territory.id} prefix={`edit-territory-${territory.id}`} title={`Edit ${territory.label || territory.slug}`} form={editTerritory} setForm={setEditTerritory} onSubmit={saveTerritory} busy={busy === `save-territory-${territory.id}`} onCancel={() => { setEditingTerritoryId(null); setEditTerritory(emptyTerritory); }} submitLabel="Save community" />
          ) : (
            <div key={territory.id} className="rounded border border-port-border p-3">
              <div className="flex justify-between gap-2"><span className="font-medium text-white">{territory.label || territory.slug}</span><span className="text-xs text-gray-400">{territory.isOwned ? (territory.remoteSettings?.ownershipVerified ? 'Ownership verified' : 'Owned · not verified') : 'Monitored'}</span></div>
              <p className="mt-1 text-sm text-gray-400">{territory.rules?.guidance || (territory.inheritAccountRules ? 'Inherits account rules.' : 'No custom guidance.')}</p>
              <div className="mt-1 text-xs text-gray-500">Monitoring: {territory.monitoringEnabled == null ? 'inherit account' : territory.monitoringEnabled ? 'on' : 'off'}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={secondaryButton} onClick={() => { setEditingTerritoryId(territory.id); setEditTerritory(territoryToForm(territory)); setDeleteTerritoryId(null); }}>Edit</button>
                {deleteTerritoryId === territory.id ? <><button type="button" className={secondaryButton} onClick={() => setDeleteTerritoryId(null)}>Cancel</button><button type="button" className="rounded bg-port-error px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy === `delete-territory-${territory.id}`} onClick={() => removeTerritory(territory)}>Confirm delete</button></> : <button type="button" className={secondaryButton} onClick={() => setDeleteTerritoryId(territory.id)}>Delete</button>}
              </div>
            </div>
          ))}
          {!visibleTerritories.length && <p className="text-sm text-gray-500">Add communities {scope} monitors or owns.</p>}
        </div>
      </section>
      <TerritoryForm prefix="new-territory" title={`Add community to ${scope}`} form={newTerritory} setForm={setNewTerritory} onSubmit={createTerritory} busy={busy === 'create-territory'} submitLabel="Add community" />
    </div>
  );

  const renderDrafts = () => {
    const post = draft.kind.endsWith('_post');
    const comment = draft.kind.endsWith('_comment');
    return <form className="mx-auto max-w-2xl rounded border border-port-border bg-port-card p-4" onSubmit={createAction}><h2 className="font-semibold text-white">Prepare a review-gated action for {scope}</h2><p className="mt-1 text-sm text-gray-400">Wallet actions are browser handoffs only. Publishing uses the constrained API after separate approval.</p><div className="mt-3 space-y-3"><Field id="action-kind" label="Action"><select id="action-kind" className={fieldClass} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}><option value="draft_comment">Local comment draft</option><option value="publish_comment">Publish comment after review</option><option value="draft_post">Local post draft</option><option value="publish_post">Publish post after review</option><option value="open_browser">Open fixed browser handoff</option></select></Field>{draft.kind === 'open_browser' && <Field id="action-destination" label="Handoff"><select id="action-destination" className={fieldClass} value={draft.destination} onChange={(event) => setDraft({ ...draft, destination: event.target.value })}><option value="item">Item (zap, downzap, boost, or manual interaction)</option><option value="territory_settings">Territory settings</option></select></Field>}{(comment || (draft.kind === 'open_browser' && draft.destination === 'item')) && <Field id="action-item" label="Source item"><select id="action-item" required className={fieldClass} value={draft.itemId} onChange={(event) => setDraft({ ...draft, itemId: event.target.value })}><option value="">Choose item</option>{visibleItems.map((item) => <option key={item.id} value={item.id}>{item.title || `${item.kind} by ${item.authorName}`}</option>)}</select></Field>}{(post || (draft.kind === 'open_browser' && draft.destination === 'territory_settings')) && <Field id="action-territory" label="Territory"><select id="action-territory" required className={fieldClass} value={draft.territoryId} onChange={(event) => setDraft({ ...draft, territoryId: event.target.value })}><option value="">Choose territory</option>{visibleTerritories.map((territory) => <option key={territory.id} value={territory.id}>{territory.label || territory.slug}</option>)}</select></Field>}{post && <Field id="action-title" label="Title"><input id="action-title" required className={fieldClass} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>}{(post || comment) && <Field id="action-body" label="Draft text"><textarea id="action-body" required className={fieldClass} rows="6" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></Field>}<button className={buttonClass} disabled={busy === 'create-action'}>Send to approval queue</button></div></form>;
  };

  const renderAccounts = () => (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded border border-port-border bg-port-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-white">Accounts</h2><button type="button" className={buttonClass} onClick={() => openAccountForm('new')}>Add account</button></div>
        <div className="mt-3 space-y-2">{accounts.map((account) => <button key={account.id} className={`block w-full rounded border p-3 text-left ${account.id === selected?.id ? 'border-port-accent' : 'border-port-border'}`} onClick={() => navigate(accountPath(account.id, 'accounts'))}><div className="flex justify-between gap-2"><span className="font-medium text-white">{account.label}</span><span className="text-xs text-gray-400">{account.apiKeyConfigured ? 'Key protected' : 'No key'}</span></div><div className="mt-1 text-sm text-gray-400">@{account.username} · {account.monitoringEnabled ? `every ${account.monitoringIntervalMinutes}m` : 'monitoring off'}</div></button>)}{!accounts.length && <p className="text-sm text-gray-500">No accounts configured.</p>}</div>
      </section>
      {selected ? (
        <section className="rounded border border-port-border bg-port-card p-4">
          <h2 className="font-semibold text-white">Settings and safety for {scope}</h2>
          <p className="mt-1 text-sm text-gray-400">{selected.label} · {selected.monitoringEnabled ? `monitored every ${selected.monitoringIntervalMinutes}m` : 'monitoring off'} · {selected.apiKeyConfigured ? 'API key stored' : 'no API key stored'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => openAccountForm('edit')}>Edit account settings</button>
            <button type="button" className={secondaryButton} disabled={accountActionsDisabled} onClick={checkConnection}>Check API identity</button>
            <button type="button" className={secondaryButton} disabled={accountActionsDisabled} onClick={checkBrowser}>Check browser identity</button>
            <button type="button" className={secondaryButton} disabled={accountActionsDisabled} onClick={syncNow}>Sync now</button>
          </div>
          {/* These three read server-side saved state, so an unsaved edit would
              silently not apply — say why they are disabled instead of leaving
              the user to guess (the checks are also disabled mid-save). Closing
              the drawer deliberately keeps the draft so a half-finished 19-field
              edit survives a detour, which means the only way back out of the
              disabled state has to be an explicit discard. */}
          {accountFormDirty && <div className="mt-3 flex flex-wrap items-center gap-2"><p className="text-sm text-port-warning">Unsaved changes to {scope}. Save the account before running these checks.</p><button type="button" className={secondaryButton} disabled={Boolean(busy)} onClick={() => { setEditAccount(savedAccount); setAccountFormError(''); }}>Discard changes</button></div>}
        </section>
      ) : <div className="rounded border border-port-border bg-port-card p-4 text-sm text-gray-400">Choose an account to edit its independent rules, models, and monitoring schedule.</div>}
    </div>
  );

  const accountDrawer = accountDrawerOpen && (
    <AccountDrawer
      mode={accountFormMode}
      username={accountFormMode === 'edit' ? selected?.username : ''}
      activeTab={accountDrawerTab}
      onTabChange={setAccountDrawerTab}
      onClose={closeAccountForm}
      formError={accountFormError}
      form={accountFormMode === 'edit' ? editAccount : newAccount}
      setForm={accountFormMode === 'edit' ? setEditAccount : setNewAccount}
      models={models}
      visionModels={visionModels}
      visionPending={visionPending}
      onSubmit={accountFormMode === 'edit' ? saveAccount : createAccount}
      busy={busy === (accountFormMode === 'edit' ? 'save-account' : 'create-account')}
      submitLabel={accountFormMode === 'edit' ? 'Save account' : 'Add protected account'}
      canClearCredential={accountFormMode === 'edit' && Boolean(selected?.apiKeyConfigured)}
    />
  );

  // Rendered into the page header, so the account in scope is switchable from
  // every tab instead of only from Accounts & Safety. Switching keeps the
  // current tab (accountPath defaults to it) and drops the drawer search params.
  const accountSwitcher = accounts.length ? (
    <>
      <label htmlFor="sn-account-switcher" className="sr-only">Stacker News account in scope</label>
      <select id="sn-account-switcher" className="max-w-[16rem] rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-white" value={selected?.id || ''} onChange={(event) => navigate(accountPath(event.target.value, activeTab))}>
        {!selected && <option value="">Choose an account</option>}
        {accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · @{account.username}</option>)}
      </select>
    </>
  ) : null;

  if (loading) return <PageSkeleton header="bar" label="Loading Stacker News" tabs={TABS.length} cards={3} />;
  const notFound = accountId && !selected;
  return <div className="flex h-full min-h-0 flex-col"><PageHeader icon={Newspaper} title="Stacker News" subtitle="Review-gated multi-account community stewardship" actions={accountSwitcher} /><TabPills tabs={TABS} activeTab={activeTab} onChange={(nextTab) => selected ? navigate(accountPath(selected.id, nextTab)) : navigate('/stacker-news')} ariaLabel="Stacker News sections" /><main className="flex-1 overflow-auto p-4">{error && <div className="mb-3 rounded border border-port-error p-3 text-sm text-port-error">{error}</div>}{notice && <div className="mb-3 rounded border border-port-border p-3 text-sm text-gray-200">{notice}</div>}{notFound && <div className="mb-3 rounded border border-port-error p-4 text-sm text-port-error">This Stacker News account was not found. <button className="underline" onClick={() => navigate('/stacker-news')}>Return to accounts.</button></div>}{activeTab === 'review' && selected && renderReview()}{activeTab === 'territory' && selected && renderTerritory()}{activeTab === 'drafts' && selected && renderDrafts()}{activeTab === 'activity' && selected && <section className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">Action ledger for {scope}</h2><div className="mt-3 space-y-2">{visibleActions.map((action) => <div key={action.id} className="rounded border border-port-border p-3 text-sm text-gray-300"><div>{action.kind.replaceAll('_', ' ')} · {action.state}</div>{action.error && <div className="mt-1 text-port-error">{action.error}</div>}{action.result?.handoffOpened && <div className="mt-1 text-gray-400">Fixed browser handoff opened.</div>}</div>)}{!visibleActions.length && <p className="text-sm text-gray-500">No actions recorded for {scope}.</p>}</div></section>}{activeTab === 'accounts' && renderAccounts()}</main>{accountDrawer}</div>;
}

function Field({ id, label, children }) {
  return <div><label htmlFor={id} className="mb-1 block text-sm text-gray-300">{label}</label>{children}</div>;
}

// The 19-field account config, grouped into Drawer tabs. All of its state lives
// in the page (newAccount / editAccount) because the Drawer body remounts on
// every tab switch (`key={currentTab}`) — an uncontrolled input here would
// silently lose what the user typed the moment they changed tabs.
function AccountDrawer({ mode, username, activeTab, onTabChange, onClose, formError, form, setForm, models, visionModels, visionPending, onSubmit, busy, submitLabel, canClearCredential }) {
  const update = (key, value) => setForm((previous) => ({
    ...previous,
    [key]: value,
    ...(key === 'apiKey' && value ? { clearApiKey: false } : {}),
    ...(key === 'clearApiKey' && value ? { apiKey: '' } : {}),
  }));
  const isNew = mode !== 'edit';
  const prefix = isNew ? 'new-account' : 'edit-account';
  const checkbox = (key, label) => <label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={form[key]} onChange={(event) => update(key, event.target.checked)} /> {label}</label>;
  const textField = (id, label, key) => <Field id={`${prefix}-${id}`} label={label}><input id={`${prefix}-${id}`} className={fieldClass} value={form[key]} onChange={(event) => update(key, event.target.value)} /></Field>;
  const numberField = (id, label, key, min, max) => <Field id={`${prefix}-${id}`} label={label}><input id={`${prefix}-${id}`} type="number" min={min} max={max} className={fieldClass} value={form[key]} onChange={(event) => update(key, event.target.value)} /></Field>;
  return (
    <Drawer
      open
      onClose={onClose}
      title={isNew ? 'Add account' : 'Edit account'}
      subtitle={isNew ? 'Credentials are encrypted separately and never sent to a model.' : `@${username}`}
      size="lg"
      tabs={ACCOUNT_TABS}
      activeTab={activeTab}
      onTabChange={onTabChange}
      // Long-lived form: an Esc keystroke or a stray backdrop click mid-edit
      // must not discard 19 fields of configuration.
      closeOnEsc={false}
      closeOnBackdrop={false}
      closeLabel="Close account settings"
    >
      {formError && <div className="mb-3 rounded border border-port-error p-3 text-sm text-port-error">{formError}</div>}
      <form className="space-y-3" onSubmit={onSubmit}>
        {activeTab === 'identity' && <>
          <Field id={`${prefix}-label`} label="Local label"><input id={`${prefix}-label`} required className={fieldClass} value={form.label} onChange={(event) => update('label', event.target.value)} /></Field>
          <Field id={`${prefix}-username`} label="Stacker News username"><input id={`${prefix}-username`} required className={fieldClass} value={form.username} onChange={(event) => update('username', event.target.value)} /></Field>
          <Field id={`${prefix}-api-key`} label={isNew ? 'API key (optional)' : 'Replace API key (leave blank to keep)'}><input id={`${prefix}-api-key`} type="password" className={fieldClass} disabled={form.clearApiKey} value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} /></Field>
          {canClearCredential && checkbox('clearApiKey', 'Remove stored API key when saving')}
          {checkbox('enabled', 'Account enabled')}
        </>}
        {activeTab === 'monitoring' && <>
          {checkbox('monitoringEnabled', 'Enable scheduled monitoring')}
          {numberField('interval', 'Monitoring interval (minutes)', 'monitoringIntervalMinutes', 5, 1440)}
          {checkbox('analysisEnabled', 'Run configured local analysis during monitoring')}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field id={`${prefix}-text-model`} label="Ollama text model"><ModelSelect id={`${prefix}-text-model`} value={form.textModel} models={models} onChange={(value) => update('textModel', value)} /></Field>
            <Field id={`${prefix}-vision-model`} label="Ollama vision model"><ModelSelect id={`${prefix}-vision-model`} value={form.visionModel} models={visionModels} onChange={(value) => update('visionModel', value)} />{visionPending ? <p className="mt-1 text-xs text-gray-400">Checking which installed Ollama models can read an image…</p> : !visionModels.length ? <p className="mt-1 text-xs text-port-warning">No vision-capable Ollama model installed. Install one (e.g. a qwen-vl or llava model) to analyze images.</p> : null}</Field>
          </div>
        </>}
        {activeTab === 'stewardship' && <>
          <Field id={`${prefix}-guidance`} label="Stewardship guidance"><textarea id={`${prefix}-guidance`} className={fieldClass} rows="3" value={form.guidance} onChange={(event) => update('guidance', event.target.value)} /></Field>
          {textField('tone', 'Tone', 'tone')}
          {textField('allowed', 'Allowed themes', 'allowedThemes')}
          {textField('disallowed', 'Disallowed themes', 'disallowedThemes')}
          {textField('escalation', 'Escalation cues', 'escalationCues')}
          {textField('engagement', 'Desired engagement', 'desiredEngagement')}
        </>}
        {activeTab === 'budgets' && <div className="grid gap-2 sm:grid-cols-3">
          {numberField('hour-budget', 'Max/hour', 'maxPerHour', 1, 50)}
          {numberField('day-budget', 'Max/day', 'maxPerDay', 1, 200)}
          {numberField('spacing', 'Spacing min', 'minMinutesBetween', 0, 1440)}
        </div>}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" className={secondaryButton} onClick={onClose}>Close</button>
          <button className={buttonClass} disabled={busy}>{submitLabel}</button>
        </div>
      </form>
    </Drawer>
  );
}

function TerritoryForm({ prefix, title, form, setForm, onSubmit, busy, submitLabel, onCancel = null }) {
  const update = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
  return <form className="rounded border border-port-border bg-port-card p-4" onSubmit={onSubmit}><h2 className="font-semibold text-white">{title}</h2><div className="mt-3 space-y-3"><Field id={`${prefix}-slug`} label="Territory slug"><input id={`${prefix}-slug`} required className={fieldClass} value={form.slug} onChange={(event) => update('slug', event.target.value)} /></Field><Field id={`${prefix}-label`} label="Local label"><input id={`${prefix}-label`} className={fieldClass} value={form.label} onChange={(event) => update('label', event.target.value)} /></Field><label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={form.isOwned} onChange={(event) => update('isOwned', event.target.checked)} /> This account owns this community</label><label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={form.inheritAccountRules} onChange={(event) => update('inheritAccountRules', event.target.checked)} /> Inherit account rules</label><Field id={`${prefix}-monitoring`} label="Monitoring override"><select id={`${prefix}-monitoring`} className={fieldClass} value={form.monitoringEnabled} onChange={(event) => update('monitoringEnabled', event.target.value)}><option value="">Inherit account</option><option value="true">Enabled</option><option value="false">Disabled</option></select></Field><Field id={`${prefix}-rules`} label="Territory guidance"><textarea id={`${prefix}-rules`} className={fieldClass} rows="3" value={form.guidance} onChange={(event) => update('guidance', event.target.value)} /></Field><Field id={`${prefix}-tone`} label="Tone override"><input id={`${prefix}-tone`} className={fieldClass} value={form.tone} onChange={(event) => update('tone', event.target.value)} /></Field><Field id={`${prefix}-allowed`} label="Allowed themes"><input id={`${prefix}-allowed`} className={fieldClass} value={form.allowedThemes} onChange={(event) => update('allowedThemes', event.target.value)} /></Field><Field id={`${prefix}-disallowed`} label="Disallowed themes"><input id={`${prefix}-disallowed`} className={fieldClass} value={form.disallowedThemes} onChange={(event) => update('disallowedThemes', event.target.value)} /></Field><Field id={`${prefix}-escalation`} label="Escalation cues"><input id={`${prefix}-escalation`} className={fieldClass} value={form.escalationCues} onChange={(event) => update('escalationCues', event.target.value)} /></Field><div className="flex gap-2">{onCancel && <button type="button" className={secondaryButton} onClick={onCancel}>Cancel</button>}<button className={buttonClass} disabled={busy}>{submitLabel}</button></div></div></form>;
}

function ModelSelect({ id, value, models, onChange }) {
  return <select id={id} className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Disabled</option>{value && !models.includes(value) && <option value={value}>{value} (configured)</option>}{models.map((model) => <option key={model} value={model}>{model}</option>)}</select>;
}
