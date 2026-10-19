/**
 * CreativeLibrary — the Casting, Environments and Objects pages.
 *
 * One component, three kinds: each page is a type-scoped view over the
 * catalog's character / place / object ingredients (see lib/creativeLibraries).
 * The catalog row is the single record; universes, music videos and other
 * projects link to it. Filters live in the URL so a filtered view is shareable.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Drama, Mountain, Package, Plus, Search, Loader2, Sparkles, Library, Import } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import MediaImage from '../components/MediaImage';
import InfiniteScrollFooter from '../components/ui/InfiniteScrollFooter';
import toast from '../components/ui/Toast';
import { listCatalogIngredients, getCatalogFacets, createCatalogIngredient } from '../services/apiCatalog';
import { useCatalogTypes } from '../hooks/useCatalogTypes.jsx';
import { usePagedCollection } from '../hooks/usePagedCollection';
import useUrlParams from '../hooks/useUrlParams';
import useCancelableDebounce from '../hooks/useCancelableDebounce';
import { libraryById, ingredientPath, ingredientCoverUrl, usageSummary } from '../lib/creativeLibraries';
import { formatCount } from '../utils/formatters';

const PAGE_SIZE = 48;
const LIBRARY_ICONS = { casting: Drama, environments: Mountain, objects: Package };
const UNLINKED = '__unlinked';

function LibraryTile({ ingredient }) {
  const name = ingredient.name || '(untitled)';
  const cover = ingredientCoverUrl(ingredient);
  const usage = usageSummary(ingredient.usage);
  return (
    <li className="min-w-0">
      <Link
        to={ingredientPath(ingredient)}
        className="group flex flex-col h-full bg-port-card border border-port-border rounded-lg overflow-hidden hover:border-port-accent/60"
      >
        <div className="aspect-[3/4] w-full bg-port-bg flex items-center justify-center overflow-hidden">
          {cover ? (
            <MediaImage src={cover} alt={name} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <Sparkles size={22} className="text-gray-600" aria-hidden="true" />
          )}
        </div>
        <span className="flex flex-col gap-0.5 px-2.5 py-2 min-w-0">
          <span className="text-sm text-white font-medium truncate">{name}</span>
          <span className="text-[11px] text-gray-500 truncate">{usage || 'Not used yet'}</span>
        </span>
      </Link>
    </li>
  );
}

export default function CreativeLibrary({ libraryId }) {
  const library = libraryById(libraryId);
  const navigate = useNavigate();
  const { getType } = useCatalogTypes();
  const typeMeta = getType(library.type);
  const Icon = LIBRARY_ICONS[library.id] || Library;

  const [searchParams, updateParams] = useUrlParams();
  const scope = searchParams.get('scope') || '';
  const urlQ = searchParams.get('q') || '';
  const [searchInput, setSearchInput] = useState(urlQ);
  const [scheduleQMirror] = useCancelableDebounce();
  useEffect(() => {
    scheduleQMirror(() => updateParams({ q: searchInput.trim() }, { replace: true }), 300);
  }, [searchInput, updateParams, scheduleQMirror]);

  const [facets, setFacets] = useState(null);
  useEffect(() => {
    let active = true;
    getCatalogFacets({ silent: true }).then((f) => { if (active) setFacets(f || null); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const totalForType = facets?.types?.find((t) => t.type === library.type)?.count;

  const fetchPage = useCallback(async ({ cursor, signal }) => {
    const offset = cursor || 0;
    const filter = scope === UNLINKED ? { unlinked: true } : scope ? { refKind: 'universe', refId: scope } : {};
    const data = await listCatalogIngredients({ type: library.type, q: urlQ, ...filter, limit: PAGE_SIZE, offset, signal, silent: true });
    const items = Array.isArray(data?.items) ? data.items : [];
    return { items, nextCursor: items.length === PAGE_SIZE ? offset + items.length : null };
  }, [library.type, urlQ, scope]);
  const page = usePagedCollection(fetchPage);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', content: '' });
  const [creating, setCreating] = useState(false);
  const contentKey = typeMeta?.primaryContentKey || 'description';

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    const content = form.content.trim();
    setCreating(true);
    const created = await createCatalogIngredient(
      { type: library.type, name, payload: content ? { [contentKey]: content } : {}, tags: [] },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || `Failed to create ${library.singular}`); return null; });
    setCreating(false);
    if (!created) return;
    navigate(ingredientPath(created));
  };

  const universes = useMemo(() => facets?.universes || [], [facets]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        icon={Icon}
        title={(
          <span className="inline-flex items-baseline gap-2">
            {library.label}
            {totalForType != null && (
              <span className="text-sm font-normal text-gray-500 whitespace-nowrap">{formatCount(totalForType)}</span>
            )}
          </span>
        )}
        actions={(
          <div className="flex items-center gap-2">
            <Link
              to="/casting/import"
              aria-label="Import from music videos"
              title="Import from music videos"
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-gray-300 hover:text-white text-sm"
            >
              <Import size={16} aria-hidden="true" /> <span className="hidden sm:inline">From videos</span>
            </Link>
            <Link
              to={`/catalog?type=${encodeURIComponent(library.type)}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-gray-300 hover:text-white text-sm"
            >
              <Library size={16} aria-hidden="true" /> Catalog
            </Link>
            <button
              type="button"
              onClick={() => setShowForm((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
            >
              <Plus size={16} aria-hidden="true" /> New
            </button>
          </div>
        )}
      />
      <div className="flex-1 min-h-0 overflow-auto p-3 sm:p-4 flex flex-col gap-3">
        {showForm && (
          <form onSubmit={handleCreate} className="p-3 bg-port-card border border-port-border rounded-lg flex flex-col gap-3">
            <div>
              <label htmlFor="library-new-name" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Name</label>
              <input
                id="library-new-name"
                type="text"
                value={form.name}
                maxLength={200}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
            <div>
              <label htmlFor="library-new-content" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                {typeMeta?.primaryContentLabel || 'Description'} <span className="normal-case">(optional)</span>
              </label>
              <textarea
                id="library-new-content"
                rows={3}
                value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="px-3 py-2 min-h-[40px] rounded-lg text-gray-400 hover:text-white text-sm">Cancel</button>
              <button
                type="submit"
                disabled={creating || !form.name.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
              >
                {creating && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Create
              </button>
            </div>
          </form>
        )}

        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <label htmlFor="library-search" className="sr-only">Search {library.label}</label>
          <input
            id="library-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name or description"
            className="w-full pl-9 pr-3 py-2 bg-port-card border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
          />
        </div>

        <div className="flex items-center gap-2 -mx-3 px-3 overflow-x-auto scrollbar-hide touch-pan-x sm:mx-0 sm:px-0 sm:flex-wrap" role="group" aria-label="Filter">
          {[{ id: '', label: 'All' }, ...universes.map((u) => ({ id: u.refId, label: u.name })), { id: UNLINKED, label: 'Not in a universe' }].map((chip) => (
            <button
              key={chip.id || 'all'}
              type="button"
              aria-pressed={scope === chip.id}
              onClick={() => updateParams({ scope: chip.id })}
              className={`shrink-0 whitespace-nowrap text-xs px-3 py-2 sm:py-1.5 rounded-full border ${
                scope === chip.id ? 'bg-port-accent border-port-accent text-white' : 'border-port-border text-gray-300 hover:text-white'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {page.loaded && page.items.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-8 text-center text-sm text-gray-400">
            {urlQ || scope ? `No ${library.label.toLowerCase()} match this filter.` : library.empty}
          </div>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {page.items.map((it) => <LibraryTile key={it.id} ingredient={it} />)}
          </ul>
        )}
        <InfiniteScrollFooter hasMore={page.hasMore} loading={page.loading} error={page.error} onLoadMore={page.loadMore} />
      </div>
    </div>
  );
}
