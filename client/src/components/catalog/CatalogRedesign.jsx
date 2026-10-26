import { CATALOG_REDESIGN_FIELDS } from '../../../../server/lib/catalogRedesign.js';
import { useState } from 'react';
import CreativeRefinement from '../creative/CreativeRefinement';
import { refineCatalogDraft } from '../../services/apiCatalog';

export default function CatalogRedesign({ ingredient, payload, disabled, onApply }) {
  const [open, setOpen] = useState(null);
  if (!CATALOG_REDESIGN_FIELDS[ingredient.type]) return null;
  const draft = Object.fromEntries(Object.keys(CATALOG_REDESIGN_FIELDS[ingredient.type]).map(key => [key, typeof payload[key] === 'string' ? payload[key] : '']));
  return <div className="space-y-2">
    <button type="button" onClick={() => setOpen(value => !value)} className="text-sm text-port-accent">{open ? 'Close redesign conversation' : 'Redesign with a creative assistant…'}</button>
    {open !== null && <div hidden={!open}><CreativeRefinement initialDraft={draft} fieldLimits={CATALOG_REDESIGN_FIELDS[ingredient.type]} disabled={disabled} onApply={onApply}
      converse={(body, options) => refineCatalogDraft(ingredient.id, body, options)} /></div>}
  </div>;
}
