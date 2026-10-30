import { CATALOG_REDESIGN_FIELDS } from '../../../../server/lib/catalogRedesign.js';
import { lazy, Suspense, useState } from 'react';
import { refineCatalogDraft } from '../../services/apiCatalog';

const CreativeRefinement = lazy(() => import('../creative/CreativeRefinement'));

export default function CatalogRedesign({ ingredient, payload, disabled, onApply, onFork }) {
  const [open, setOpen] = useState(null);
  if (!CATALOG_REDESIGN_FIELDS[ingredient.type]) return null;
  const draft = Object.fromEntries(Object.keys(CATALOG_REDESIGN_FIELDS[ingredient.type]).map(key => [key, typeof payload[key] === 'string' ? payload[key] : '']));
  return <div className="space-y-2">
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={!!open} className="inline-flex min-h-11 items-center rounded border border-port-accent px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10">{open ? 'Close redesign conversation' : 'Redesign with a creative assistant…'}</button>
    {open !== null && <div hidden={!open}><Suspense fallback={<p className="text-xs text-gray-400">Loading creative assistant…</p>}><CreativeRefinement initialDraft={draft} fieldLimits={CATALOG_REDESIGN_FIELDS[ingredient.type]} disabled={disabled} onApply={onApply} onFork={onFork}
      converse={(body, options) => refineCatalogDraft(ingredient.id, body, options)} /></Suspense></div>}
  </div>;
}
