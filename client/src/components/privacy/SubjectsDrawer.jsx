import { useState, useEffect } from 'react';
import { Plus, Trash2, ShieldCheck, ChevronDown, ChevronRight } from 'lucide-react';
import Drawer from '../Drawer';
import FormField from '../ui/FormField';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import Pill from '../ui/Pill';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useConfirmDelete from '../../hooks/useConfirmDelete';
import {
  createPrivacySubject, deletePrivacySubject, getPrivacySubjectConsents,
} from '../../services/api';
import toast from '../ui/Toast';
import { formatDateShort } from '../../utils/formatters';
import {
  SUBJECT_RELATIONSHIPS, CONSENT_METHODS, CONSENT_SCOPES, INPUT_CLS, labelFor,
} from './constants';

// `self` is excluded — you are always your own subject and consent is implied.
const ADDABLE_RELATIONSHIPS = SUBJECT_RELATIONSHIPS.filter((r) => r.id !== 'self');

const EMPTY = { displayName: '', relationship: 'partner', consentMethod: 'verbal', consentNote: '' };

// Consent audit trail for one subject — loaded lazily on expand so opening the
// drawer costs one request, not one per household member.
function ConsentTrail({ subjectId }) {
  // null = not fetched · [] = fetched-and-empty · 'error' = fetch failed. A
  // failed read must NOT collapse into the empty case: "no consent on record"
  // is an assertion about the engine's state, and saying it because a request
  // failed would be a lie the user acts on.
  const [consents, setConsents] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || consents !== null) return;
    getPrivacySubjectConsents(subjectId, { silent: true })
      .then((rows) => setConsents(rows || []))
      .catch(() => setConsents('error'));
  }, [open, consents, subjectId]);

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Consent record
      </button>
      {open && (
        consents === null ? (
          <div className="text-[11px] text-gray-600 mt-1">Loading…</div>
        ) : consents === 'error' ? (
          <div className="text-[11px] text-gray-500 mt-1">Couldn&rsquo;t load the consent record.</div>
        ) : consents.length === 0 ? (
          <div className="text-[11px] text-port-warning mt-1">
            No consent on record — scans and opt-outs are refused for this person.
          </div>
        ) : (
          <ul className="mt-1 space-y-1">
            {consents.map((c) => (
              <li key={c.id} className="text-[11px] text-gray-500">
                <span className="text-gray-300">{labelFor(CONSENT_METHODS, c.method)}</span>
                {' · '}{labelFor(CONSENT_SCOPES, c.scope)}
                {c.grantedAt ? ` · ${formatDateShort(c.grantedAt)}` : ''}
                {c.note ? <span className="italic"> — {c.note}</span> : null}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

// Manage the household: who the Privacy Center tracks, on what consent.
// Consent is captured at creation because the engine refuses to scan or submit
// opt-outs for a subject with no consent row — the form cannot create a subject
// that the rest of the feature would then silently refuse to act on.
export default function SubjectsDrawer({ open, subjects, onClose, onCreated, onDeleted }) {
  const [form, setForm] = useState(EMPTY);
  const [adding, setAdding] = useState(false);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  useEffect(() => { if (open) { setForm(EMPTY); setAdding(false); cancelDelete(); } }, [open, cancelDelete]);

  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const [save, saving] = useAsyncAction(async () => {
    if (!form.displayName.trim()) { toast.error('Name is required'); return null; }
    const created = await createPrivacySubject({
      displayName: form.displayName.trim(),
      relationship: form.relationship,
      consentMethod: form.consentMethod,
      ...(form.consentNote.trim() ? { consentNote: form.consentNote.trim() } : {}),
    }, { silent: true });
    if (created) {
      toast.success(`${created.displayName} added to the household`);
      setForm(EMPTY);
      setAdding(false);
      onCreated(created);
    }
    return created;
  }, { errorMessage: 'Failed to add household member' });

  const handleDelete = async (subject) => {
    const ok = await deletePrivacySubject(subject.id, { silent: true }).catch(() => null);
    if (ok) {
      toast.success(`${subject.displayName} removed`);
      onDeleted(subject.id);
    } else {
      toast.error('Failed to remove household member');
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Household"
      subtitle="Everyone whose PII this install tracks"
      size="md"
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          Each person is scoped separately — their vault records, organizations, changes, and broker
          cases never mix. Broker scans and opt-out submissions are refused for anyone without a
          consent record.
        </p>

        <div className="space-y-2">
          {subjects.map((s) => (
            <div key={s.id} className="bg-port-card border border-port-border rounded-lg p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-white truncate">{s.displayName}</span>
                    <Pill size="xs">{labelFor(SUBJECT_RELATIONSHIPS, s.relationship)}</Pill>
                    {s.consentCount > 0 && (
                      <Pill size="xs" tone="success" icon={ShieldCheck}>Consented</Pill>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-gray-500">
                    {s.recordCount ?? 0} vault record{s.recordCount === 1 ? '' : 's'}
                  </div>
                  <ConsentTrail subjectId={s.id} />
                </div>
                {!s.isSelf && (
                  <button
                    onClick={() => requestDelete(s.id)}
                    title={`Remove ${s.displayName}`}
                    aria-label={`Remove ${s.displayName}`}
                    className="p-2 rounded text-gray-400 hover:text-port-error hover:bg-port-border/50 shrink-0"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              {isConfirming(s.id) && (
                <InlineConfirmRow
                  className="mt-3"
                  confirmText="Remove"
                  question={`Remove ${s.displayName}? Their vault records, organizations, changes, and broker cases are deleted too. This can't be undone.`}
                  onConfirm={() => confirmDelete(() => handleDelete(s))}
                  onCancel={cancelDelete}
                />
              )}
            </div>
          ))}
        </div>

        {adding ? (
          <form
            className="space-y-3 border border-port-border rounded-lg p-3"
            onSubmit={(e) => { e.preventDefault(); save(); }}
          >
            <FormField label="Name">
              <input
                type="text"
                value={form.displayName}
                onChange={(e) => set('displayName', e.target.value)}
                placeholder="e.g. Alex"
                className={INPUT_CLS}
                maxLength={200}
              />
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="Relationship">
                <select value={form.relationship} onChange={(e) => set('relationship', e.target.value)} className={INPUT_CLS}>
                  {ADDABLE_RELATIONSHIPS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </FormField>
              <FormField label="Consent captured via" hint="Required — the engine refuses to act without it.">
                <select value={form.consentMethod} onChange={(e) => set('consentMethod', e.target.value)} className={INPUT_CLS}>
                  {CONSENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </FormField>
            </div>

            <FormField label="Consent note">
              <textarea
                value={form.consentNote}
                onChange={(e) => set('consentNote', e.target.value)}
                rows={2}
                placeholder="e.g. signed form filed 2026-08-01"
                className={INPUT_CLS}
                maxLength={2000}
              />
            </FormField>

            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setAdding(false)} className="px-3 py-2 text-sm text-gray-400 hover:text-white">
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50"
              >
                {saving ? 'Adding…' : 'Add member'}
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80"
          >
            <Plus size={16} /> Add household member
          </button>
        )}
      </div>
    </Drawer>
  );
}
