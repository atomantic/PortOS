/**
 * CatalogCastPanel — a per-record "Cast (from Catalog)" surface.
 *
 * Lists `catalog_ingredient_refs` for a given (refKind, refId) and lets the
 * user attach/detach ingredients through the shared IngredientPicker. The
 * panel is purely additive: it owns no embedded array on the host record —
 * everything is backed by the catalog_ingredient_refs table.
 *
 * Props:
 *   refKind  — 'series' | 'issue' | 'work' (also 'universe', 'scene', etc.).
 *   refId    — the host record id.
 *   refLabel — optional human label of the host record, used in the picker
 *              header and empty-state copy (e.g. "this issue").
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import toast from './ui/Toast';
import IngredientPicker from './IngredientPicker';
import {
  listCatalogIngredientsForRef,
  linkCatalogIngredient,
  unlinkCatalogIngredient,
} from '../services/apiCatalog';
import { CATALOG_BADGE_BY_ID } from '../lib/catalogTypes';

const ROLE_BY_TYPE = {
  character: 'cast-character',
  place:     'cast-place',
  object:    'cast-object',
  idea:      'reference',
  scene:     'reference',
  concept:   'reference',
};

const roleForType = (type) => ROLE_BY_TYPE[type] || 'reference';

function snippet(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const text = String(payload.description || payload.summary || payload.notes || '').trim().replace(/\s+/g, ' ');
  if (text.length <= 160) return text;
  return `${text.slice(0, 157)}…`;
}

export default function CatalogCastPanel({ refKind, refId, refLabel }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    if (!refId) return undefined;
    let cancelled = false;
    setLoading(true);
    listCatalogIngredientsForRef(refKind, refId, { silent: true })
      .then((data) => {
        if (cancelled) return;
        setRows(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err.message || 'Failed to load catalog cast');
        setRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refKind, refId]);

  const handlePicked = async (picked) => {
    const ingredient = Array.isArray(picked) ? picked[0] : picked;
    if (!ingredient) return;
    const role = roleForType(ingredient.type);
    await linkCatalogIngredient(ingredient.id, { refKind, refId, role }, { silent: true })
      .then(() => {
        setRows((prev) => {
          if (prev.some((r) => r.ingredient.id === ingredient.id)) return prev;
          return [...prev, { ingredient, role }];
        });
        toast.success(`Linked ${ingredient.name || 'ingredient'}`);
      })
      .catch((err) => {
        toast.error(err.message || 'Link failed');
      });
  };

  const handleUnlink = async (row) => {
    const { ingredient, role } = row;
    // Busy key matches the row identity (id+role), so unlinking one role's
    // row doesn't spin/disable a sibling row for the same ingredient.
    setBusyId(`${ingredient.id}:${role || ''}`);
    await unlinkCatalogIngredient(ingredient.id, { refKind, refId, role }, { silent: true })
      .then(() => {
        // Ref rows are keyed by (ingredient_id, ref_kind, ref_id, role), so an
        // ingredient can be linked to the same record under multiple roles.
        // Drop only the (id, role) row that was unlinked — not every row sharing
        // the ingredient id.
        setRows((prev) => prev.filter((r) => !(r.ingredient.id === ingredient.id && r.role === role)));
      })
      .catch((err) => {
        toast.error(err.message || 'Unlink failed');
      })
      .finally(() => setBusyId(null));
  };

  const excludeIds = rows.map((r) => r.ingredient.id);
  const labelSuffix = refLabel ? ` for ${refLabel}` : '';

  return (
    <section className="rounded-lg border border-port-border bg-port-card/40 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-xs uppercase tracking-wider text-gray-500">Cast (from Catalog)</h3>
          <p className="text-[11px] text-gray-600">
            Characters, places, objects and references pinned to this record from the shared Catalog.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs bg-port-accent/15 border border-port-accent/40 text-port-accent hover:bg-port-accent/25"
        >
          <Plus size={12} aria-hidden="true" />
          Add from Catalog
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Loading cast…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-500 italic">
          No catalog ingredients linked yet. Click Add to pick from the Catalog{labelSuffix}.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const { ingredient, role } = row;
            const badge = CATALOG_BADGE_BY_ID[ingredient.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
            const text = snippet(ingredient.payload);
            const rowBusy = busyId === `${ingredient.id}:${role || ''}`;
            return (
              <li
                key={`${ingredient.id}:${role || ''}`}
                className="flex items-start gap-3 p-2.5 rounded border border-port-border bg-port-bg/40"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-white truncate">
                      {ingredient.name || '(untitled)'}
                    </span>
                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badge}`}>
                      {ingredient.type}
                    </span>
                    {role ? (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-port-border text-gray-500">
                        {role}
                      </span>
                    ) : null}
                  </div>
                  {text ? (
                    <p className="text-xs text-gray-400 mt-1 line-clamp-2">{text}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => handleUnlink(row)}
                  disabled={rowBusy}
                  aria-label={`Unlink ${ingredient.name || ingredient.id}`}
                  className="p-1.5 rounded text-gray-500 hover:text-port-error hover:bg-port-bg disabled:opacity-50"
                  title="Unlink from this record"
                >
                  {rowBusy
                    ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    : <Trash2 size={14} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <IngredientPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePicked}
        excludeIds={excludeIds}
        refKind={refKind}
        refId={refId}
      />
    </section>
  );
}
