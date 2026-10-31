import { useState } from 'react';
import { Link } from 'react-router';
import { Sparkles } from 'lucide-react';
import MediaImage from '../MediaImage';
import CatalogLockButton from './CatalogLockButton';
import CatalogImageAction from './CatalogImageAction';
import { ingredientCoverUrl, ingredientPath, usageSummary } from '../../lib/creativeLibraries';

export default function CharacterCard({ ingredient, to = null, onUpdated, actions = null, unavailable = false }) {
  const [locking, setLocking] = useState(false);
  const [generatedCover, setGeneratedCover] = useState(null);
  const name = ingredient.name || '(untitled)';
  const persistedCover = ingredientCoverUrl(ingredient);
  // Bridge the stale card only until an authoritative cover/revision arrives.
  const cover = generatedCover?.baseline === persistedCover && generatedCover?.revision === ingredient.updatedAt
    ? generatedCover.src : persistedCover;
  const href = to || (ingredient.id ? ingredientPath(ingredient) : null);
  const role = typeof ingredient.payload?.role === 'string' ? ingredient.payload.role : '';
  const description = [ingredient.payload?.physicalDescription, ingredient.payload?.description].find(value => typeof value === 'string' && value) || 'No description yet.';
  const content = <>
    <div className="aspect-[3/4] w-full bg-port-bg flex items-center justify-center overflow-hidden">
      {cover ? <MediaImage thumbnail src={cover} alt={name} className="w-full h-full object-cover" loading="lazy" />
        : <Sparkles size={22} className="text-gray-500" aria-hidden="true" />}
    </div>
    <div className="p-3 space-y-1 min-w-0">
      <h3 className="text-sm text-white font-semibold break-words">{name}</h3>
      {role && <p className="text-xs text-port-accent line-clamp-2 break-words">{role}</p>}
      <p className="text-[11px] text-gray-400 break-words">{ingredient.owningUniverse ? `Universe: ${ingredient.owningUniverse.name}` : 'Ownership needs review'}</p>
      <p className="text-xs text-gray-400 line-clamp-3 break-words">{description}</p>
      <p className="text-[11px] text-gray-500 break-words">{unavailable ? 'Catalog context unavailable' : usageSummary(ingredient.usage) || 'No linked containers'}</p>
      {ingredient.sharedIdentity?.writable === false && <p className="text-xs text-port-warning">Read-only shared identity</p>}
    </div>
  </>;
  return <li className="min-w-0 h-full">
    <article aria-label={`${name} character card`} className="flex flex-col h-full rounded-lg border border-port-border bg-port-card overflow-hidden hover:border-port-accent/60">
      {href ? <Link to={href} className="block flex-1 min-w-0" aria-label={`Open ${name}`}>{content}</Link> : <div className="flex-1 min-w-0">{content}</div>}
      <div className="border-t border-port-border p-2 space-y-2">
        {ingredient.id && <CatalogLockButton key={ingredient.id} record={ingredient} disabled={unavailable} onChanged={onUpdated} onPendingChange={setLocking} />}
        {ingredient.id && !actions && <CatalogImageAction ingredient={ingredient} disabled={unavailable || locking}
          onCover={src => setGeneratedCover({ src, baseline: persistedCover, revision: ingredient.updatedAt })} />}
        {typeof actions === 'function' ? actions(locking) : actions}
      </div>
    </article>
  </li>;
}
