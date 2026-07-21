import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Repeat, ChevronDown, ChevronRight, ExternalLink, Check, Ban, Mail, ArrowRight,
} from 'lucide-react';
import {
  getPrivacyChanges, getPrivacyChange, getVaultRecords,
  markChangeOrgUpdated, markChangeOrgRemoved, draftChangeUpdateEmail,
} from '../../services/api';
import toast from '../ui/Toast';
import DeclareChangeDrawer from './DeclareChangeDrawer';
import { VAULT_TYPES, CHANGE_KINDS, labelFor } from './constants';
import { isHttpUrl } from '../../utils/urlNormalize';

// A slim progress bar over pending/updated/removed. Done = zero pending.
function ProgressBar({ progress }) {
  const { total = 0, pending = 0, updated = 0, removed = 0 } = progress || {};
  const done = updated + removed;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="min-w-[140px]">
      <div className="h-1.5 rounded bg-port-border overflow-hidden">
        <div
          className={`h-full ${total > 0 && pending === 0 ? 'bg-port-success' : 'bg-port-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-[10px] text-gray-500">
        {total === 0 ? 'No orgs held this value' : `${done}/${total} handled${pending === 0 ? ' — done' : ''}`}
      </div>
    </div>
  );
}

// One org row inside an expanded event's checklist.
function OrgRow({ org, status, eventId, hasReplacement, onChanged }) {
  const [busy, setBusy] = useState(false);

  const act = async (fn, okMsg) => {
    setBusy(true);
    const res = await fn().catch(() => null);
    setBusy(false);
    if (res) { onChanged(res); if (okMsg) toast.success(okMsg); }
    else toast.error('Action failed');
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-port-border/40 last:border-0">
      <div className="min-w-0 flex-1">
        <span className="text-sm text-white truncate">{org.orgName}</span>
        {org.contactEmail && <span className="ml-2 text-[11px] text-gray-500">{org.contactEmail}</span>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {org.website && isHttpUrl(org.website) && (
          <a href={org.website} target="_blank" rel="noreferrer" title="Open website" aria-label="Open website"
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50">
            <ExternalLink size={14} />
          </a>
        )}
        {status === 'pending' ? (
          <>
            {hasReplacement && org.contactEmail && (
              <button
                onClick={() => act(() => draftChangeUpdateEmail(eventId, org.orgId, { silent: true }), 'Draft added to Comms queue')}
                disabled={busy} title="Draft update email" aria-label="Draft update email"
                className="p-1.5 rounded text-gray-400 hover:text-port-accent hover:bg-port-border/50 disabled:opacity-50">
                <Mail size={14} />
              </button>
            )}
            <button
              onClick={() => act(() => markChangeOrgUpdated(eventId, org.orgId, { silent: true }), 'Marked updated')}
              disabled={busy} title="Mark updated" aria-label="Mark updated"
              className="p-1.5 rounded text-gray-400 hover:text-port-success hover:bg-port-border/50 disabled:opacity-50">
              <Check size={15} />
            </button>
            <button
              onClick={() => act(() => markChangeOrgRemoved(eventId, org.orgId, { silent: true }), 'Marked removed')}
              disabled={busy} title="Mark removed (org dropped this data)" aria-label="Mark removed"
              className="p-1.5 rounded text-gray-400 hover:text-port-error hover:bg-port-border/50 disabled:opacity-50">
              <Ban size={15} />
            </button>
          </>
        ) : (
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${status === 'updated' ? 'bg-port-success/15 text-port-success border-port-success/30' : 'bg-gray-700/40 text-gray-400 border-gray-600/40'}`}>
            {status === 'updated' ? 'Updated' : 'Removed'}
          </span>
        )}
      </div>
    </div>
  );
}

