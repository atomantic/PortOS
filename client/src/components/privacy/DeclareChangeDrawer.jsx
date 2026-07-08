import { useState, useEffect, useMemo } from 'react';
import Drawer from '../Drawer';
import FormField from '../ui/FormField';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { declarePrivacyChange } from '../../services/api';
import toast from '../ui/Toast';
import { VAULT_TYPES, CHANGE_KINDS, KIND_FOR_TYPE, labelFor } from './constants';

const inputCls = 'w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent';

// Declare a change-of-address (or any field change): pick the OLD vault record,
// enter the NEW value, and every org holding the old value flips to
// `update_pending`. The replacement record is created inline (type inherited
// from the old record). Only `current` records are eligible — a `previous`
// record has already been retired.
export default function DeclareChangeDrawer({ open, vaultRecords, onClose, onDeclared }) {
  const eligible = useMemo(
    () => (vaultRecords || []).filter((r) => r.status === 'current'),
    [vaultRecords],
  );

  const [oldRecordId, setOldRecordId] = useState('');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    const first = eligible[0]?.id ?? '';
    setOldRecordId(first);
    setLabel('');
    setValue('');
    setNote('');
  }, [open, eligible]);

  const oldRecord = eligible.find((r) => r.id === oldRecordId) || null;
  const derivedKind = oldRecord ? (KIND_FOR_TYPE[oldRecord.type] ?? 'other') : 'other';

  const [declare, declaring] = useAsyncAction(async () => {
    if (!oldRecordId) { toast.error('Pick the record that changed'); return null; }
    if (!label.trim()) { toast.error('New value label is required'); return null; }
    if (!value.trim()) { toast.error('New value is required'); return null; }
    const event = await declarePrivacyChange({
      vaultRecordId: oldRecordId,
      replacement: { label: label.trim(), value: value.trim() },
      kind: derivedKind,
      note: note.trim() || undefined,
    }, { silent: true });
    if (!event) return null;
    toast.success('Change declared — orgs flagged for update');
    onDeclared(event);
    return event;
  }, { errorMessage: 'Failed to declare change' });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Declare a change"
      subtitle="Flag every org holding the old value for an update"
      size="md"
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      {eligible.length === 0 ? (
        <p className="text-sm text-gray-500">
          No current vault records yet. Add a record in the Vault tab first, then declare a change when its value updates.
        </p>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); declare(); }}>
          <FormField label="Record that changed">
            <select
              id="declare-old-record"
              value={oldRecordId}
              onChange={(e) => setOldRecordId(e.target.value)}
              className={inputCls}
            >
              {eligible.map((r) => (
                <option key={r.id} value={r.id}>
                  {labelFor(VAULT_TYPES, r.type)} — {r.label} ({r.maskedValue})
                </option>
              ))}
            </select>
          </FormField>

          <div className="text-xs text-gray-500">
            Change type: <span className="text-gray-300">{labelFor(CHANGE_KINDS, derivedKind)}</span>
          </div>

          <FormField label="New value label">
            <input
              id="declare-new-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. New home address"
              className={inputCls}
              maxLength={200}
            />
          </FormField>

          <FormField label="New value">
            <input
              id="declare-new-value"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="The new value (encrypted at rest)"
              className={inputCls}
              maxLength={10000}
            />
          </FormField>

          <FormField label="Note (optional)">
            <textarea
              id="declare-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className={inputCls}
              maxLength={5000}
            />
          </FormField>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-2 text-sm rounded border border-port-border text-gray-300 hover:text-white">
              Cancel
            </button>
            <button type="submit" disabled={declaring} className="px-3 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50">
              {declaring ? 'Declaring…' : 'Declare change'}
            </button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
