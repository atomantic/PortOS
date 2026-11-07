import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Bot, Code2, Orbit, Sparkles } from 'lucide-react';
import * as api from '../../services/api';
import useDrawerTab from '../../hooks/useDrawerTab';
import useLatestRequest from '../../hooks/useLatestRequest';
import { uuidv4 } from '../../lib/uuid';
import { formatCount } from '../../utils/formatters';
import Drawer from '../Drawer';
import BrailleSpinner from '../BrailleSpinner';

const PROVIDERS = [
  { id: 'codex', label: 'Codex', icon: Code2 },
  { id: 'claude', label: 'Claude Code', icon: Bot },
  { id: 'grok', label: 'Grok', icon: Sparkles },
  { id: 'agy', label: 'Antigravity', icon: Orbit },
];
const PROVIDER_IDS = PROVIDERS.map(provider => provider.id);
const HISTORY_SCOPE = 'operator-confirmed-retained-history';
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-port-border px-3 py-2 text-sm text-white hover:bg-port-border/30 disabled:opacity-50';
const participantLabel = participant => `${participant.kind === 'local' ? 'This instance' : participant.kind === 'peer' ? 'Peer' : 'Missing saved member'} · ${participant.participantKey.slice(0, 12)}`;
const toDraft = selections => selections.map(selection => ({ ...selection, id: uuidv4(), originalMembers: selection.members }));
const toSelections = rows => rows.map(({ id: _id, originalMembers: _members, ...row }) => row);

function validateRows(rows) {
  const labels = new Set();
  const members = new Set();
  for (const row of rows) {
    const fail = message => ({ family: row.family, message });
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.accountLabel)) return fail('Use an opaque label of 1–64 lowercase letters, numbers, underscores or hyphens, starting with a letter or number.');
    const labelKey = `${row.family}:${row.accountLabel}`;
    if (labels.has(labelKey)) return fail('Account labels must be distinct within a provider.');
    labels.add(labelKey);
    if (!row.members.length) return fail('Select at least one member for each account.');
    if (row.members.length > 64) return fail('Select at most 64 members for each account.');
    for (const member of row.members) {
      const memberKey = `${row.family}:${member}`;
      if (members.has(memberKey)) return fail('A member can belong to only one account per provider. Remove the duplicate selection.');
      members.add(memberKey);
    }
    if (row.family === 'codex' && !row.members.includes(row.authoritativeParticipant)) return fail('Choose exactly one selected member as the authoritative Codex snapshot.');
    if (row.family !== 'codex' && row.historyScope !== HISTORY_SCOPE) return fail('Confirm that the selected retained history belongs to this account. A shared current sign-in is not history proof.');
  }
  return null;
}

function AccountRow({ row, number, participants, disabled, onChange, onRemove }) {
  const retained = row.family !== 'codex';
  const available = participants.filter(participant => participant.status === 'configured' || row.originalMembers.includes(participant.participantKey));
  const selectMember = (key, checked) => onChange({
    members: checked ? [...row.members, key] : row.members.filter(member => member !== key),
    ...(retained ? { historyScope: '' } : !checked && row.authoritativeParticipant === key ? { authoritativeParticipant: '' } : {}),
  });
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 rounded-xl border border-port-border p-3">
    <legend className="px-1 text-sm font-medium text-white">Account {formatCount(number)}</legend>
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-48">
        <label htmlFor={`${row.id}-label`} className="mb-1 block text-sm text-gray-300">Opaque account label</label>
        <input id={`${row.id}-label`} value={row.accountLabel} maxLength={64} onChange={event => onChange({ accountLabel: event.target.value, ...(retained ? { historyScope: '' } : {}) })}
          placeholder="example-subscription" autoComplete="off" spellCheck={false} className="min-h-11 w-full min-w-0 rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white" />
      </div>
      <button type="button" onClick={onRemove} className={buttonClass} aria-label={`Remove account ${formatCount(number)}`}>Remove</button>
    </div>
    <p className="text-xs text-gray-400">Use a nickname, not an email, login or account identifier. Keep separate subscriptions in separate rows.</p>
    <fieldset className="min-w-0 space-y-1">
      <legend className="mb-1 text-sm text-gray-300">Account members</legend>
      {available.length ? available.map(participant => {
        const selected = row.members.includes(participant.participantKey);
        const unavailable = participant.status !== 'configured';
        return <div key={participant.participantKey} className="flex min-w-0 items-start gap-2 rounded px-1 py-2">
          <input id={`${row.id}-${participant.participantKey}`} type="checkbox" checked={selected} onChange={event => selectMember(participant.participantKey, event.target.checked)} className="mt-1 shrink-0" />
          <label htmlFor={`${row.id}-${participant.participantKey}`} className="min-w-0 break-words text-sm text-gray-300">
            {participantLabel(participant)}{unavailable && <span className="block text-xs text-port-warning">Not in the current configured inventory. Kept until you explicitly remove it; missing history is not zero.</span>}
          </label>
        </div>;
      }) : <p className="text-sm text-port-warning">No configured participant identities are available. Check the instance and peer setup, then reload this editor.</p>}
    </fieldset>
    {retained ? <div className="flex min-w-0 items-start gap-2 rounded border border-port-border p-3">
      <input id={`${row.id}-history`} type="checkbox" checked={row.historyScope === HISTORY_SCOPE} onChange={event => onChange({ historyScope: event.target.checked ? HISTORY_SCOPE : '' })} className="mt-1 shrink-0" />
      <label htmlFor={`${row.id}-history`} className="min-w-0 text-sm text-gray-300">I confirm the retained history on all selected members belongs to this account, not just their current sign-in.</label>
    </div> : <div className="min-w-0">
      <label htmlFor={`${row.id}-authority`} className="mb-1 block text-sm text-gray-300">Authoritative Codex snapshot</label>
      <select id={`${row.id}-authority`} value={row.authoritativeParticipant} onChange={event => onChange({ authoritativeParticipant: event.target.value })} className="min-h-11 w-full min-w-0 max-w-full rounded border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
        <option value="">Choose one selected member</option>
        {participants.filter(participant => row.members.includes(participant.participantKey)).map(participant => <option key={participant.participantKey} value={participant.participantKey}>{participantLabel(participant)}</option>)}
      </select>
      <p className="mt-1 text-xs text-gray-400">One authoritative account snapshot is shown once. Snapshots from other members are never added together.</p>
    </div>}
  </fieldset>;
}

