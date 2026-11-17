import { Plus, Trash2 } from 'lucide-react';
import useRowDraft from '../../../hooks/useRowDraft';
import usePendingListRows from '../../../hooks/usePendingListRows';
import { useDraftCommitMode } from '../../../hooks/useDraftCommitMode';
import BoxedSection from './BoxedSection';

// Generic list editor row — one input per `columns` spec, plus delete.
// Multi-column draft+blur (with sibling ride-along) lives in `useRowDraft`.
function ListRow({ row, idx, columns, swatchHex, onChange, onDelete, disabled }) {
  const { draftFor, setDraft, commit } = useRowDraft(row, onChange);
  return (
    <div className="flex items-start gap-1.5">
      {swatchHex ? (
        <span
          className="shrink-0 w-6 h-6 rounded border border-port-border mt-0.5"
          style={{ background: swatchHex(row) || 'transparent' }}
          title={`Preview ${swatchHex(row) || 'no hex'}`}
        />
      ) : null}
      {/* A `narrow` column (the hex swatch) keeps a fixed width so the rows line
          up, but 6rem of a phone-width row starves the free-text sibling —
          step it down under `sm`. */}
      {columns.map((col) => (
        <input
          key={col.name}
          type="text"
          value={draftFor(col.name)}
          onChange={(e) => setDraft(col.name, e.target.value)}
          onBlur={() => commit(col.name)}
          placeholder={col.placeholder}
          maxLength={col.max}
          disabled={disabled}
          className={`${col.narrow ? 'w-16 sm:w-24 shrink-0' : 'flex-1 min-w-0'} px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50`}
          aria-label={`row ${idx + 1} ${col.name}`}
        />
      ))}
      <button
        type="button"
        onClick={() => onDelete(idx)}
        disabled={disabled}
        title="Remove row" aria-label="Remove row"
        className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// One LIST_SECTION's row buffer + UI. Extracted so each section gets its
// own `usePendingListRows` instance (hooks can't be called inside the parent's
// `LIST_SECTIONS.map`). Pending ids carry the `pending-<key>-<uuid>` prefix
// and are stripped on promotion so the server's `ensureId` mints a fresh
// `<kind>-<uuid>` under its own convention — see usePendingListRows.js for
// the trade-off this strip implies for sibling drafts.
export default function ListSectionEditor({ section, entry, onPatchList, disabled }) {
  const parentDraft = useDraftCommitMode() === 'change';
  const rawPersisted = (Array.isArray(entry[section.field]) ? entry[section.field] : []).filter((item) => section.stringList
    ? typeof item === 'string' : item && typeof item === 'object' && typeof item[section.columns[0].name] === 'string');
  // A `stringList` section (e.g. `secrets`) persists a plain string[] on the
  // server, but the generic row editor works on objects keyed by the single
  // column name. Marshal string → { [col]: string } on the way in and back to
  // string on the way out so the section stays server-shape-correct.
  const col0 = section.columns[0].name;
  // Stamp a CONTENT-derived stable id on each marshalled string-list row so
  // ListRow's React key (and its `useRowDraft` buffer) survives a delete/reorder
  // of an earlier row — a plain index key would shift a sibling's draft onto the
  // wrong secret, the exact footgun the ListRow key comment warns about. The
  // per-content occurrence counter disambiguates exact-duplicate strings.
  const stringListRows = () => {
    const seen = new Map();
    return rawPersisted.map((s) => {
      const text = typeof s === 'string' ? s : '';
      const n = seen.get(text) || 0;
      seen.set(text, n + 1);
      return { id: `${section.key}-${n}-${text}`, [col0]: text };
    });
  };
  const persisted = section.stringList ? stringListRows() : rawPersisted;
  const emit = (next) => onPatchList(
    section.field,
    section.stringList
      ? parentDraft ? next.map(r => r?.[col0] || '') : next.map((r) => (r?.[col0] || '').trim()).filter(Boolean)
      : next,
  );
  const buffered = usePendingListRows({
    persisted,
    requiredColumn: col0,
    idPrefix: `pending-${section.key}-`,
    stripIdOnPromote: true,
    blankRow: () => Object.fromEntries(section.columns.map((c) => [c.name, ''])),
    onChange: emit,
  });
  // Explicit-save catalog drafts own even incomplete rows. Otherwise typing a
  // value before its required label would stay invisible to Save/exit guards.
  const { merged, addRow, updateRow, removeRow } = parentDraft ? {
    merged: persisted,
    addRow: () => emit([...persisted, Object.fromEntries(section.columns.map(column => [column.name, '']))]),
    updateRow: (index, row) => emit(persisted.map((item, i) => i === index ? row : item)),
    removeRow: index => emit(persisted.filter((_, i) => i !== index)),
  } : buffered;
  const summary = merged.length === 0
    ? 'empty'
    : `${merged.length} ${merged.length === 1 ? section.singular : section.singular + 's'}`;
  return (
    <BoxedSection
      icon={section.icon}
      label={section.label}
      summary={summary}
    >
      {merged.length === 0 ? (
        <p className="text-[11px] text-gray-500 italic">No {section.label.toLowerCase()} yet.</p>
      ) : (
        <div className="space-y-1.5">
          {merged.map((row, idx) => (
            <ListRow
              // Every persisted row carries a server-stamped id (see
              // sanitizeStat / sanitizePaletteColor / etc.) and every
              // pending row gets a client-only id from `addRow`. The
              // index fallback would tie ListRow's local `drafts` state
              // to a slot, so a delete on an earlier row would shift
              // another row's drafts onto this one.
              // Parent-owned drafts have no delayed row commits. A stable slot
              // key also keeps focus when a pending row is promoted on typing.
              key={parentDraft ? `${section.key}-${idx}` : row.id || `${section.key}-${idx}`}
              row={row}
              idx={idx}
              columns={section.columns}
              swatchHex={section.swatchHex}
              onChange={(next) => updateRow(idx, next)}
              onDelete={() => removeRow(idx)}
              disabled={disabled}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={addRow}
        disabled={disabled}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
      >
        <Plus size={10} /> {section.addLabel}
      </button>
    </BoxedSection>
  );
}
