import { useId, useMemo, useState } from 'react';
import { Compass, Star } from 'lucide-react';
import CatalogMediaTile from './CatalogMediaTile';
import CatalogReferenceReview from './CatalogReferenceReview';
import { rejectedReferenceKeys } from '../../../../server/lib/catalogMediaLibrary.js';
import { formatCount } from '../../utils/formatters';
import { updateCatalogIngredientMediaLibrary, attachCatalogIngredientMediaFromMoodBoard } from '../../services/apiCatalog';

export const MAX_CAST_GUIDES = 4;
const ERAS = ['child', 'teen', 'adult', 'elder'];
const LIBRARY_KINDS = new Set(['portrait', 'reference', 'video']);
const eraFor = (m) => m.library?.variant?.era
  || (Number.isInteger(m.library?.variant?.age) ? (m.library.variant.age < 13 ? 'child' : m.library.variant.age < 20 ? 'teen' : m.library.variant.age < 65 ? 'adult' : 'elder') : '');

export default function CatalogReferenceLibrary({ ingredientId, media = [], forms = [], readOnly = false, onChanged, onMediaUpdated, referenceMedia = media, missingMedia = new Set(), onSetPortrait, onDetach, revision, blockedReason }) {
  const id = useId();
  const [armedDetach, setArmedDetach] = useState(null);
  const [filter, setFilter] = useState({ form: '', age: '', era: '', tag: '', review: '', guides: false, allMedia: false });
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [boardId, setBoardId] = useState('');
  const [itemIds, setItemIds] = useState('');
  const previewRevision = useMemo(() => JSON.stringify({ revision, forms,
    media: media.map(m => [m.ingredientId, m.kind, m.mediaKey, m.deleted, m.updatedAt, m.library]) }), [revision, forms, media]);

  const rows = useMemo(() => media.filter((m) => !m.deleted && LIBRARY_KINDS.has(m.kind)), [media]);
  // Sheets and looks in other tabs still consume the character-wide guide limit.
  const rejected = rejectedReferenceKeys(media);
  const guideCount = media.filter((m) => !m.deleted && !rejected.has(m.mediaKey) && LIBRARY_KINDS.has(m.kind) && m.library?.guide === true).length;
  const ages = [...new Set(rows.map((m) => m.library?.variant?.age).filter(Number.isInteger))].sort((a, b) => a - b);
  const tags = [...new Set(rows.flatMap((m) => m.library?.tags || []))].sort();
  const formKey = (m) => m.library?.variant?.formId || 'canonical';
  const referenceKeys = new Set(referenceMedia.map((m) => `${m.kind}:${m.mediaKey}`));
  const visible = rows.filter((m) => (filter.allMedia || referenceKeys.has(`${m.kind}:${m.mediaKey}`))
    && (!filter.form || formKey(m) === filter.form)
    && (filter.age === '' || m.library?.variant?.age === Number(filter.age))
    && (!filter.era || eraFor(m) === filter.era)
    && (!filter.tag || (m.library?.tags || []).includes(filter.tag))
    && (!filter.review || (m.library?.review?.status || 'unreviewed') === filter.review)
    && (!filter.guides || (m.library?.guide === true && !rejected.has(m.mediaKey))));

  // One visual can have both portrait and reference attachments with independent metadata.
  const groups = new Map();
  for (const m of visible) {
    const key = `${m.kind === 'video' ? 'video' : 'image'}:${m.mediaKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const save = async (m, patch) => {
    setError('');
    setBusyKey(`${m.kind}:${m.mediaKey}`);
    try {
      const updated = await updateCatalogIngredientMediaLibrary(ingredientId, { mediaKey: m.mediaKey, kind: m.kind, ...patch }, { silent: true });
      if (onMediaUpdated) onMediaUpdated(updated);
      else onChanged?.();
      return updated;
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
      await attachCatalogIngredientMediaFromMoodBoard(ingredientId, { boardId: boardId.trim(), itemIds: ids, inferAge: true }, { silent: true });
      setItemIds('');
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'Could not import from mood board');
    }
  };

  const fieldClass = 'min-h-11 min-w-0 w-full rounded border border-port-border bg-port-bg px-2 text-sm';

  return (
    <section aria-label="Reference library" className="min-w-0 space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <h3 className="font-semibold">Reference library</h3>
        <span data-testid="guide-count" className="text-gray-400">{formatCount(guideCount)}/{MAX_CAST_GUIDES} render guides (all media)</span>
      </header>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] items-end gap-2 text-xs">
        {referenceMedia !== media && (
          <label htmlFor={`${id}-scope`} className="min-w-0 space-y-1"><span>Media scope</span>
            <select id={`${id}-scope`} value={filter.allMedia ? 'all' : 'references'} onChange={(e) => setFilter({ ...filter, allMedia: e.target.value === 'all' })} className={fieldClass}>
              <option value="references">References</option>
              <option value="all">All character media</option>
            </select>
          </label>
        )}
        {forms.length > 0 && (
          <label htmlFor={`${id}-form`} className="min-w-0 space-y-1"><span>Age or look</span>
            <select id={`${id}-form`} aria-label="Filter by age or look" value={filter.form} onChange={(e) => setFilter({ ...filter, form: e.target.value })} className={fieldClass}>
              <option value="">All</option>
              <option value="canonical">Canonical</option>
              {forms.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
        )}
        <label htmlFor={`${id}-age`} className="min-w-0 space-y-1"><span>Age</span>
          <select id={`${id}-age`} aria-label="Filter by age" value={filter.age} onChange={(e) => setFilter({ ...filter, age: e.target.value })} className={fieldClass}>
            <option value="">All</option>
            {ages.map((age) => <option key={age} value={age}>{age}</option>)}
          </select>
        </label>
        <label htmlFor={`${id}-era`} className="min-w-0 space-y-1"><span>Era</span>
          <select id={`${id}-era`} aria-label="Filter by era" value={filter.era} onChange={(e) => setFilter({ ...filter, era: e.target.value })} className={fieldClass}>
            <option value="">All</option>
            {ERAS.map((era) => <option key={era} value={era}>{era}</option>)}
          </select>
        </label>
        {tags.length > 0 && (
          <label htmlFor={`${id}-tag`} className="min-w-0 space-y-1"><span>Tag</span>
            <select id={`${id}-tag`} aria-label="Filter by tag" value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })} className={fieldClass}>
              <option value="">All</option>
              {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
          </label>
        )}
        <label htmlFor={`${id}-guides`} className="flex min-h-11 items-center gap-2">
          <input id={`${id}-guides`} type="checkbox" checked={filter.guides} onChange={(e) => setFilter({ ...filter, guides: e.target.checked })} /> Guides only
        </label>
        <label htmlFor={`${id}-review`} className="min-w-0 space-y-1"><span>Rating</span>
          <select id={`${id}-review`} value={filter.review} onChange={event => setFilter({ ...filter, review: event.target.value })} className={fieldClass}>
            <option value="">All ratings</option>
            {['unreviewed', 'good', 'bad', 'rejected'].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
      {visible.length === 0 ? <p className="text-sm text-gray-400">{rows.length ? 'No references match. Change the filters to see more.' : 'No references yet. Add an image or video to start your library.'}</p> : (
        <ul className="grid items-start grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3">
          {[...groups].map(([groupKey, attachments]) => {
            const tile = attachments.find((m) => m.kind === 'portrait') || attachments[0];
            const tileEditable = !readOnly && !tile.readOnly;
            return (
              <li key={groupKey} data-testid="library-row" className="min-w-0 rounded-lg border border-port-border bg-port-bg">
                <CatalogMediaTile m={tile} missing={missingMedia.has(tile.mediaKey)} contain
                  isPortrait={tile.kind === 'portrait'} onSetPortrait={tileEditable ? onSetPortrait : undefined}
                  onDetach={tileEditable ? onDetach : undefined} armedDetach={armedDetach} onArmDetach={setArmedDetach} />
                {attachments.map((m) => {
                  const key = `${m.ingredientId || ingredientId}:${m.kind}:${m.mediaKey}`;
                  const lib = m.library || {};
                  const isGuide = lib.guide === true && !rejected.has(m.mediaKey);
                  const editable = !readOnly && !m.readOnly;
                  const title = lib.variant?.label || m.caption || m.mediaKey;
                  const summary = [forms.find((f) => f.id === lib.variant?.formId)?.label || 'Canonical',
                    Number.isInteger(lib.variant?.age) ? `Age ${lib.variant.age}` : '', eraFor(m), ...(lib.tags || [])].filter(Boolean).join(' · ');
                  return (
                    <div key={key} role="group" aria-label={`${m.kind} details for ${m.mediaKey}`} className="min-w-0 space-y-2 border-t border-port-border p-3">
                      <div className="flex min-w-0 items-start gap-2">
                        {m.kind === 'portrait' && <Star size={14} aria-label="Primary" className="mt-0.5 shrink-0 text-port-warning" />}
                        <h4 className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">{title}</h4>
                        <span className="shrink-0 text-xs text-gray-500">{m.kind}</span>
                      </div>
                      <p className="text-xs text-gray-400 [overflow-wrap:anywhere]">{summary}</p>
                      {m.kind !== 'video' && (editable ? (
                        <button type="button" disabled={!!busyKey || rejected.has(m.mediaKey) || (!isGuide && guideCount >= MAX_CAST_GUIDES)} aria-pressed={isGuide}
                          title={!isGuide && guideCount >= MAX_CAST_GUIDES ? `At most ${MAX_CAST_GUIDES} render guides` : 'Use as a render guide'}
                          onClick={() => save(m, { guide: !isGuide })}
                          className={`flex min-h-11 w-full items-center justify-center gap-2 rounded border px-3 text-sm disabled:opacity-40 ${isGuide ? 'border-port-accent bg-port-accent/10 text-port-accent' : 'border-port-border text-gray-300 hover:border-port-accent'}`}>
                          <Compass size={16} aria-hidden="true" /> {busyKey === `${m.kind}:${m.mediaKey}` ? 'Saving…' : isGuide ? 'Guide' : 'Make guide'}
                        </button>
                      ) : isGuide && <p className="text-xs text-port-accent">Render guide</p>)}
                      {m.kind !== 'video' && <CatalogReferenceReview
                        ingredientId={ingredientId} media={m} readOnly={!editable} saving={!!busyKey}
                        onSave={patch => save(m, patch)} onChanged={onChanged} revision={previewRevision} blockedReason={blockedReason} />}
                      {editable && (
                        <details>
                          <summary className="flex min-h-11 cursor-pointer items-center text-xs text-port-accent">Edit reference details</summary>
                          <fieldset disabled={!!busyKey} className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-2 text-xs disabled:opacity-50">
                            {forms.length > 0 && (
                              <label htmlFor={`${id}-${key}-form`} className="min-w-0 space-y-1"><span>Age or look</span>
                                <select id={`${id}-${key}-form`} aria-label={`Age or look for ${m.mediaKey}`} value={lib.variant?.formId || ''} className={fieldClass}
                                  onChange={(e) => {
                                    const form = forms.find(f => f.id === e.target.value);
                                    const age = /^\d+$/.test(String(form?.age).trim()) ? Number(form.age) : undefined;
                                    save(m, { variant: { ...(lib.variant || {}), formId: e.target.value || undefined,
                                      ...(age !== undefined ? { age, era: undefined } : {}) } });
                                  }}>
                                  <option value="">Canonical</option>
                                  {forms.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                                </select>
                              </label>
                            )}
                            <label htmlFor={`${id}-${key}-age`} className="min-w-0 space-y-1"><span>Age</span>
                              <input key={lib.variant?.age ?? ''} id={`${id}-${key}-age`} aria-label={`Age for ${m.mediaKey}`} type="number" min="0" max="150" defaultValue={lib.variant?.age ?? ''} className={fieldClass}
                                onBlur={(e) => {
                                  if (!e.target.validity.valid) return;
                                  const age = e.target.value === '' ? undefined : Number(e.target.value);
                                  if (age !== lib.variant?.age) save(m, { variant: { ...(lib.variant || {}), age } });
                                }} />
                            </label>
                            <label htmlFor={`${id}-${key}-era`} className="min-w-0 space-y-1"><span>Era</span>
                              <select id={`${id}-${key}-era`} aria-label={`Era for ${m.mediaKey}`} value={lib.variant?.era || ''} className={fieldClass}
                                onChange={(e) => save(m, { variant: { ...(lib.variant || {}), era: e.target.value || undefined } })}>
                                <option value="">From age</option>
                                {ERAS.map((era) => <option key={era} value={era}>{era}</option>)}
                              </select>
                            </label>
                            <label htmlFor={`${id}-${key}-tags`} className="col-span-full min-w-0 space-y-1"><span>Tags (comma separated)</span>
                              <input key={(lib.tags || []).join(',')} id={`${id}-${key}-tags`} aria-label={`Tags for ${m.mediaKey}`} defaultValue={(lib.tags || []).join(', ')} placeholder="e.g. studio, winter" className={fieldClass}
                                onBlur={(e) => {
                                  const next = e.target.value.split(',').map((tag) => tag.trim()).filter(Boolean);
                                  if (next.join(',') !== (lib.tags || []).join(',')) save(m, { tags: next });
                                }} />
                            </label>
                          </fieldset>
                        </details>
                      )}
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ul>
      )}
      {!readOnly && (
        <details className="rounded border border-port-border p-3 text-xs">
          <summary className="min-h-11 cursor-pointer content-center text-gray-400">Add from mood board</summary>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] items-end gap-2">
            <label htmlFor={`${id}-board`} className="min-w-0 space-y-1"><span>Mood board id</span>
              <input id={`${id}-board`} value={boardId} onChange={(e) => setBoardId(e.target.value)} className={fieldClass} />
            </label>
            <label htmlFor={`${id}-items`} className="min-w-0 space-y-1"><span>Mood board item ids</span>
              <input id={`${id}-items`} value={itemIds} onChange={(e) => setItemIds(e.target.value)} placeholder="Comma separated" className={fieldClass} />
            </label>
            <button type="button" onClick={importBoard} className="min-h-11 rounded border border-port-border px-3 text-port-accent">Add from mood board</button>
          </div>
        </details>
      )}
    </section>
  );
}
