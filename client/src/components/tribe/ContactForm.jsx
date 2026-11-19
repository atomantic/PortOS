import { useEffect } from 'react';
import { Edit3, Plus, Save, Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import useConfirmDelete from '../../hooks/useConfirmDelete';
import { ENERGY, RINGS, ringFor } from '../../lib/tribe.js';

const INPUT_CLASS = 'mt-1 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white outline-none focus:border-port-accent';
const LABEL_CLASS = 'block text-xs text-gray-500';

export default function ContactForm({
  draft,
  onChange,
  onSave,
  onDelete,
  onNew,
  isExisting,
  saving,
  deleting = false,
  nameInputRef,
  formRef,
}) {
  const update = (field, value) => onChange({ ...draft, [field]: value });
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  useEffect(() => {
    cancelDelete();
  }, [draft.id, cancelDelete]);

  return (
    <form
      ref={formRef}
      className="border border-port-border bg-port-card rounded p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Edit3 size={18} className="text-port-accent shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-white truncate">{isExisting ? 'Relationship' : 'New Relationship'}</h2>
        </div>
        {isExisting && (
          <button
            type="button"
            onClick={onNew}
            title="New relationship"
            aria-label="New relationship"
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex h-9 w-9 items-center justify-center rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-border/40"
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="tribe-contact-name" className={LABEL_CLASS}>Name</label>
          <input
            id="tribe-contact-name"
            ref={nameInputRef}
            value={draft.name}
            onChange={(event) => update('name', event.target.value)}
            className={INPUT_CLASS}
            placeholder="Person"
          />
        </div>
        <div>
          <label htmlFor="tribe-contact-relationship" className={LABEL_CLASS}>Relationship</label>
          <input
            id="tribe-contact-relationship"
            value={draft.relationship}
            onChange={(event) => update('relationship', event.target.value)}
            className={INPUT_CLASS}
            placeholder="Friend, mentor, family"
          />
        </div>
        <div>
          <label htmlFor="tribe-contact-ring" className={LABEL_CLASS}>Ring</label>
          <select
            id="tribe-contact-ring"
            value={draft.ring}
            onChange={(event) => {
              const ring = ringFor(event.target.value);
              onChange({ ...draft, ring: ring.id, cadenceDays: ring.cadenceDays });
            }}
            className={INPUT_CLASS}
          >
            {RINGS.map((ring) => <option key={ring.id} value={ring.id}>{ring.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="tribe-contact-cadence" className={LABEL_CLASS}>Cadence</label>
          <input
            id="tribe-contact-cadence"
            type="number"
            min="1"
            value={draft.cadenceDays}
            onChange={(event) => update('cadenceDays', event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="tribe-contact-last-contact" className={LABEL_CLASS}>Last Contact</label>
          <input
            id="tribe-contact-last-contact"
            type="date"
            value={draft.lastContact}
            onChange={(event) => update('lastContact', event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="tribe-contact-energy" className={LABEL_CLASS}>Energy</label>
          <select
            id="tribe-contact-energy"
            value={draft.energy}
            onChange={(event) => update('energy', event.target.value)}
            className={INPUT_CLASS}
          >
            {ENERGY.map((energy) => <option key={energy.id} value={energy.id}>{energy.label}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="tribe-contact-channel" className={LABEL_CLASS}>Channel</label>
          <input
            id="tribe-contact-channel"
            value={draft.channel}
            onChange={(event) => update('channel', event.target.value)}
            className={INPUT_CLASS}
            placeholder="Text, call, dinner, walk"
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="tribe-contact-tags" className={LABEL_CLASS}>Tags</label>
          <input
            id="tribe-contact-tags"
            value={draft.tags}
            onChange={(event) => update('tags', event.target.value)}
            className={INPUT_CLASS}
            placeholder="comma, separated"
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="tribe-contact-emails" className={LABEL_CLASS}>Emails &amp; handles</label>
          <input
            id="tribe-contact-emails"
            value={draft.emails}
            onChange={(event) => update('emails', event.target.value)}
            className={INPUT_CLASS}
            placeholder="jane@work.com, jane@home.com"
          />
          <p className="mt-1 text-[11px] text-gray-600">
            Auto-logs a touchpoint when this person appears in a synced calendar event or message.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="tribe-contact-phones" className={LABEL_CLASS}>Phone numbers</label>
          <input
            id="tribe-contact-phones"
            value={draft.phones}
            onChange={(event) => update('phones', event.target.value)}
            className={INPUT_CLASS}
            placeholder="+1 555 123 4567, 555 987 6543"
          />
          <p className="mt-1 text-[11px] text-gray-600">
            Matches this person to iMessage conversations (saved in +E.164 form).
          </p>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="tribe-contact-next-move" className={LABEL_CLASS}>Next Move</label>
          <textarea
            id="tribe-contact-next-move"
            value={draft.nextMove}
            onChange={(event) => update('nextMove', event.target.value)}
            rows={2}
            className={INPUT_CLASS}
            placeholder="A concrete next touchpoint"
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="tribe-contact-notes" className={LABEL_CLASS}>Notes</label>
          <textarea
            id="tribe-contact-notes"
            value={draft.notes}
            onChange={(event) => update('notes', event.target.value)}
            rows={4}
            className={INPUT_CLASS}
            placeholder="Context worth remembering"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded bg-port-accent px-3 py-2 text-sm font-medium text-black hover:bg-port-accent/90"
        >
          <Save size={15} aria-hidden="true" />
          {saving ? 'Saving' : 'Save'}
        </button>
        {isExisting && (
          isConfirming(draft.id) ? (
            <ConfirmButtonPair
              prompt="Delete?"
              confirmIcon={Trash2}
              onConfirm={() => confirmDelete(onDelete)}
              onCancel={cancelDelete}
              busy={deleting}
              busyText="Deleting"
              ariaLabel="Confirm delete relationship"
              confirmAriaLabel="Confirm delete relationship"
              cancelAriaLabel="Cancel delete relationship"
            />
          ) : (
            <button
              type="button"
              onClick={() => requestDelete(draft.id)}
              className="inline-flex items-center gap-2 rounded border border-rose-500/40 px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10"
            >
              <Trash2 size={15} aria-hidden="true" />
              Delete
            </button>
          )
        )}
      </div>
    </form>
  );
}
