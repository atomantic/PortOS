import { useState } from 'react';
import * as api from '../../services/api';
import toast from '../ui/Toast';

// Loaded explicitly: settings does not fetch message history until requested.
export default function SignalManager() {
  const [data, setData] = useState(null);
  const [query, setQuery] = useState('');
  const [handles, setHandles] = useState('');
  const [conversations, setConversations] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null);
  const load = async () => {
    const [rows, blocklist] = await Promise.all([
      api.listSignalConversations(query), data === null ? api.getSignalBlocklist() : null,
    ]);
    setData(rows.conversations);
    if (blocklist) {
      setHandles(blocklist.handles.join('\n'));
      setConversations(blocklist.conversationIds.join('\n'));
    }
  };
  const run = async (action) => {
    setBusy(true);
    setError('');
    await Promise.resolve().then(action)
      .catch((err) => setError(err.message || 'Signal management failed'))
      .finally(() => setBusy(false));
  };
  const perform = async () => {
    if (confirm.block) {
      await api.blockSignalConversation(confirm.id);
      setConversations((current) => [...new Set([...lines(current), confirm.id])].join('\n'));
    } else await api.purgeSignalConversation(confirm.id);
    setConfirm(null);
    await load();
    toast.success('Signal data updated');
  };
  const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
  return <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
    <h3 className="text-lg font-semibold">Manage imported Signal data</h3>
    <p className="text-sm text-gray-400">Purge removes PortOS activity and Tribe touchpoints. Signal messages stay on your device. Blocking excludes future syncs; unblocking does not replay skipped history.</p>
    <button type="button" disabled={busy} onClick={() => run(load)} className="min-h-10 px-3 py-2 border border-port-border rounded">{data ? 'Refresh imported data' : 'Manage imported data'}</button>
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {data && <>
      <form onSubmit={(event) => { event.preventDefault(); void run(load); }} className="flex gap-2">
        <input aria-label="Search Signal conversations" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-port-bg border border-port-border rounded p-2" />
        <button disabled={busy} className="min-h-10 p-2 border border-port-border rounded">Search</button>
      </form>
      <p className="text-xs text-gray-400">Showing up to 500 conversations. Search all imported history to narrow results.</p>
      <ul className="space-y-2">{data.map((row) => <li key={row.conversationId} className="border border-port-border rounded p-3 flex flex-wrap gap-2 items-center">
        <span className="flex-1 min-w-0 break-words">{row.title} · {row.eventCount} events {row.blocked && '(blocked)'}</span>
        <button disabled={busy || !row.conversationId} onClick={() => setConfirm({ id: row.conversationId, block: false })} className="min-h-10 p-2 text-port-error">Purge</button>
        <button disabled={busy || !row.conversationId} onClick={() => setConfirm({ id: row.conversationId, block: true })} className="min-h-10 p-2">Block and purge</button>
      </li>)}</ul>
      {confirm && <div className="border border-port-warning rounded p-3">
        <p>{confirm.block ? 'Block this conversation and purge its imported history?' : 'Purge this conversation’s imported history?'}</p>
        <button disabled={busy} onClick={() => run(perform)} className="min-h-10 p-2 text-port-error">Confirm purge</button>
        <button disabled={busy} onClick={() => setConfirm(null)} className="min-h-10 p-2">Cancel</button>
      </div>}
      <label htmlFor="signal-blocked-handles" className="block">Blocked handles (one per line)<textarea id="signal-blocked-handles" value={handles} onChange={(event) => setHandles(event.target.value)} className="block w-full bg-port-bg border border-port-border rounded p-2" /></label>
      <label htmlFor="signal-blocked-conversations" className="block">Blocked conversation IDs (one per line)<textarea id="signal-blocked-conversations" value={conversations} onChange={(event) => setConversations(event.target.value)} className="block w-full bg-port-bg border border-port-border rounded p-2" /></label>
      <p className="text-xs text-gray-400">Saving exclusions affects future imports. Use Block and purge above to remove existing conversation history.</p>
      <button disabled={busy} onClick={() => run(async () => { const saved = await api.setSignalBlocklist({ handles: lines(handles), conversationIds: lines(conversations) }); setHandles(saved.handles.join('\n')); setConversations(saved.conversationIds.join('\n')); await load(); toast.success('Signal exclusions saved'); })} className="min-h-10 p-2 border border-port-border rounded">Save exclusions</button>
    </>}
  </section>;
}