export default function NativeAccountEditor({ onClose, onLoaded, onSave, onDraftChange, savePending, getInvalidation, invalidation }) {
  const [activeTab, setActiveTab] = useDrawerTab('nativeAccountTab', 'codex', PROVIDER_IDS);
  // Drawer remounts each tab panel. All providers' drafts stay above that boundary.
  const [model, setModel] = useState(null);
  const [rows, setRows] = useState([]);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);
  const [saved, setSaved] = useState(false);
  const pendingSave = useRef(false);
  const beginRequest = useLatestRequest();
  const load = useCallback(async () => {
    if (pendingSave.current) return;
    const isCurrent = beginRequest();
    const initialInvalidation = getInvalidation();
    setLoading(true);
    setError(null);
    const result = await api.getNativeUsageAccounts({ silent: true }).then(value => ({ value }), failure => ({ failure }));
    if (!isCurrent()) return;
    setLoading(false);
    if (result.failure) {
      setError({ message: result.failure.status === 503
        ? 'Saved account settings are unavailable or invalid. They have not been replaced with an empty selection. Repair the saved settings before retrying.'
        : 'Could not load account selections. Your saved settings have not changed.' });
      return;
    }
    setModel(result.value);
    setRows(toDraft(result.value.selections));
    const changed = getInvalidation() !== initialInvalidation && getInvalidation()?.revision !== result.value.revision;
    setStale(changed);
    setSaved(false);
    if (!changed) onLoaded(result.value.revision);
  }, [beginRequest, onLoaded, getInvalidation]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (invalidation && modelRef.current && invalidation.revision !== modelRef.current.revision) {
      setStale(true);
      setSaved(false);
    }
  }, [invalidation]);

  const save = async () => {
    if (pendingSave.current || savePending || loading || stale || !model) return;
    const invalid = validateRows(rows);
    setError(invalid);
    if (invalid) { setActiveTab(invalid.family); return; }
    pendingSave.current = true;
    const initialInvalidation = getInvalidation();
    const isCurrent = beginRequest();
    setSaving(true);
    setSaved(false);
    const result = await onSave({ expectedRevision: model.revision, selections: toSelections(rows) }).then(value => ({ value }), failure => ({ failure }));
    if (!isCurrent()) return;
    pendingSave.current = false;
    setSaving(false);
    if (result.failure) {
      const conflict = result.failure.status === 409;
      const requiresOperator = result.failure.code === 'HOST_CONTROL_FORBIDDEN';
      setStale(previous => previous || conflict);
      setError({ requiresOperator, message: requiresOperator
        ? 'Saving account selections requires an operator session. Your draft is still here. Use a browser on the PortOS host, or sign in with the instance password. If login protection is off, enable it locally in Security settings before signing in remotely. Keep this editor open to retain your draft.'
        : conflict ? 'Selections changed since this editor loaded. Your draft is still here. Reload the saved selections before making another save.' : 'Could not save account selections. Your draft is still here. Retry the save or cancel.' });
      return;
    }
    setModel(result.value);
    setRows(toDraft(result.value.selections));
    const superseded = getInvalidation() !== initialInvalidation && getInvalidation()?.revision !== result.value.revision;
    setStale(superseded);
    setSaved(!superseded);
  };
  const change = (id, patch) => {
    setRows(previous => previous.map(row => row.id === id ? { ...row, ...patch } : row));
    setSaved(false);
    setError(null);
  };
  const busy = saving || savePending;
  const provider = PROVIDERS.find(entry => entry.id === activeTab);
  const visibleRows = rows.filter(row => row.family === activeTab);
  const dirty = model && JSON.stringify(toSelections(rows)) !== JSON.stringify(model.selections);
  useEffect(() => { onDraftChange(Boolean(dirty)); return () => onDraftChange(false); }, [dirty, onDraftChange]);
  return <Drawer open onClose={onClose} title="Native account selections" subtitle="Machine-local configuration · no source scan" size="lg"
    tabs={PROVIDERS} activeTab={activeTab} onTabChange={setActiveTab} closeOnEsc={false} closeOnBackdrop={false} closeLabel="Close account selections">
    <div className="min-w-0 space-y-4">
      <p className="text-sm text-gray-400">Choose accounts explicitly for each provider. Shared current sign-ins do not prove which account owns retained history. Saving only changes this machine’s selections; it does not sync settings to peers or change usage records.</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" onClick={() => { void save(); }} disabled={loading || busy || stale || !dirty} className={buttonClass}>{busy ? <BrailleSpinner /> : null}{busy ? 'Saving…' : 'Save selections'}</button>
        <button type="button" onClick={onClose} className={buttonClass}>Cancel</button>
        {model && <span className="text-xs text-gray-400">{formatCount(rows.length)} accounts across all providers</span>}
      </div>
      {busy && <p role="status" className="text-sm text-gray-400">Saving locally. Closing the editor will not cancel a save already sent.</p>}
      {saved && <p role="status" className="text-sm text-port-success">Selections saved locally. Use Read native sources to capture a new snapshot.</p>}
      {error && <p role="alert" className="text-sm text-port-warning">{error.message}</p>}
      {error?.requiresOperator && <Link to="/settings/security" target="_blank" rel="noopener noreferrer" className={buttonClass}>Open Security settings in a new tab</Link>}
      {stale && <div className="space-y-2 rounded border border-port-warning p-3">
        <p role="alert" className="text-sm text-port-warning">Saved selections may have changed. Your draft is preserved, but saving is paused to avoid overwriting newer settings.</p>
        <button type="button" disabled={busy || loading} onClick={() => { void load(); }} className={buttonClass}>Reload saved selections (discard draft)</button>
      </div>}
      {loading ? <p role="status" className="flex items-center gap-2 text-sm text-gray-400"><BrailleSpinner />Loading account selections…</p> : !model ? <button type="button" onClick={() => { void load(); }} className={buttonClass}>Retry loading selections</button> : <>
        {model.inventory.status !== 'complete' && <p className="text-sm text-port-warning">{model.inventory.status === 'truncated' ? `Configured inventory is limited to ${formatCount(model.inventory.maxPeers)} peers.` : 'Configured inventory is unavailable.'} Saved members remain visible. No account or history membership is inferred.</p>}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-medium text-white">{provider.label} accounts</h3>
          <button type="button" disabled={busy || rows.length >= 64} className={buttonClass} onClick={() => {
            setRows(previous => [...previous, { id: uuidv4(), family: activeTab, accountLabel: '', members: [], originalMembers: [], ...(activeTab === 'codex' ? { authoritativeParticipant: '' } : { historyScope: '' }) }]);
            setSaved(false);
          }}>Add account</button>
        </div>
        {!visibleRows.length && <p className="rounded border border-dashed border-port-border p-4 text-sm text-gray-400">No {provider.label} accounts selected. Add a row only when you know which members belong to that account. Local measurements remain separate.</p>}
        <div className="space-y-4">{visibleRows.map((row, index) => <AccountRow key={row.id} row={row} number={index + 1} participants={model.participants}
          disabled={busy} onChange={patch => change(row.id, patch)} onRemove={() => { setRows(previous => previous.filter(item => item.id !== row.id)); setSaved(false); setError(null); }} />)}</div>
        <Link to="/instances" className={buttonClass}>Manage configured peers</Link>
      </>}
    </div>
  </Drawer>;
}