// Group heading + rows for one status bucket in an expanded event.
function StatusGroup({ title, orgs, status, eventId, hasReplacement, onChanged }) {
  if (!orgs || orgs.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{title} ({orgs.length})</div>
      <div>
        {orgs.map((org) => (
          <OrgRow key={org.orgId} org={org} status={status} eventId={eventId} hasReplacement={hasReplacement} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}

export default function PrivacyChangesTab() {
  const [events, setEvents] = useState([]);
  const [vaultRecords, setVaultRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState(null); // eventId
  const [detail, setDetail] = useState(null); // { event, oldRecord, replacementRecord, progress }
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([getPrivacyChanges(), getVaultRecords()]).then(([e, v]) => {
      setEvents(e.status === 'fulfilled' ? e.value : []);
      setVaultRecords(v.status === 'fulfilled' ? v.value : []);
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (eventId) => {
    if (expanded === eventId) { setExpanded(null); setDetail(null); return; }
    setExpanded(eventId);
    setDetail(null);
    setDetailLoading(true);
    const d = await getPrivacyChange(eventId, { silent: true }).catch(() => null);
    setDetailLoading(false);
    setDetail(d);
  };

  const handleDeclared = (event) => {
    setDrawerOpen(false);
    setEvents((prev) => [
      { ...event, progress: { pending: 0, updated: 0, removed: 0, total: 0 } },
      ...prev,
    ]);
    // Refresh so the new event's progress counts + masked values are populated.
    load();
  };

  // A per-org action returns the fresh progress groups — recompute counts for
  // both the expanded detail and the collapsed list bar.
  const applyProgress = (eventId, groups) => {
    setDetail((prev) => (prev && prev.event.id === eventId ? { ...prev, progress: groups } : prev));
    const counts = {
      pending: groups.pending.length,
      updated: groups.updated.length,
      removed: groups.removed.length,
      total: groups.pending.length + groups.updated.length + groups.removed.length,
    };
    setEvents((prev) => prev.map((ev) => (ev.id === eventId ? { ...ev, progress: counts } : ev)));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500 max-w-lg">
          Declare "field X changed from A to B" — every org holding the old value is flagged for an update, and you work the checklist until everyone is current.
        </p>
        <button onClick={() => setDrawerOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 self-start">
          <Plus size={16} /> Declare change
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading changes…</div>
      ) : events.length === 0 ? (
        <div className="border border-dashed border-port-border rounded-lg p-8 text-center text-gray-500 text-sm">
          No changes declared yet. When an address, phone, or email changes, declare it here to track who still needs updating.
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((ev) => {
            const isOpen = expanded === ev.id;
            return (
              <div key={ev.id} className="bg-port-card border border-port-border rounded-lg">
                <button onClick={() => toggle(ev.id)} className="w-full flex flex-wrap items-center gap-3 p-3 text-left">
                  {isOpen ? <ChevronDown size={16} className="text-gray-500 shrink-0" /> : <ChevronRight size={16} className="text-gray-500 shrink-0" />}
                  <Repeat size={15} className="text-gray-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap text-sm">
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
                        {labelFor(CHANGE_KINDS, ev.kind)}
                      </span>
                      <span className="text-gray-300 truncate">{ev.oldRecord?.maskedValue}</span>
                      <ArrowRight size={13} className="text-gray-600 shrink-0" />
                      <span className="text-white truncate">{ev.replacementRecord?.maskedValue ?? 'removed'}</span>
                    </div>
                    <div className="text-[11px] text-gray-600 mt-0.5">
                      {labelFor(VAULT_TYPES, ev.oldRecord?.type)} · {ev.declaredAt ? new Date(ev.declaredAt).toLocaleDateString() : ''}
                    </div>
                  </div>
                  <ProgressBar progress={ev.progress} />
                </button>

                {isOpen && (
                  <div className="px-3 pb-3 border-t border-port-border/40">
                    {detailLoading || !detail ? (
                      <div className="text-gray-500 text-xs py-4 text-center">Loading inventory…</div>
                    ) : (
                      <>
                        {ev.note && <p className="text-xs text-gray-500 mt-3 italic">{ev.note}</p>}
                        {(detail.progress.pending.length + detail.progress.updated.length + detail.progress.removed.length) === 0 ? (
                          <p className="text-xs text-gray-500 py-4">No organizations were recorded as holding this value.</p>
                        ) : (
                          <>
                            <StatusGroup title="Needs update" orgs={detail.progress.pending} status="pending" eventId={ev.id}
                              hasReplacement={!!ev.replacementRecordId} onChanged={(g) => applyProgress(ev.id, g)} />
                            <StatusGroup title="Updated" orgs={detail.progress.updated} status="updated" eventId={ev.id}
                              hasReplacement={!!ev.replacementRecordId} onChanged={(g) => applyProgress(ev.id, g)} />
                            <StatusGroup title="Removed" orgs={detail.progress.removed} status="removed" eventId={ev.id}
                              hasReplacement={!!ev.replacementRecordId} onChanged={(g) => applyProgress(ev.id, g)} />
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <DeclareChangeDrawer
        open={drawerOpen}
        vaultRecords={vaultRecords}
        onClose={() => setDrawerOpen(false)}
        onDeclared={handleDeclared}
      />
    </div>
  );
}
