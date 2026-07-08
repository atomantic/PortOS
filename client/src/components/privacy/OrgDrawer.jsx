import { useState, useEffect } from 'react';
import Drawer from '../Drawer';
import FormField from '../ui/FormField';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import {
  createPrivacyOrg, updatePrivacyOrg, getOrgHoldings, setOrgHoldings, getSocialAccounts,
} from '../../services/api';
import toast from '../ui/Toast';
import { ORG_CATEGORIES, ORG_TRUST_LEVELS, ORG_STATUSES, VAULT_TYPES, labelFor } from './constants';

const inputCls = 'w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent';

const EMPTY = {
  name: '', category: 'other', website: '', trust: 'trusted', status: 'active',
  contactEmail: '', contactPhone: '', notes: '', socialAccountId: '',
};

// Human label for a Digital Twin social account in the picker.
const accountLabel = (a) => {
  const handle = a.username ? `@${a.username}` : '';
  const name = a.displayName && a.displayName !== a.username ? ` (${a.displayName})` : '';
  return `${a.platform || 'other'} · ${handle}${name}`.trim();
};

// Create/edit an organization plus which vault records it holds. The holdings
// picker is a checkbox list over the user's vault records (masked values only).
// Holdings are saved via the replace-set endpoint after the org exists (on
// create we POST the org first, then set holdings against the returned id).
export default function OrgDrawer({ open, org, vaultRecords, onClose, onSaved }) {
  const editing = !!org;
  const [form, setForm] = useState(EMPTY);
  const [selected, setSelected] = useState(() => new Set()); // vaultRecordId set
  const [socialAccounts, setSocialAccounts] = useState([]); // Digital Twin accounts for the cross-link picker

  useEffect(() => {
    if (!open) return;
    setForm(org
      ? {
        name: org.name ?? '',
        category: org.category ?? 'other',
        website: org.website ?? '',
        trust: org.trust ?? 'trusted',
        status: org.status ?? 'active',
        contactEmail: org.contact?.email ?? '',
        contactPhone: org.contact?.phone ?? '',
        notes: org.notes ?? '',
        socialAccountId: org.socialAccountId ?? '',
      }
      : { ...EMPTY });
    setSelected(new Set());
    // Load existing holdings for an org being edited.
    if (org?.id) {
      getOrgHoldings(org.id, { silent: true })
        .then((h) => setSelected(new Set((h || []).map((x) => x.vaultRecordId))))
        .catch(() => {});
    }
    // Load Digital Twin social accounts for the cross-link picker (#2147). Degrades
    // to no picker options if the twin has none — never blocks org editing.
    getSocialAccounts()
      .then((res) => setSocialAccounts(res?.accounts || []))
      .catch(() => setSocialAccounts([]));
  }, [open, org]);

  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));
  const toggleHolding = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const [save, saving] = useAsyncAction(async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return null; }
    const contact = {};
    if (form.contactEmail.trim()) contact.email = form.contactEmail.trim();
    if (form.contactPhone.trim()) contact.phone = form.contactPhone.trim();
    const payload = {
      name: form.name.trim(),
      category: form.category,
      website: form.website,
      trust: form.trust,
      status: form.status,
      contact,
      notes: form.notes,
      // Cross-link to a Digital Twin social account (#2147). Empty → null so a
      // cleared link persists as an explicit clear rather than an empty string.
      socialAccountId: form.socialAccountId || null,
    };

    const savedOrg = editing
      ? await updatePrivacyOrg(org.id, payload, { silent: true })
      : await createPrivacyOrg(payload, { silent: true });
    if (!savedOrg) return null;

    // Persist holdings (replace-set). Skip the call on create when nothing is selected.
    const holdings = [...selected].map((vaultRecordId) => ({ vaultRecordId }));
    if (editing || holdings.length > 0) {
      await setOrgHoldings(savedOrg.id, holdings, { silent: true }).catch(() => {
        toast.error('Organization saved, but holdings could not be updated');
      });
    }

    toast.success(editing ? 'Organization updated' : 'Organization created');
    onSaved(savedOrg, editing, selected.size);
    return savedOrg;
  }, { errorMessage: editing ? 'Failed to update organization' : 'Failed to create organization' });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? 'Edit organization' : 'New organization'}
      subtitle={editing ? org?.name : undefined}
      size="md"
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <FormField label="Name">
          <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Acme Bank" className={inputCls} maxLength={200} />
        </FormField>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <FormField label="Category">
            <select value={form.category} onChange={(e) => set('category', e.target.value)} className={inputCls}>
              {ORG_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </FormField>
          <FormField label="Trust">
            <select value={form.trust} onChange={(e) => set('trust', e.target.value)} className={inputCls}>
              {ORG_TRUST_LEVELS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </FormField>
          <FormField label="Status">
            <select value={form.status} onChange={(e) => set('status', e.target.value)} className={inputCls}>
              {ORG_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </FormField>
        </div>

        <FormField label="Website">
          <input type="text" value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://…" className={inputCls} maxLength={2000} />
        </FormField>

        <FormField label="Linked social account (Digital Twin)">
          <select
            value={form.socialAccountId}
            onChange={(e) => set('socialAccountId', e.target.value)}
            className={inputCls}
          >
            <option value="">— None —</option>
            {/* Preserve a stale link (account since deleted) so the select isn't blank. */}
            {form.socialAccountId && !socialAccounts.some((a) => a.id === form.socialAccountId) && (
              <option value={form.socialAccountId}>Linked account (unavailable)</option>
            )}
            {socialAccounts.map((a) => (
              <option key={a.id} value={a.id}>{accountLabel(a)}</option>
            ))}
          </select>
          <p className="text-[11px] text-gray-500 mt-1">
            Cross-links this org to one of your Digital Twin social accounts — the account shows an &ldquo;in org registry&rdquo; badge in return.
          </p>
        </FormField>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField label="Contact email">
            <input type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} className={inputCls} maxLength={320} />
          </FormField>
          <FormField label="Contact phone">
            <input type="tel" value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} className={inputCls} maxLength={64} />
          </FormField>
        </div>

        <div>
          <span className="block text-sm text-gray-400 mb-1">Holdings — which vault records does this org have?</span>
          {(!vaultRecords || vaultRecords.length === 0) ? (
            <p className="text-xs text-gray-500">No vault records yet. Add records in the Vault tab first.</p>
          ) : (
            <div className="max-h-52 overflow-y-auto border border-port-border rounded divide-y divide-port-border">
              {vaultRecords.map((rec) => (
                <label key={rec.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-port-bg/50">
                  <input type="checkbox" checked={selected.has(rec.id)} onChange={() => toggleHolding(rec.id)} className="accent-port-accent" />
                  <span className="text-gray-300 truncate flex-1">{rec.label}</span>
                  <span className="text-[11px] text-gray-500">{labelFor(VAULT_TYPES, rec.type)}</span>
                  <span className="font-mono text-[11px] text-gray-500 truncate max-w-[40%]">{rec.maskedValue}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <FormField label="Notes">
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3} className={inputCls} maxLength={5000} />
        </FormField>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50">
            {saving ? 'Saving…' : (editing ? 'Save changes' : 'Create organization')}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
