// Pending-row buffer for "list of records where a new row is held client-side
// until a required column fills, then promoted to onChange." Mirrors the
// pattern previously inlined in CanonCard's WardrobeSection and
// CharacterDetailEditor's LIST_SECTIONS.
//
// Why pending-then-promote: persisting a blank row immediately would round-
// trip a row the server sanitizer drops, and the user's first keystroke
// would land in a row that disappears on the next render.
//
// Why client-only ids on pending rows: ListRow / WardrobeRow draft buffers
// (useRowDraft / useFieldDraft) are keyed by stable React key. Falling
// through to index would shift another row's drafts onto this one after a
// delete or promotion.
//
// idPrefix + stripIdOnPromote handle the two id-shape conventions:
//   - server-shaped (e.g. 'wd-<uuid>') round-trip verbatim — set
//     stripIdOnPromote=false so the same id stays on the row across the
//     pending → persisted swap (keeps the row's React key + draft buffer
//     stable through promotion).
//   - client-only (e.g. 'pending-<key>-<uuid>') must be stripped at promotion
//     so the server's sanitizer mints a fresh `<kind>-<uuid>` under its own
//     convention. The trade-off: the row's React key changes from
//     `pending-foo-<uuid>` to the server-stamped id, which remounts the row
//     and resets its inner draft buffer. Acceptable because the only path
//     into promotion is the user blurring the required column (no live
//     drafts on sibling columns at that moment).
//
import { useState } from 'react';
import { uuidv4 } from '../lib/uuid.js';

// `uuidv4` keeps the `<prefix><uuid>` shape above intact even on the insecure
// origins where `crypto.randomUUID` is undefined — see lib/uuid.js.
const mintId = (prefix) => `${prefix}${uuidv4()}`;

export default function usePendingListRows({
  persisted = [],
  requiredColumn,
  idPrefix = '',
  stripIdOnPromote = false,
  blankRow = () => ({}),
  onChange,
} = {}) {
  const [pending, setPending] = useState([]);

  const persistedLen = persisted.length;
  // Preserve the persisted array reference when no pending rows are present
  // so downstream `useMemo`/`React.memo` consumers don't see a new identity
  // on every render.
  const merged = pending.length ? [...persisted, ...pending] : persisted;
  const isPending = (idx) => idx >= persistedLen;

  const addRow = () => {
    const row = { id: mintId(idPrefix), ...blankRow() };
    setPending((prev) => [...prev, row]);
  };

  const updateRow = (idx, nextRow) => {
    if (idx < persistedLen) {
      onChange(persisted.map((r, i) => (i === idx ? nextRow : r)));
      return;
    }
    const pIdx = idx - persistedLen;
    const requiredFilled = String(nextRow[requiredColumn] || '').trim().length > 0;
    if (requiredFilled) {
      setPending((prev) => prev.filter((_, i) => i !== pIdx));
      let promoted = nextRow;
      if (stripIdOnPromote) {
        const { id: _drop, ...rest } = nextRow;
        promoted = rest;
      }
      onChange([...persisted, promoted]);
      return;
    }
    setPending((prev) => prev.map((r, i) => (i === pIdx ? nextRow : r)));
  };

  const removeRow = (idx) => {
    if (idx < persistedLen) {
      onChange(persisted.filter((_, i) => i !== idx));
      return;
    }
    const pIdx = idx - persistedLen;
    setPending((prev) => prev.filter((_, i) => i !== pIdx));
  };

  return { merged, isPending, addRow, updateRow, removeRow };
}
