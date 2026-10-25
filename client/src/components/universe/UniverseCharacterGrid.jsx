import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import CharacterCard from '../catalog/CharacterCard';
import CharacterActions from '../catalog/CharacterActions';
import useCatalogCards from '../../hooks/useCatalogCards';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';

function UniverseCharacterCard({ entry, ingredient, unavailable, to, context, onUpdated }) {
  const jobId = context.renderingJobs[entry.id] || context.externalPendingByEntryId?.[entry.id] || null;
  const { status, filename, error } = useMediaJobProgress(jobId);
  const settled = useRef(null);
  useEffect(() => {
    if (!jobId) { settled.current = null; return; }
    if (settled.current === jobId) return;
    if (status === 'completed' && filename) {
      settled.current = jobId;
      context.onJobCompleted?.(entry.id, filename, jobId);
    } else if (status === 'failed' || status === 'canceled') {
      settled.current = jobId;
      context.onJobFailed?.(entry.id, error || status, jobId);
    }
  }, [jobId, status, filename, error, entry.id, context]);
  const blocked = unavailable || ingredient.sharedIdentity?.writable === false || ingredient.payload?.locked === true;
  return <CharacterCard ingredient={ingredient} unavailable={unavailable} to={to} onUpdated={onUpdated}
    actions={locking => <CharacterActions name={entry.name} disabled={blocked || locking} renderDisabled={unavailable || ingredient.sharedIdentity?.writable === false || locking} busy={!!context.refiningId || !!context.expandingId} rendering={!!jobId}
      onRender={context.kind.descFor(entry).trim() ? () => context.onRender(entry) : null}
      onRefine={context.onRefine ? () => context.onRefine(entry.id) : null}
      onExpand={context.onExpandCharacter ? () => context.onExpandCharacter(entry.id) : null}
      onDescribe={context.onDescribeImages ? () => context.onDescribeImages(entry) : null}
      onCorrect={context.onCorrectFromImage ? () => context.onCorrectFromImage(entry) : null}
      onRemove={context.onRemoveEntry ? () => context.onRemoveEntry(entry.id) : null} />} />;
}

export default function UniverseCharacterGrid({ context }) {
  const { all, onCatalogLockChanged } = context;
  const { pathname, search } = useLocation();
  const cards = useCatalogCards(all.map(entry => entry.ingredientId));
  return <div className="space-y-2">
    {cards.error && <p role="alert" className="text-xs text-port-error">Could not refresh catalog cards. <button type="button" onClick={cards.retry} className="underline">Retry cards</button></p>}
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
      {all.map(entry => {
        const card = cards.cards[entry.ingredientId];
        const ingredient = card || { id: entry.ingredientId || null, type: 'character', name: entry.name, payload: entry };
        const to = entry.ingredientId ? `/casting/${encodeURIComponent(entry.ingredientId)}?${new URLSearchParams({ returnTo: `${pathname}${search}` })}` : null;
        return <UniverseCharacterCard key={entry.id} entry={entry} ingredient={ingredient} unavailable={!card || !!cards.error || cards.missing.includes(entry.ingredientId)} to={to} context={context}
          onUpdated={updated => { cards.update(updated); onCatalogLockChanged?.(entry.id, updated); }} />;
      })}
    </ul>
  </div>;
}
