import { CATALOG_REDESIGN_FIELDS } from '../../../../server/lib/catalogRedesign.js';
import { lazy, Suspense } from 'react';
import { Wand2 } from 'lucide-react';
import { refineCatalogDraft } from '../../services/apiCatalog';

const CreativeRefinement = lazy(() => import('../creative/CreativeRefinement'));

export function CatalogRedesignButton({ type, open, onToggle, controls }) {
  if (!CATALOG_REDESIGN_FIELDS[type]) return null;
  return <button type="button" onClick={onToggle} aria-expanded={!!open} aria-controls={controls}
    aria-label={open ? 'Close redesign conversation' : 'Redesign with a creative assistant'}
    title="Redesign with a creative assistant"
    className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-port-accent px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10">
    <Wand2 size={14} aria-hidden="true" />{open ? 'Close redesign' : 'Redesign'}
  </button>;
}

export default function CatalogRedesign({ ingredient, payload, disabled, onApply, onFork, open, id }) {
  if (!CATALOG_REDESIGN_FIELDS[ingredient.type]) return null;
  const draft = Object.fromEntries(Object.keys(CATALOG_REDESIGN_FIELDS[ingredient.type]).map(key => [key, typeof payload[key] === 'string' ? payload[key] : '']));
  return <div id={id} hidden={!open}>
    {open !== null && <Suspense fallback={<p className="text-xs text-gray-400">Loading creative assistant…</p>}><CreativeRefinement initialDraft={draft} fieldLimits={CATALOG_REDESIGN_FIELDS[ingredient.type]} disabled={disabled} onApply={onApply} onFork={onFork}
      converse={(body, options) => refineCatalogDraft(ingredient.id, body, options)} /></Suspense>}
  </div>;
}
