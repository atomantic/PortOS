import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { RINGS } from '../../../lib/tribe.js';

/**
 * The inline "Create new…" form for a Beeper participant row (fork issue #97
 * part A). Replaces the old immediate-create path: `BeeperPersonPicker`'s
 * "Create new…" row used to call straight through to
 * `POST /tribe/beeper/link-new` with the participant's own display name —
 * for a network where that name is a handle or a nickname, the person got
 * created under the wrong name with no chance to correct it before the
 * record existed.
 *
 * This form IS that chance. It posts nothing itself — only `onCreate` does,
 * and only when Create is pressed (or Enter is hit with a non-blank name);
 * Cancel (or Escape) discards it and returns the row to the picker.
 *
 * `RINGS` is the exact same list (`client/src/lib/tribe.js`) the Tribe
 * page's own person editor renders its ring `<select>` from, so a person
 * created here looks identical to one created on the Tribe page rather than
 * inventing a second, driftable copy of the ring options.
 */
export default function BeeperCreatePersonForm({
  participant, onCreate, onCancel, disabled = false,
}) {
  const initialName = participant.displayName || participant.handle || '';
  const [name, setName] = useState(initialName);
  const [ring, setRing] = useState('tribe');
  const [relationship, setRelationship] = useState('');
  // Native `autoFocus` (below) fires once, on this element's own mount — the
  // form is a fresh subtree every time the row switches into 'create' mode,
  // so there is no need for a ref+effect dance to refocus on every render.
  const nameRef = useRef(null);

  const trimmedName = name.trim();
  const canCreate = trimmedName.length > 0 && !disabled;

  const submit = () => {
    if (!canCreate) return;
    onCreate({ name: trimmedName, ring, relationship: relationship.trim() });
  };

  // Enter/Escape are handled once on the wrapping group rather than on each
  // field individually — bubbling keydown covers the name field, the ring
  // select and the relationship field alike, so Enter submits and Escape
  // cancels no matter which of the three currently has focus.
  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      role="group"
      aria-label={`Create a Tribe person from ${participant.displayName || participant.sourceUserId}`}
      className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
      onKeyDown={handleKeyDown}
    >
      <input
        ref={nameRef}
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={disabled}
        autoFocus
        required
        placeholder="Name"
        aria-label="Name"
        className="min-w-0 flex-1 rounded border border-port-border bg-port-bg px-1.5 py-1 text-[11px] text-gray-200 placeholder:text-gray-500 focus:outline-none disabled:opacity-50"
      />
      <select
        value={ring}
        onChange={(event) => setRing(event.target.value)}
        disabled={disabled}
        aria-label="Ring"
        className="shrink-0 rounded border border-port-border bg-port-bg px-1 py-1 text-[11px] text-gray-200 focus:outline-none disabled:opacity-50"
      >
        {RINGS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <input
        type="text"
        value={relationship}
        onChange={(event) => setRelationship(event.target.value)}
        disabled={disabled}
        placeholder="Relationship (optional)"
        aria-label="Relationship"
        className="min-w-0 flex-1 rounded border border-port-border bg-port-bg px-1.5 py-1 text-[11px] text-gray-200 placeholder:text-gray-500 focus:outline-none disabled:opacity-50"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!canCreate}
        aria-label="Create"
        className="shrink-0 rounded border border-port-accent px-2 py-1 text-[11px] text-port-accent transition-colors hover:bg-port-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {disabled ? <Loader2 size={11} className="animate-spin" /> : 'Create'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 text-[11px] text-gray-400 transition-colors hover:text-gray-200"
      >
        Cancel
      </button>
    </div>
  );
}
