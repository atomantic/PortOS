import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, ExternalLink, Building2 } from 'lucide-react';
import {
  getPrivacyOrgs, deletePrivacyOrg, getVaultRecords, getOrgHoldings,
} from '../../services/api';
import toast from '../ui/Toast';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import OrgDrawer from './OrgDrawer';
import {
  ORG_CATEGORIES, ORG_TRUST_LEVELS, ORG_STATUSES, ORG_HOLDING_STATUSES,
  TRUST_TONE, HOLDING_TONE, labelFor,
} from './constants';

// Filter chip row — a single-select toggle group over a list of {id,label}.
function ChipFilter({ label, options, value, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-gray-500 mr-1">{label}</span>
      <button
        onClick={() => onChange(null)}
        className={`text-xs px-2 py-1 rounded border ${value == null ? 'border-port-accent/50 text-port-accent bg-port-accent/10' : 'border-port-border text-gray-400 hover:text-white'}`}
      >
        All
      </button>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(value === o.id ? null : o.id)}
          className={`text-xs px-2 py-1 rounded border ${value === o.id ? 'border-port-accent/50 text-port-accent bg-port-accent/10' : 'border-port-border text-gray-400 hover:text-white'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function PrivacyOrgsTab() {
  const [orgs, setOrgs] = useState([]);
  const [vaultRecords, setVaultRecords] = useState([]);
  const [holdingsByOrg, setHoldingsByOrg] = useState({}); // orgId -> [holdings]
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ trust: null, category: null, status: null });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([getPrivacyOrgs(), getVaultRecords()]).then(async ([o, v]) => {
      const orgList = o.status === 'fulfilled' ? o.value : [];
      setOrgs(orgList);
      setVaultRecords(v.status === 'fulfilled' ? v.value : []);
      // Fetch holdings per org (single-user scale — a handful of orgs).
      const entries = await Promise.all(orgList.map(async (org) => {
        const h = await getOrgHoldings(org.id, { silent: true }).catch(() => []);
        return [org.id, h || []];
      }));
      setHoldingsByOrg(Object.fromEntries(entries));
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditing(null); setDrawerOpen(true); };
  const openEdit = (org) => { setEditing(org); setDrawerOpen(true); };

  const handleSaved = async (savedOrg, wasEditing) => {
    setDrawerOpen(false);
    setOrgs((prev) => (wasEditing ? prev.map((o) => (o.id === savedOrg.id ? savedOrg : o)) : [...prev, savedOrg]));
    // Refresh this org's holdings badges.
    const h = await getOrgHoldings(savedOrg.id, { silent: true }).catch(() => []);
    setHoldingsByOrg((prev) => ({ ...prev, [savedOrg.id]: h || [] }));
  };

  const handleDelete = async (org) => {
    setConfirmDelete(null);
    const ok = await deletePrivacyOrg(org.id, { silent: true }).catch(() => null);
    if (ok) {
      setOrgs((prev) => prev.filter((o) => o.id !== org.id));
      toast.success('Organization deleted');
    } else {
      toast.error('Failed to delete organization');
    }
  };

  const visible = orgs.filter((o) => (
    (!filters.trust || o.trust === filters.trust)
    && (!filters.category || o.category === filters.category)
    && (!filters.status || o.status === filters.status)
  ));

  // Holdings status → count for an org's badge row.
  const holdingCounts = (orgId) => {
    const counts = {};
    for (const h of holdingsByOrg[orgId] || []) counts[h.status] = (counts[h.status] || 0) + 1;
    return counts;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-2">
          <ChipFilter label="Trust" options={ORG_TRUST_LEVELS} value={filters.trust} onChange={(v) => setFilters((f) => ({ ...f, trust: v }))} />
          <ChipFilter label="Category" options={ORG_CATEGORIES} value={filters.category} onChange={(v) => setFilters((f) => ({ ...f, category: v }))} />
          <ChipFilter label="Status" options={ORG_STATUSES} value={filters.status} onChange={(v) => setFilters((f) => ({ ...f, status: v }))} />
        </div>
        <button onClick={openCreate} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 self-start">
          <Plus size={16} /> New organization
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading organizations…</div>
      ) : visible.length === 0 ? (
        <div className="border border-dashed border-port-border rounded-lg p-8 text-center text-gray-500 text-sm">
          {orgs.length === 0
            ? 'No organizations yet. Track every bank, utility, employer, or platform that holds your PII.'
            : 'No organizations match the current filters.'}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((org) => {
            const counts = holdingCounts(org.id);
            return (
              <div key={org.id} className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Building2 size={15} className="text-gray-500 shrink-0" />
                      <span className="text-sm font-medium text-white truncate">{org.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${TRUST_TONE[org.trust] || ''}`}>
                        {labelFor(ORG_TRUST_LEVELS, org.trust)}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
                        {labelFor(ORG_CATEGORIES, org.category)}
                      </span>
                      {org.status !== 'active' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
                          {labelFor(ORG_STATUSES, org.status)}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                      {Object.keys(counts).length === 0 ? (
                        <span className="text-[11px] text-gray-600">No holdings recorded</span>
                      ) : (
                        ORG_HOLDING_STATUSES.filter((s) => counts[s.id]).map((s) => (
                          <span key={s.id} className={`text-[10px] px-1.5 py-0.5 rounded border ${HOLDING_TONE[s.id] || ''}`}>
                            {counts[s.id]} {s.label.toLowerCase()}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {org.website && (
                      <a
                        href={org.website}
                        target="_blank"
                        rel="noreferrer"
                        title="Open website"
                        aria-label="Open website"
                        className="p-2 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
                      >
                        <ExternalLink size={16} />
                      </a>
                    )}
                    <button onClick={() => openEdit(org)} title="Edit organization" aria-label="Edit organization" className="p-2 rounded text-gray-400 hover:text-white hover:bg-port-border/50">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => setConfirmDelete(org.id)} title="Delete organization" aria-label="Delete organization" className="p-2 rounded text-gray-400 hover:text-port-error hover:bg-port-border/50">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                {confirmDelete === org.id && (
                  <InlineConfirmRow
                    className="mt-3"
                    question={`Delete "${org.name}"? Holdings links are removed too.`}
                    onConfirm={() => handleDelete(org)}
                    onCancel={() => setConfirmDelete(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <OrgDrawer
        open={drawerOpen}
        org={editing}
        vaultRecords={vaultRecords}
        onClose={() => setDrawerOpen(false)}
        onSaved={handleSaved}
      />
    </div>
  );
}
