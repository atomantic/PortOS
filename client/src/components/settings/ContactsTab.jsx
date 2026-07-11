import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Contact, Loader2, RefreshCw, ShieldCheck, ShieldAlert,
  Users, UserPlus, ExternalLink,
} from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import {
  getContactsStatus,
  checkContactsSetup,
  syncContacts,
  enrichTribeFromContacts,
  suggestTribeFromContacts,
  importContactToTribe,
} from '../../services/api';

// Settings → Contacts (#2415). Opt-in read of macOS AddressBook → local cache
// for iMessage name resolution + Tribe phone/email fill. Never writes Contacts.
export function ContactsTab() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [setup, setSetup] = useState(null);
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [importingId, setImportingId] = useState(null);

  const reload = async () => {
    const st = await getContactsStatus({ silent: true }).catch(() => null);
    setStatus(st);
  };

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    const report = await checkContactsSetup({ silent: true }).catch(() => ({ ok: false, error: 'Setup check failed' }));
    setChecking(false);
    setSetup(report);
    if (report?.ok) toast.success(`AddressBook OK — ${report.sourceCount ?? 0} source(s), ${report.rawContactRows ?? 0} row(s)`);
    else toast.error(report?.fullDiskAccessRequired ? 'Full Disk Access required' : (report?.error || 'Contacts not reachable'));
  };

  const handleSync = async () => {
    setSyncing(true);
    const result = await syncContacts({ silent: true }).catch(() => ({ ok: false, error: 'Sync failed' }));
    setSyncing(false);
    if (result?.ok) {
      toast.success(`Synced ${result.contactCount} contact(s) from ${result.sourceCount} source(s)`);
      await reload();
    } else {
      toast.error(result?.fullDiskAccessRequired ? 'Full Disk Access required' : (result?.error || 'Sync failed'));
      setSetup(result);
    }
  };

  const handleEnrich = async ({ dryRun }) => {
    setEnriching(true);
    const result = await enrichTribeFromContacts({ dryRun, silent: true }).catch(() => null);
    setEnriching(false);
    if (!result) {
      toast.error('Tribe enrich failed');
      return;
    }
    if (dryRun) {
      toast.success(`Would update ${result.matched} Tribe person/people`);
    } else {
      toast.success(`Updated phones/emails on ${result.updated} Tribe person/people`);
    }
  };

  const loadSuggestions = async () => {
    setLoadingSuggest(true);
    const res = await suggestTribeFromContacts({ limit: 30, silent: true }).catch(() => null);
    setLoadingSuggest(false);
    setSuggestions(res?.suggestions || []);
    if (!res) toast.error('Failed to load suggestions');
  };

  const handleImport = async (s) => {
    const key = s.contactId || s.handle || s.displayName;
    setImportingId(key);
    const result = await importContactToTribe({
      contactId: s.contactId || undefined,
      name: s.displayName,
      phones: s.phones,
      emails: s.emails,
      organization: s.organization || undefined,
      ring: 'tribe',
    }, { silent: true }).catch(() => null);
    setImportingId(null);
    if (!result) {
      toast.error('Import failed');
      return;
    }
    toast.success(result.created ? `Added ${result.person?.name} to Tribe` : `${result.person?.name} already in Tribe`);
    setSuggestions((prev) => prev.filter((x) => (x.contactId || x.handle) !== (s.contactId || s.handle)));
  };

  if (loading) return <BrailleSpinner />;

  const cache = status?.cache;
  const last = status?.state?.lastResult;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Contact size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">macOS Contacts</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Reads your local AddressBook databases read-only into a machine-local cache.
          Used to show names (and companies) on{' '}
          <Link to="/imessage" className="text-port-accent hover:underline">Comms → iMessage</Link>
          {' '}and to fill missing phones/emails on{' '}
          <Link to="/tribe" className="text-port-accent hover:underline">Tribe</Link>
          {' '}people. Never writes Apple Contacts. Requires{' '}
          <strong>Full Disk Access</strong> for the PortOS process (same as iMessage).
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCheck}
            disabled={checking}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
          >
            {checking ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            Check setup
          </button>
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40"
          >
            {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Sync Contacts now
          </button>
        </div>
      </div>

      {setup && (
        <div className={`bg-port-card border rounded-lg p-4 sm:p-6 ${setup.ok ? 'border-port-success/40' : 'border-port-error/40'}`}>
          <div className="flex items-center gap-2 mb-2">
            {setup.ok
              ? <ShieldCheck size={16} className="text-port-success" />
              : <ShieldAlert size={16} className="text-port-error" />}
            <h3 className="text-sm font-semibold text-white">{setup.ok ? 'Setup OK' : 'Setup blocked'}</h3>
          </div>
          {setup.ok ? (
            <p className="text-sm text-gray-300">
              {setup.sourceCount} AddressBook source(s), {setup.rawContactRows ?? 0} raw row(s) under{' '}
              <code className="text-gray-400 text-xs">{setup.root}</code>
            </p>
          ) : (
            <div className="text-sm text-gray-300 space-y-2">
              <p className="text-port-error">{setup.error}</p>
              {setup.remediation && <p className="text-gray-400">{setup.remediation}</p>}
            </div>
          )}
        </div>
      )}

      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <h3 className="text-sm font-semibold text-white mb-2">Cache</h3>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-gray-500 text-xs uppercase">Contacts</dt>
            <dd className="text-gray-200">{cache?.contactCount ?? 0}</dd>
          </div>
          <div>
            <dt className="text-gray-500 text-xs uppercase">Sources (last sync)</dt>
            <dd className="text-gray-200">{cache?.sourceCount ?? last?.sourceCount ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500 text-xs uppercase">Last synced</dt>
            <dd className="text-gray-200">
              {cache?.syncedAt ? new Date(cache.syncedAt).toLocaleString() : 'Never'}
            </dd>
          </div>
        </dl>
        {(cache?.contactCount || 0) === 0 && (
          <p className="mt-3 text-xs text-gray-500">
            Run <strong className="text-gray-400">Sync Contacts now</strong>, then open Comms → iMessage —
            conversation titles resolve at read time (no iMessage re-sync required).
          </p>
        )}
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6 space-y-3">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-port-accent" />
          <h3 className="text-sm font-semibold text-white">Tribe phones &amp; emails</h3>
        </div>
        <p className="text-sm text-gray-400">
          Match cached Contacts to existing Tribe people (by phone, email, or exact unique name)
          and fill missing <code className="text-gray-300">phones[]</code> / <code className="text-gray-300">emails[]</code>.
          Does not create new Tribe people.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleEnrich({ dryRun: true })}
            disabled={enriching || !(cache?.contactCount)}
            className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm disabled:opacity-40"
          >
            Preview matches
          </button>
          <button
            type="button"
            onClick={() => handleEnrich({ dryRun: false })}
            disabled={enriching || !(cache?.contactCount)}
            className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm disabled:opacity-40"
          >
            {enriching ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />}
            Fill Tribe phones/emails
          </button>
          <Link
            to="/tribe"
            className="inline-flex items-center gap-1 min-h-[40px] px-3 py-2 text-sm text-port-accent hover:underline"
          >
            Open Tribe <ExternalLink size={12} />
          </Link>
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserPlus size={16} className="text-port-accent" />
            <h3 className="text-sm font-semibold text-white">Suggest Tribe imports</h3>
          </div>
          <button
            type="button"
            onClick={loadSuggestions}
            disabled={loadingSuggest}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded border border-port-border bg-port-bg hover:border-port-accent text-gray-200 disabled:opacity-40"
          >
            {loadingSuggest ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Load suggestions
          </button>
        </div>
        <p className="text-sm text-gray-400">
          Frequent iMessage counterparts (and unmatched contacts) not yet in Tribe.
          Import only people you want in your relationship graph — not the whole address book.
        </p>
        {suggestions.length > 0 && (
          <ul className="divide-y divide-port-border rounded border border-port-border max-h-80 overflow-y-auto">
            {suggestions.map((s) => {
              const key = s.contactId || s.handle || s.displayName;
              return (
                <li key={key} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-100 truncate">{s.displayName}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {[s.organization, s.phones?.[0], s.emails?.[0], s.eventCount ? `${s.eventCount} msgs` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleImport(s)}
                    disabled={importingId === key}
                    className="shrink-0 inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-200 hover:border-port-accent disabled:opacity-40"
                  >
                    {importingId === key ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
                    Add to Tribe
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default ContactsTab;
