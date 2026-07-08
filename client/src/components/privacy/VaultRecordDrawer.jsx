import { useState, useEffect } from 'react';
import Drawer from '../Drawer';
import FormField from '../ui/FormField';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { createVaultRecord, updateVaultRecord } from '../../services/api';
import toast from '../ui/Toast';
import { VAULT_TYPES, VAULT_STATUSES, SENSITIVE_TYPES } from './constants';

// Create/edit a single encrypted vault record. Form state is hoisted into this
// component (never left in uncontrolled inputs) per the drawer convention. On
// edit the plaintext `value` is NOT prefilled (the list only ever holds the
// masked value) — an empty value on edit means "leave the stored value
// unchanged"; typing a new value re-encrypts it server-side.
const inputCls = 'w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent';

const EMPTY = {
  type: 'legal_name', label: '', value: '', status: 'current',
  validFrom: '', validTo: '', shareWithTwin: false, useForScans: null, notes: '',
};

export default function VaultRecordDrawer({ open, record, onClose, onSaved }) {
  const editing = !!record;
  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    if (!open) return;
    setForm(record
      ? {
        type: record.type,
        label: record.label ?? '',
        value: '',
        status: record.status ?? 'current',
        validFrom: record.validFrom ?? '',
        validTo: record.validTo ?? '',
        shareWithTwin: !!record.shareWithTwin,
        useForScans: !!record.useForScans,
        notes: record.notes ?? '',
      }
      : { ...EMPTY });
  }, [open, record]);

  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));
  const isSensitive = SENSITIVE_TYPES.includes(form.type);

  const [save, saving] = useAsyncAction(async () => {
    if (!form.label.trim()) { toast.error('Label is required'); return null; }
    if (!editing && !form.value.trim()) { toast.error('Value is required'); return null; }

    const payload = {
      label: form.label.trim(),
      status: form.status,
      validFrom: form.validFrom || null,
      validTo: form.validTo || null,
      shareWithTwin: form.shareWithTwin,
      notes: form.notes,
      // Sensitive types are hard-false server-side; only send an explicit choice
      // for non-sensitive types.
      ...(isSensitive ? {} : { useForScans: !!form.useForScans }),
    };

    let result;
    if (editing) {
      // Only send `value` when the user actually typed a replacement.
      if (form.value.trim()) payload.value = form.value;
      result = await updateVaultRecord(record.id, payload, { silent: true });
    } else {
      result = await createVaultRecord({ type: form.type, value: form.value, ...payload }, { silent: true });
    }
    if (result) {
      toast.success(editing ? 'Vault record updated' : 'Vault record created');
      onSaved(result, editing);
    }
    return result;
  }, { errorMessage: editing ? 'Failed to update record' : 'Failed to create record' });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? 'Edit vault record' : 'New vault record'}
      subtitle={editing ? record?.label : undefined}
      size="md"
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); save(); }}
      >
        <FormField label="Type">
          <select
            value={form.type}
            onChange={(e) => set('type', e.target.value)}
            disabled={editing}
            className={`${inputCls} ${editing ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            {VAULT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          {editing && <p className="text-xs text-gray-500 mt-1">Type is immutable — delete and re-create to change it.</p>}
        </FormField>

        <FormField label="Label">
          <input
            type="text"
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="e.g. Home address"
            className={inputCls}
            maxLength={200}
          />
        </FormField>

        <FormField
          label={editing ? 'Value (leave blank to keep unchanged)' : 'Value'}
          hint={editing ? 'Stored values are encrypted and never shown here. Type a new value to replace it.' : 'Encrypted at rest — never stored or logged in plaintext.'}
        >
          <input
            type="text"
            value={form.value}
            onChange={(e) => set('value', e.target.value)}
            placeholder={editing ? '••••••••' : ''}
            autoComplete="off"
            className={inputCls}
          />
        </FormField>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <FormField label="Status">
            <select value={form.status} onChange={(e) => set('status', e.target.value)} className={inputCls}>
              {VAULT_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </FormField>
          <FormField label="Valid from">
            <input type="date" value={form.validFrom || ''} onChange={(e) => set('validFrom', e.target.value)} className={inputCls} />
          </FormField>
          <FormField label="Valid to">
            <input type="date" value={form.validTo || ''} onChange={(e) => set('validTo', e.target.value)} className={inputCls} />
          </FormField>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
          <input type="checkbox" checked={form.shareWithTwin} onChange={(e) => set('shareWithTwin', e.target.checked)} />
          Share with Digital Twin
        </label>

        <label className={`flex items-center gap-2 text-sm cursor-pointer ${isSensitive ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300'}`}>
          <input
            type="checkbox"
            checked={isSensitive ? false : !!form.useForScans}
            disabled={isSensitive}
            onChange={(e) => set('useForScans', e.target.checked)}
          />
          Use for broker scans
          {isSensitive && <span className="text-xs text-gray-500">(disabled for sensitive types)</span>}
        </label>

        <FormField label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={3}
            className={inputCls}
            maxLength={5000}
          />
        </FormField>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50"
          >
            {saving ? 'Saving…' : (editing ? 'Save changes' : 'Create record')}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
