import { useMemo, useState } from 'react';
import { Compass, Star } from 'lucide-react';
import { updateCatalogIngredientMediaLibrary, attachCatalogIngredientMediaFromMoodBoard } from '../../services/apiCatalog';

// Casting reference library: tag each reference/sheet/still/clip of a cast
// member with the variant it shows (age, era, look) plus tags, mark up to four
// as render guides, and filter the library by those fields. The media grid
// below still owns attach/upload/detach/portrait.
export const MAX_CAST_GUIDES = 4;
const ERAS = ['child', 'teen', 'adult', 'elder'];
const LIBRARY_KINDS = new Set(['portrait', 'reference', 'video']);
const eraFor = (m) => m.library?.variant?.era
  || (Number.isInteger(m.library?.variant?.age) ? (m.library.variant.age < 13 ? 'child' : m.library.variant.age < 20 ? 'teen' : m.library.variant.age < 65 ? 'adult' : 'elder') : '');

export default function CatalogReferenceLibrary({ ingredientId, media = [], readOnly = false, onChanged }) {
  const [filter, setFilter] = useState({ age: '', era: '', tag: '', guides: false });
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [boardId, setBoardId] = useState('');
  const [itemIds, setItemIds] = useState('');

  const rows = useMemo(() => media.filter((m) => !m.deleted && LIBRARY_KINDS.has(m.kind)), [media]);
  const guideCount = rows.filter((m) => m.library?.guide === true).length;
  const ages = [...new Set(rows.map((m) => m.library?.variant?.age).filter(Number.isInteger))].sort((a, b) => a - b);
  const tags = [...new Set(rows.flatMap((m) => m.library?.tags || []))].sort();
  const visible = rows.filter((m) => (filter.age === '' || m.library?.variant?.age === Number(filter.age))
    && (!filter.era || eraFor(m) === filter.era)
    && (!filter.tag || (m.library?.tags || []).includes(filter.tag))
    && (!filter.guides || m.library?.guide === true));

  const save = async (m, patch) => {
    setError('');
    setBusyKey(`${m.kind}:${m.mediaKey}`);
    try {
      await updateCatalogIngredientMediaLibrary(ingredientId, { mediaKey: m.mediaKey, kind: m.kind, ...patch });
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'Could not update reference');
    } finally {
      setBusyKey('');
    }
  };

  const importBoard = async () => {
    const ids = itemIds.split(/[\s,]+/).filter(Boolean);
    if (!boardId.trim() || ids.length === 0) return;
    setError('');
    try {
      await attachCatalogIngredientMediaFromMoodBoard(ingredientId, { boardId: boardId.trim(), itemIds: ids, inferAge: true });
      setItemIds('');
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'Could not import from mood board');
    }
  };

  return (
    <section aria-label="Reference library" className="space-y-3 rounded border border-port-border p-3">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <h3 className="font-semibold">Reference library</h3>
        <span data-testid="guide-count" className="text-gray-400">{guideCount}/{MAX_CAST_GUIDES} render guides</span>
        <label className="ml-auto flex items-center gap-1">Age
          <select aria-label="Filter by age" value={filter.age} onChange={(e) => setFilter({ ...filter, age: e.target.value })} className="bg-port-card">
            <option value="">All</option>
            {ages.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">Era
          <select aria-label="Filter by era" value={filter.era} onChange={(e) => setFilter({ ...filter, era: e.target.value })} className="bg-port-card">
            <option value="">All</option>
            {ERAS.map((era) => <option key={era} value={era}>{era}</option>)}
          </select>
        </label>
        {tags.length > 0 && (
          <label className="flex items-center gap-1">Tag
            <select aria-label="Filter by tag" value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })} className="bg-port-card">
              <option value="">All</option>
              {tags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={filter.guides} onChange={(e) => setFilter({ ...filter, guides: e.target.checked })} /> Guides only
        </label>
      </header>
      {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
      {visible.length === 0 ? <p className="text-sm text-gray-400">No references match.</p> : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((m) => {
            const key = `${m.kind}:${m.mediaKey}`;
            const lib = m.library || {};
            const isGuide = lib.guide === true;
            const busy = busyKey === key;
            return (
              <li key={key} data-testid="library-row" className="space-y-1 rounded bg-port-card p-2 text-xs">
                <div className="flex items-center gap-1">
                  {m.kind === 'portrait' && <Star size={12} aria-label="Primary" />}
                  <span className="truncate" title={m.mediaKey}>{lib.variant?.label || m.caption || m.mediaKey}</span>
                  <span className="ml-auto text-gray-500">{m.kind}</span>
                </div>
                {!readOnly && (
                  <div className="flex flex-wrap items-center gap-1">
                    <input aria-label={`Age for ${m.mediaKey}`} type="number" min="0" max="150" defaultValue={lib.variant?.age ?? ''} className="w-14 bg-port-bg"
                      onBlur={(e) => {
                        const age = e.target.value === '' ? undefined : Number(e.target.value);
                        if (age !== lib.variant?.age) save(m, { variant: { ...(lib.variant || {}), age } });
                      }} />
                    <select aria-label={`Era for ${m.mediaKey}`} value={lib.variant?.era || ''} className="bg-port-bg"
                      onChange={(e) => save(m, { variant: { ...(lib.variant || {}), era: e.target.value || undefined } })}>
                      <option value="">era</option>
                      {ERAS.map((era) => <option key={era} value={era}>{era}</option>)}
                    </select>
                    <input aria-label={`Tags for ${m.mediaKey}`} defaultValue={(lib.tags || []).join(', ')} placeholder="tags" className="w-24 bg-port-bg"
                      onBlur={(e) => {
                        const next = e.target.value.split(',').map((t) => t.trim()).filter(Boolean);
                        if (next.join(',') !== (lib.tags || []).join(',')) save(m, { tags: next });
                      }} />
                    {m.kind !== 'video' && (
                      <button type="button" disabled={busy || (!isGuide && guideCount >= MAX_CAST_GUIDES)} aria-pressed={isGuide}
                        title={!isGuide && guideCount >= MAX_CAST_GUIDES ? `At most ${MAX_CAST_GUIDES} render guides` : 'Use as a render guide'}
                        onClick={() => save(m, { guide: !isGuide })} className="flex items-center gap-1">
                        <Compass size={12} /> {isGuide ? 'Guide' : 'Make guide'}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input aria-label="Mood board id" value={boardId} onChange={(e) => setBoardId(e.target.value)} placeholder="mood board id" className="bg-port-bg" />
          <input aria-label="Mood board item ids" value={itemIds} onChange={(e) => setItemIds(e.target.value)} placeholder="item ids (comma separated)" className="min-w-[12rem] flex-1 bg-port-bg" />
          <button type="button" onClick={importBoard}>Add from mood board</button>
        </div>
      )}
    </section>
  );
}
