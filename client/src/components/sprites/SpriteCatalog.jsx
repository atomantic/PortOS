/**
 * Sprite Catalog — the routable Library view of the Sprite Manager (was a modal
 * before this; the modal didn't scale and hid the library one click deep). It's
 * the default `/sprites` landing: a searchable, grouped grid of every sprite
 * with a preview thumbnail, plus per-card record CRUD — rename in place and
 * delete behind a cautious inline confirm (project convention: no
 * window.confirm, no two-click-arm — a discoverable Cancel/Delete pair).
 *
 * Picking a card navigates to `/sprites/:id`. Rename/delete call the record
 * endpoints directly and hand the result back up so the page updates its list
 * reactively (no full refetch).
 */

import { useMemo, useState } from 'react';
import {
  Search, Pencil, Trash2, Check, Package,
} from 'lucide-react';
import { groupSpriteRecords, filterSpriteRecords } from '../../lib/spriteRecordGroups.js';
import { GROUP_ICONS, groupIconForKind } from './spriteGroupIcons.js';
import SpritePreview from './SpritePreview.jsx';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { timeAgo } from '../../utils/formatters.js';
import useSpriteRecordCrud from '../../hooks/useSpriteRecordCrud.js';

// One catalog tile. Self-contained view/rename/confirm state (via
// useSpriteRecordCrud) so a rename or delete in one card never touches its
// neighbours. In view mode the whole tile is a single open-record button with
// the two action icons as SIBLINGS in the relative wrapper (never nested
// buttons — that's invalid markup); rename and confirm swap the tile for their
// own form so no interactive element nests.
function CatalogCard({ record, thumbPath, onOpen, onRenamed, onDeleted }) {
  const {
    mode, name, setName, busy, error, cancel, startRename, startDelete, saveRename, runDelete,
  } = useSpriteRecordCrud(record, { onRenamed, onDeleted });
  const Icon = groupIconForKind(record.kind);

  if (mode === 'rename') {
    return (
      <div className="p-3 rounded-lg border border-port-accent bg-port-bg space-y-2">
        <label htmlFor={`sprite-rename-${record.id}`} className="block text-xs text-gray-400">
          Rename <span className="text-gray-300">{record.name}</span>
        </label>
        <input
          id={`sprite-rename-${record.id}`}
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') cancel(); }}
          disabled={busy}
          className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-sm text-white"
        />
        {error && <p className="text-xs text-port-error break-words">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={saveRename}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-port-accent hover:bg-blue-600 text-white rounded disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" /> {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="px-2 py-1 text-xs bg-port-card border border-port-border text-gray-300 rounded hover:border-port-accent disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'confirm') {
    return (
      <div className="p-3 rounded-lg border border-port-error/50 bg-port-error/10 space-y-2">
        <p className="text-xs text-gray-200">
          Delete <span className="font-semibold break-words">{record.name}</span>? It leaves your
          library; the generated files stay on disk and its id stays reserved. This can’t be undone here.
        </p>
        {error && <p className="text-xs text-port-error break-words">{error}</p>}
        <ConfirmButtonPair
          confirmText="Delete"
          busyText="Deleting…"
          busy={busy}
          confirmIcon={Trash2}
          onConfirm={runDelete}
          onCancel={cancel}
          ariaLabel={`Confirm delete ${record.name}`}
        />
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpen(record.id)}
        className="w-full text-left rounded-lg border border-port-border bg-port-bg overflow-hidden transition-colors hover:border-gray-500"
      >
        {thumbPath ? (
          <SpritePreview
            recordId={record.id}
            path={thumbPath}
            alt=""
            cell={7}
            className="aspect-square w-full"
            imgClassName="w-full h-full object-contain"
          />
        ) : (
          <div className="aspect-square w-full flex items-center justify-center">
            <Icon className="w-10 h-10 text-gray-600" />
          </div>
        )}
        <div className="p-2 border-t border-port-border">
          <span className="block font-medium text-sm text-white truncate">{record.name}</span>
          <span className="block text-xs text-gray-500 truncate">
            {record.kind} · {record.status}{record.chromaKey ? ` · key ${record.chromaKey}` : ''}
          </span>
          <span className="block text-xs text-gray-600 truncate">
            {(record.updatedAt || record.createdAt) ? `updated ${timeAgo(record.updatedAt || record.createdAt)}` : ' '}
          </span>
        </div>
      </button>
      {/* Always-visible (not hover-gated — hover doesn't exist on touch) action
          icons in the corner, siblings of the card button so the markup stays
          valid. */}
      <div className="absolute top-1.5 right-1.5 flex gap-1">
        <button
          type="button"
          onClick={startRename}
          aria-label={`Rename ${record.name}`}
          className="p-1.5 rounded bg-port-card/90 border border-port-border text-gray-300 hover:text-white hover:border-port-accent"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={startDelete}
          aria-label={`Delete ${record.name}`}
          className="p-1.5 rounded bg-port-card/90 border border-port-border text-gray-300 hover:text-port-error hover:border-port-error"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export default function SpriteCatalog({
  records, thumbs, onOpen, onRenamed, onDeleted,
}) {
  const [query, setQuery] = useState('');
  // Infinity limit: the sidebar picker caps suggestions at 8, but the catalog
  // is the full-library browser — every match must show.
  const filtered = useMemo(() => filterSpriteRecords(records, query, Infinity), [records, query]);
  const groups = useMemo(() => groupSpriteRecords(filtered), [filtered]);

  return (
    <div className="space-y-5">
      <div className="relative w-full sm:w-72">
        <label htmlFor="sprite-catalog-filter" className="sr-only">Filter sprites</label>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          id="sprite-catalog-filter"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, id, or kind…"
          className="w-full bg-port-bg border border-port-border rounded pl-8 pr-3 py-1.5 text-sm text-white"
        />
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-gray-500">No sprites match “{query}”.</p>
      ) : groups.map((g) => {
        const Icon = GROUP_ICONS[g.key] || Package;
        return (
          <section key={g.key}>
            <h3 className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-500 mb-2">
              <Icon className="w-3.5 h-3.5" /> {g.label} ({g.records.length})
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {g.records.map((r) => (
                <CatalogCard
                  key={r.id}
                  record={r}
                  thumbPath={thumbs?.get(r.id)}
                  onOpen={onOpen}
                  onRenamed={onRenamed}
                  onDeleted={onDeleted}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
