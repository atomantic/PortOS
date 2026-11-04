import { useId, useState } from 'react';
import { Link } from 'react-router';
import { Plus, Users, X } from 'lucide-react';
import IngredientPicker from '../IngredientPicker';
import { FAMILY_RELATION_KINDS, getRelationKind } from '../../lib/catalogTypes';
import { ingredientPath } from '../../lib/creativeLibraries';

const FAMILY_MAX = 6;

/**
 * Family ties a character holds to other cast records: "<this one> is the
 * Mother of <Nora>". `items` are `{ kind, id, name }`; the caller decides
 * whether add/remove save at once (record page) or ride a create form.
 * `inbound` lists ties other records hold to this one, read-only.
 */
export default function CatalogFamilyPicker({ items, onAdd, onRemove, excludeIds = [], inbound = [], disabled = false, selfName = '' }) {
  const fieldId = useId();
  const [kind, setKind] = useState(FAMILY_RELATION_KINDS[0].id);
  const [picking, setPicking] = useState(false);
  const full = items.length >= FAMILY_MAX;
  const self = selfName.trim() || 'This character';

  return (
    <section aria-labelledby={`${fieldId}-heading`} className="space-y-2">
      <h3 id={`${fieldId}-heading`} className="text-xs uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
        <Users size={12} aria-hidden="true" /> Family
      </h3>
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="inline-flex items-center gap-1 rounded-full border border-port-border bg-port-bg pl-3 pr-1 min-h-[36px] text-sm">
              <span className="text-gray-400">{getRelationKind(item.kind)?.label || item.kind}</span>
              <span className="text-white truncate max-w-[12rem]">{item.name || item.id}</span>
              <button type="button" disabled={disabled} onClick={() => onRemove(item)}
                aria-label={`Remove ${getRelationKind(item.kind)?.label || item.kind} ${item.name || item.id}`}
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center justify-center min-w-[32px] min-h-[32px] rounded-full text-gray-500 hover:text-port-error disabled:opacity-50">
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <label htmlFor={`${fieldId}-kind`} className="sr-only">{self} is the</label>
        <select id={`${fieldId}-kind`} value={kind} disabled={disabled || full} onChange={(e) => setKind(e.target.value)}
          className="min-h-[40px] min-w-0 flex-1 sm:flex-none px-2 bg-port-bg border border-port-border rounded text-white text-sm">
          {FAMILY_RELATION_KINDS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <button type="button" disabled={disabled || full} onClick={() => setPicking(true)}
          className="inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3 rounded border border-port-border text-sm text-gray-200 hover:border-port-accent disabled:opacity-50">
          <Plus size={14} aria-hidden="true" /> Pick cast
        </button>
      </div>
      <p className="text-xs text-gray-500">
        {items.length ? `Their canonical images and descriptions guide ${self}’s renders: blood relatives for resemblance, spouses for a fitting era and age.`
          : `Pick how ${self} is related to existing cast so renders keep the family likeness.`}
      </p>
      {inbound.length > 0 && (
        <ul className="text-xs text-gray-400 space-y-1">
          {inbound.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <Link to={ingredientPath({ type: 'character', id: item.id })} className="text-port-accent hover:underline">{item.name || item.id}</Link>
              {' is the '}{(getRelationKind(item.kind)?.term || item.kind)} of {self}
            </li>
          ))}
        </ul>
      )}
      <IngredientPicker open={picking} type="character" onClose={() => setPicking(false)}
        excludeIds={[...excludeIds, ...items.filter((i) => i.kind === kind).map((i) => i.id)]}
        onSelect={(record) => { setPicking(false); onAdd(kind, record); }} />
    </section>
  );
}
