/**
 * Catalog page — index of Creative Ingredients.
 *
 * Lists every ingredient (character/place/object/idea/scene/concept) the user
 * has captured into the catalog. Type chips + Universe/Series/Tag dropdowns
 * filter the set (#1762); all filter state lives in the URL (`?type=&universe=
 * &series=&tag=&q=&view=`) so a filtered catalog is shareable + back-button-
 * safe. The flat Grid view paginates past the old 200-item cap with "Load more";
 * the Albums view groups ingredients by universe with pinned "Unsorted / Raw"
 * and "Orphaned" albums. The "+ New" inline form mirrors the Pipeline
 * series-create pattern; "Ingest" links to the paste-and-extract page. Delete
 * uses an armed two-click confirm (no window.confirm); the multi-select action
 * bar can Remix the selection into Story Builder or place it into a
 * universe/series.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Sparkles, Plus, Search, FileInput, Loader2, RefreshCw, Wand2, X, LayoutGrid, Library, FolderPlus } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listCatalogIngredients,
  createCatalogIngredient,
  deleteCatalogIngredient,
  linkCatalogIngredient,
  getCatalogStats,
  getCatalogFacets,
  rerunCatalogMigration,
} from '../services/apiCatalog';
import CatalogCard from '../components/catalog/CatalogCard';
import CatalogAlbum from '../components/catalog/CatalogAlbum';
import { catalogRefRoleForType } from '../lib/catalogTypes';
import { useCatalogTypes } from '../hooks/useCatalogTypes.jsx';

// All type-derived UI (chips, badge color, inline-form primary content
// key/label, snippet fallback) flows from the merged registry (system +
// user-defined). The static built-ins are the synchronous fallback inside the
// hook, so adding a type — built-in or user — surfaces here automatically.

// Page size for the flat grid's "Load more" pagination. 60 keeps the first
// paint light while still filling a 3-column grid several rows deep; the old
// fixed `limit: 200` silently truncated installs with more ingredients.
const PAGE_SIZE = 60;

// Remix targets — destinations the user can hand a multi-selected set of
// ingredients off to. Today there's only Story Builder; the array shape keeps a
// second target a one-line addition. The handoff state is intentionally generic
// (`remix.ingredientIds`), NOT story-builder-specific, so a new destination just
// reads the same key. Each target's `to` is the route to navigate to.
const REMIX_TARGETS = [
  { id: 'story-builder', label: 'Story Builder', to: '/story-builder' },
];

export default function Catalog() {
  const navigate = useNavigate();
  // Merged type registry (system + user-defined). `types` drives the filter
  // chips + the New-form dropdown; `getType` resolves badge/primary-content.
  const { types: TYPES, getType } = useCatalogTypes();

  // ── URL-synced filter state (linkable routes per CLAUDE.md) ────────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedType = searchParams.get('type') || '';
  const selectedUniverse = searchParams.get('universe') || '';
  const selectedSeries = searchParams.get('series') || '';
  const selectedTag = searchParams.get('tag') || '';
  const view = searchParams.get('view') === 'albums' ? 'albums' : 'grid';

  // Merge a patch into the URL search params, dropping keys set to '' so a
  // cleared filter leaves the URL clean. `replace` avoids history spam while
  // typing; discrete clicks push so Back returns to the prior filter.
  const updateParams = useCallback((patch, { replace = false } = {}) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace });
  }, [setSearchParams]);

  // Two-stage search: `searchInput` is what the user is typing; `q` is the
  // debounced value that drives the list fetch (and is mirrored to the URL).
  // Seeded from the URL once so a shared/reloaded `?q=` link restores the box.
  const [searchInput, setSearchInput] = useState(() => searchParams.get('q') || '');
  const [q, setQ] = useState(() => searchParams.get('q') || '');

  const [stats, setStats] = useState(null);
  const [facets, setFacets] = useState(null);

  // Grid pagination state.
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Bump after a mutation (delete/add-to-ref/create/sync) to force the lazy
  // albums to remount and re-fetch their membership. The grid mutates its own
  // state optimistically, so it is NOT keyed on this.
  const [dataVersion, setDataVersion] = useState(0);

  // Multi-select. `selectedIds` is the membership Set (drives the action-bar
  // count + card highlight); `selectedItems` keeps the full ingredient objects
  // so the "Add to universe/series" action can derive each one's ref role
  // without a re-fetch (selection can span grid + albums).
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedItems, setSelectedItems] = useState(() => new Map());
  const [remixMenuOpen, setRemixMenuOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // Inline create form.
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ type: 'character', name: '', content: '' });
  const [creating, setCreating] = useState(false);
  // Armed-row id for two-click delete (no window.confirm).
  const [armedId, setArmedId] = useState(null);
  // "Sync from Universes" — re-runs the bible→catalog backfill.
  const [syncing, setSyncing] = useState(false);

  // Debounce typing → q, and mirror q to the URL (replace, to avoid history
  // spam). The fetch keys on the local `q`; the URL copy is for shareability.
  useEffect(() => {
    const t = setTimeout(() => {
      const trimmed = searchInput.trim();
      setQ(trimmed);
      updateParams({ q: trimmed }, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, updateParams]);

  const loadStats = useCallback(() => {
    getCatalogStats({ silent: true })
      .then((s) => setStats(s || null))
      .catch(() => {});
  }, []);

  const loadFacets = useCallback(() => {
    getCatalogFacets({ silent: true })
      .then((f) => setFacets(f || null))
      .catch(() => {});
  }, []);

  // Build the list-query params from the active filters. The server accepts a
  // single ref filter, so series (more specific) wins over universe; type/tag/q
  // compose with it.
  const buildListParams = useCallback(() => {
    const p = {};
    if (selectedType) p.type = selectedType;
    if (selectedTag) p.tag = selectedTag;
    if (q) p.q = q;
    if (selectedSeries) { p.refKind = 'series'; p.refId = selectedSeries; }
    else if (selectedUniverse) { p.refKind = 'universe'; p.refId = selectedUniverse; }
    return p;
  }, [selectedType, selectedTag, q, selectedSeries, selectedUniverse]);

  // Fetch page 1 for the grid, replacing the list. Used by the filter-change
  // effect and by the post-sync reload.
  const loadFirstPage = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    listCatalogIngredients({ ...buildListParams(), limit: PAGE_SIZE, offset: 0, silent: true })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.items) ? data.items : [];
        setItems(list);
        setHasMore(list.length === PAGE_SIZE);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err?.message || 'Failed to load catalog');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [buildListParams]);

  // Grid view: (re)load page 1 whenever the filters change. Albums manage their
  // own lazy loads, so skip the grid fetch entirely in that view.
  useEffect(() => {
    if (view !== 'grid') return undefined;
    return loadFirstPage();
  }, [view, loadFirstPage]);

  useEffect(() => loadStats(), [loadStats]);
  useEffect(() => loadFacets(), [loadFacets]);

  const loadMore = () => {
    setLoadingMore(true);
    listCatalogIngredients({ ...buildListParams(), limit: PAGE_SIZE, offset: items.length, silent: true })
      .then((data) => {
        const list = Array.isArray(data?.items) ? data.items : [];
        setItems((prev) => [...prev, ...list]);
        setHasMore(list.length === PAGE_SIZE);
        setLoadingMore(false);
      })
      .catch((err) => {
        toast.error(err?.message || 'Failed to load more');
        setLoadingMore(false);
      });
  };

  const totalCount = stats?.total ?? items.length;
  const countForType = (id) => stats?.byType?.[id] || 0;

  // The honest "of N" for the grid count line. We can answer it cheaply from
  // /facets only for the single-filter cases; for combined filters or a search
  // query we don't know the total without a count round-trip, so we show just
  // "Showing X" (with a trailing + when more pages remain).
  const knownTotal = useMemo(() => {
    if (!facets) return null;
    const active = [
      selectedType && 'type', selectedUniverse && 'universe',
      selectedSeries && 'series', selectedTag && 'tag', q && 'q',
    ].filter(Boolean);
    if (active.length === 0) return facets.total;
    if (active.length > 1) return null;
    const only = active[0];
    if (only === 'type') return facets.types.find((t) => t.type === selectedType)?.count ?? null;
    if (only === 'series') return facets.series.find((s) => s.refId === selectedSeries)?.count ?? null;
    if (only === 'universe') return facets.universes.find((u) => u.refId === selectedUniverse)?.count ?? null;
    if (only === 'tag') return facets.tags.find((t) => t.tag === selectedTag)?.count ?? null;
    return null;
  }, [facets, selectedType, selectedUniverse, selectedSeries, selectedTag, q]);

  // Series options scoped to the chosen universe (decision #1: the series
  // dropdown narrows within the selected universe). With no universe chosen,
  // show all series and rely on the universe sublabel for disambiguation.
  const seriesOptions = useMemo(() => {
    const all = facets?.series || [];
    if (!selectedUniverse) return all;
    return all.filter((s) => s.universeId === selectedUniverse);
  }, [facets, selectedUniverse]);

  const hasActiveFilters = !!(selectedType || selectedUniverse || selectedSeries || selectedTag || q);

  const clearFilters = () => {
    setSearchInput('');
    setQ('');
    updateParams({ type: '', universe: '', series: '', tag: '', q: '' });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    const content = form.content.trim();
    const payload = {};
    if (content) {
      payload[getType(form.type)?.primaryContentKey || 'description'] = content;
    }
    setCreating(true);
    const created = await createCatalogIngredient({
      type: form.type,
      name,
      payload,
      tags: [],
    }, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Failed to create ingredient');
      return null;
    });
    setCreating(false);
    if (!created) return;
    toast.success(`Created ${form.type} "${name}"`);
    closeForm();
    // Only prepend optimistically if the new row would actually pass the
    // current filter — otherwise it appears in a filtered view it doesn't
    // match and lingers until the next refetch. A freshly-created ingredient is
    // unlinked, so it never belongs in a universe/series-filtered grid.
    const matchesType = !selectedType || created.type === selectedType;
    const matchesSearch = !q || (created.name || '').toLowerCase().includes(q.toLowerCase());
    const refFiltered = !!(selectedUniverse || selectedSeries);
    if (view === 'grid' && matchesType && matchesSearch && !refFiltered) {
      setItems((prev) => [created, ...prev]);
    }
    loadStats();
    loadFacets();
    setDataVersion((v) => v + 1);
  };

  // Drop an id from both selection structures (used on delete + after a bulk
  // place + on explicit clear).
  const dropSelection = (id) => {
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSelectedItems((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  // The API + side-effect half of a delete, shared by the grid and the albums.
  // Returns whether the delete succeeded so the caller can roll its own
  // optimistic list mutation back. Selection cleanup + stats/facets refresh and
  // the error toast live here so both call sites stay in sync.
  const deleteIngredientApi = async (it) => {
    const wasSelected = selectedIds.has(it.id);
    const wasItem = selectedItems.get(it.id);
    if (wasSelected) dropSelection(it.id);
    const ok = await deleteCatalogIngredient(it.id, { silent: true })
      .then(() => true)
      .catch((err) => {
        toast.error(err?.message || 'Delete failed');
        // The ingredient still exists — restore it to the selection.
        if (wasSelected) {
          setSelectedIds((prev) => (prev.has(it.id) ? prev : new Set(prev).add(it.id)));
          if (wasItem) setSelectedItems((prev) => (prev.has(it.id) ? prev : new Map(prev).set(it.id, wasItem)));
        }
        return false;
      });
    if (ok) {
      loadStats();
      loadFacets();
      setDataVersion((v) => v + 1);
    }
    return ok;
  };

  // Grid delete: optimistic removal from the visible list, restored in place if
  // the API call fails.
  const confirmDelete = async (it) => {
    setArmedId(null);
    const originalIdx = items.findIndex((x) => x.id === it.id);
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    const ok = await deleteIngredientApi(it);
    if (!ok) {
      setItems((prev) => {
        if (prev.some((x) => x.id === it.id)) return prev;
        const next = [...prev];
        next.splice(Math.max(0, originalIdx), 0, it);
        return next;
      });
    }
  };

  // Album delete: the album owns its own optimistic list, so it just needs the
  // success boolean from the shared API helper.
  const albumDelete = async (it) => {
    setArmedId(null);
    return deleteIngredientApi(it);
  };

  // Re-run the bible→catalog backfill to pull in canon entities not yet in the
  // catalog. `force: true` ignores the one-time marker; idempotent server-side.
  const handleSync = async () => {
    setSyncing(true);
    const result = await rerunCatalogMigration({ force: true, silent: true }).catch((err) => {
      toast.error(err?.message || 'Sync from universes failed');
      return null;
    });
    setSyncing(false);
    if (!result) return;
    const syncStats = result?.stats ?? result ?? {};
    const promoted = syncStats.promoted ?? 0;
    const errors = syncStats.errors ?? 0;
    if (errors > 0) {
      toast.error(
        `Sync hit ${errors} error${errors === 1 ? '' : 's'}` +
        `${promoted > 0 ? ` (${promoted} promoted)` : ''} — some canon items may still be missing`,
      );
    } else {
      toast.success(
        promoted > 0
          ? `Synced ${promoted} canon item${promoted === 1 ? '' : 's'} into the catalog`
          : 'Catalog already up to date with your universes',
      );
    }
    if (promoted > 0) {
      if (view === 'grid') loadFirstPage();
      loadStats();
      loadFacets();
      setDataVersion((v) => v + 1);
    }
  };

  // Single reset path used by Cancel + toolbar toggle + post-submit.
  const closeForm = () => {
    setForm((f) => ({ type: f.type, name: '', content: '' }));
    setShowForm(false);
  };

  // ── Multi-select ──────────────────────────────────────────────────────────
  const toggleSelect = (it) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(it.id)) next.delete(it.id);
      else next.add(it.id);
      return next;
    });
    setSelectedItems((prev) => {
      const next = new Map(prev);
      if (next.has(it.id)) next.delete(it.id);
      else next.set(it.id, it);
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectedItems(new Map());
    setRemixMenuOpen(false);
    setAddMenuOpen(false);
  };

  // Hand the selected ids off to the chosen remix target with a GENERIC state
  // key (`remix.ingredientIds`) so any future destination reads the same shape.
  const handleRemix = (target) => {
    const ingredientIds = [...selectedIds];
    if (ingredientIds.length === 0) return;
    setRemixMenuOpen(false);
    navigate(target.to, { state: { remix: { ingredientIds } } });
  };

  // Bulk "Add to universe/series" (Phase 5): link every selected ingredient to
  // the chosen ref, deriving each one's role from its type. Closes the
  // raw → placed loop without leaving the page.
  const handleAddToRef = async (refKind, refId, label) => {
    const list = [...selectedItems.values()];
    setAddMenuOpen(false);
    if (list.length === 0) return;
    let ok = 0;
    let fail = 0;
    await Promise.all(list.map((ing) =>
      linkCatalogIngredient(ing.id, { refKind, refId, role: catalogRefRoleForType(ing.type) }, { silent: true })
        .then(() => { ok += 1; })
        .catch(() => { fail += 1; }),
    ));
    if (ok > 0) toast.success(`Added ${ok} ingredient${ok === 1 ? '' : 's'} to ${label}`);
    if (fail > 0) toast.error(`Failed to add ${fail} ingredient${fail === 1 ? '' : 's'} to ${label}`);
    clearSelection();
    loadFacets();
    setDataVersion((v) => v + 1);
    // Placed items may no longer match a universe/series/unlinked-filtered grid.
    if (view === 'grid') loadFirstPage();
  };

  const refTargets = useMemo(() => {
    const universes = (facets?.universes || []).map((u) => ({ refKind: 'universe', refId: u.refId, label: u.name }));
    const series = (facets?.series || []).map((s) => ({ refKind: 'series', refId: s.refId, label: s.name }));
    return { universes, series };
  }, [facets]);
  const hasRefTargets = refTargets.universes.length > 0 || refTargets.series.length > 0;

  const cardProps = {
    getType,
    selectedIds,
    onToggleSelect: toggleSelect,
    armedId,
    onArm: setArmedId,
    onCancelArm: () => setArmedId(null),
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Sparkles className="w-6 h-6 text-port-accent" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-white">Catalog</h1>
          <span className="text-sm text-gray-500">
            {totalCount} ingredient{totalCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle (Grid ↔ Albums), persisted in the URL. */}
          <div className="inline-flex rounded-lg border border-port-border overflow-hidden" role="group" aria-label="Catalog view">
            <button
              type="button"
              onClick={() => updateParams({ view: '' })}
              aria-pressed={view === 'grid'}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium ${view === 'grid' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-300 hover:text-white'}`}
            >
              <LayoutGrid size={16} aria-hidden="true" /> Grid
            </button>
            <button
              type="button"
              onClick={() => updateParams({ view: 'albums' })}
              aria-pressed={view === 'albums'}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium ${view === 'albums' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-300 hover:text-white'}`}
            >
              <Library size={16} aria-hidden="true" /> Albums
            </button>
          </div>
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            title="Pull canon characters, places, and objects from your universes into the catalog"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-white text-sm font-medium disabled:opacity-50"
          >
            {syncing
              ? <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              : <RefreshCw size={16} aria-hidden="true" />}
            {syncing ? 'Syncing…' : 'Sync from Universes'}
          </button>
          <Link
            to="/catalog/ingest"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-white text-sm font-medium"
          >
            <FileInput size={16} aria-hidden="true" />
            Ingest
          </Link>
          <button
            type="button"
            onClick={() => (showForm ? closeForm() : setShowForm(true))}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
          >
            <Plus size={16} aria-hidden="true" />
            New
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          type="button"
          onClick={() => updateParams({ type: '' })}
          className={`text-xs px-3 py-1.5 rounded-full border ${
            selectedType === ''
              ? 'bg-port-accent border-port-accent text-white'
              : 'border-port-border text-gray-300 hover:text-white'
          }`}
        >
          All <span className="ml-1 text-[10px] opacity-70">{totalCount}</span>
        </button>
        {TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => updateParams({ type: selectedType === t.id ? '' : t.id })}
            className={`text-xs px-3 py-1.5 rounded-full border ${
              selectedType === t.id
                ? 'bg-port-accent border-port-accent text-white'
                : 'border-port-border text-gray-300 hover:text-white'
            }`}
          >
            {t.label} <span className="ml-1 text-[10px] opacity-70">{countForType(t.id)}</span>
          </button>
        ))}
      </div>

      {/* Universe / Series / Tag dropdowns + Clear filters. */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label htmlFor="catalog-filter-universe" className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Universe</label>
          <select
            id="catalog-filter-universe"
            value={selectedUniverse}
            // Changing universe clears a now-out-of-scope series selection.
            onChange={(e) => updateParams({ universe: e.target.value, series: '' })}
            className="px-3 py-2 bg-port-card border border-port-border rounded text-white text-sm min-w-[160px]"
          >
            <option value="">All universes</option>
            {(facets?.universes || []).map((u) => (
              <option key={u.refId} value={u.refId}>{u.name} ({u.count})</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="catalog-filter-series" className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Series</label>
          <select
            id="catalog-filter-series"
            value={selectedSeries}
            onChange={(e) => updateParams({ series: e.target.value })}
            className="px-3 py-2 bg-port-card border border-port-border rounded text-white text-sm min-w-[160px]"
          >
            <option value="">All series</option>
            {seriesOptions.map((s) => (
              <option key={s.refId} value={s.refId}>{s.name} ({s.count})</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="catalog-filter-tag" className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Tag</label>
          <select
            id="catalog-filter-tag"
            value={selectedTag}
            onChange={(e) => updateParams({ tag: e.target.value })}
            className="px-3 py-2 bg-port-card border border-port-border rounded text-white text-sm min-w-[140px]"
          >
            <option value="">All tags</option>
            {(facets?.tags || []).map((t) => (
              <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>
            ))}
          </select>
        </div>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-port-border text-gray-300 hover:text-white text-sm"
          >
            <X size={14} aria-hidden="true" /> Clear filters
          </button>
        )}
      </div>

      <div className="relative mb-6">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
        <label htmlFor="catalog-search" className="sr-only">Search catalog</label>
        <input
          id="catalog-search"
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name, tag, or text…"
          className="w-full pl-9 pr-3 py-2 bg-port-card border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
        />
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 p-4 bg-port-card border border-port-border rounded-lg space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-3">
            <div>
              <label htmlFor="catalog-new-type" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Type
              </label>
              <select
                id="catalog-new-type"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              >
                {TYPES.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="catalog-new-name" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Name
              </label>
              <input
                id="catalog-new-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Echo Saint"
                maxLength={200}
                autoFocus
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
          </div>
          <div>
            <label htmlFor="catalog-new-content" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              {getType(form.type)?.primaryContentLabel || 'Description'}
              <span className="normal-case text-gray-500"> (optional)</span>
            </label>
            <textarea
              id="catalog-new-content"
              rows={4}
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              placeholder="Capture the idea here — you can flesh it out in the editor."
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeForm}
              className="px-3 py-2 rounded-lg text-gray-400 hover:text-white text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !form.name.trim()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : null}
              Create
            </button>
          </div>
        </form>
      )}

      {view === 'albums' ? (
        <AlbumsView
          key={dataVersion}
          facets={facets}
          cardProps={cardProps}
          onConfirmDelete={albumDelete}
        />
      ) : loading ? (
        <div className="text-gray-500 text-sm">Loading catalog…</div>
      ) : items.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <p className="text-sm text-gray-400">
            {hasActiveFilters
              ? 'No ingredients match the current filter.'
              : 'Your catalog is empty. Paste a scrap on the Ingest page or create one manually.'}
          </p>
        </div>
      ) : (
        <>
          <div className="text-xs text-gray-500 mb-2">
            Showing {items.length}{hasMore ? '+' : ''}
            {knownTotal != null ? ` of ${knownTotal}` : ''}
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {items.map((it) => (
              <CatalogCard
                key={it.id}
                ingredient={it}
                getType={getType}
                selected={selectedIds.has(it.id)}
                onToggleSelect={toggleSelect}
                armed={armedId === it.id}
                onArm={setArmedId}
                onCancelArm={() => setArmedId(null)}
                onConfirmDelete={confirmDelete}
              />
            ))}
          </ul>
          {hasMore && (
            <div className="flex justify-center mt-4">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-white text-sm font-medium disabled:opacity-50"
              >
                {loadingMore ? <Loader2 size={14} className="animate-spin" /> : null}
                Load more
              </button>
            </div>
          )}
        </>
      )}

      {selectedIds.size > 0 && (
        <div className="sticky bottom-0 left-0 right-0 mt-4 -mx-4 md:-mx-6 px-4 md:px-6 py-3 bg-port-card/95 backdrop-blur border-t border-port-border flex items-center justify-between gap-3 flex-wrap z-20">
          <span className="text-sm text-white font-medium">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => { setRemixMenuOpen((o) => !o); setAddMenuOpen(false); }}
                aria-haspopup="menu"
                aria-expanded={remixMenuOpen}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
              >
                <Wand2 size={16} aria-hidden="true" />
                Remix into…
              </button>
              {remixMenuOpen && (
                <ul
                  role="menu"
                  className="absolute right-0 bottom-full mb-2 min-w-[180px] bg-port-card border border-port-border rounded-lg shadow-lg overflow-hidden"
                >
                  {REMIX_TARGETS.map((t) => (
                    <li key={t.id} role="none">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => handleRemix(t)}
                        className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-port-bg hover:text-white"
                      >
                        {t.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => { setAddMenuOpen((o) => !o); setRemixMenuOpen(false); }}
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                disabled={!hasRefTargets}
                title={hasRefTargets ? 'Place the selected ingredients into a universe or series' : 'No universes or series to place into yet'}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-white text-sm font-medium disabled:opacity-50"
              >
                <FolderPlus size={16} aria-hidden="true" />
                Add to universe/series…
              </button>
              {addMenuOpen && hasRefTargets && (
                <div
                  role="menu"
                  className="absolute right-0 bottom-full mb-2 min-w-[220px] max-h-72 overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-lg"
                >
                  {refTargets.universes.length > 0 && (
                    <>
                      <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-gray-500">Universes</p>
                      {refTargets.universes.map((t) => (
                        <button
                          key={`u-${t.refId}`}
                          type="button"
                          role="menuitem"
                          onClick={() => handleAddToRef(t.refKind, t.refId, t.label)}
                          className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-port-bg hover:text-white"
                        >
                          {t.label}
                        </button>
                      ))}
                    </>
                  )}
                  {refTargets.series.length > 0 && (
                    <>
                      <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-gray-500">Series</p>
                      {refTargets.series.map((t) => (
                        <button
                          key={`s-${t.refId}`}
                          type="button"
                          role="menuitem"
                          onClick={() => handleAddToRef(t.refKind, t.refId, t.label)}
                          className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-port-bg hover:text-white"
                        >
                          {t.label}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-port-border text-gray-300 hover:text-white text-sm"
            >
              <X size={16} aria-hidden="true" />
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Albums grouped view (decision #1: flat universe albums + Raw + Orphaned).
// Album headers show counts from /facets up front; each album lazy-loads its
// cards the first time it is expanded. Mounted under a `key={dataVersion}` so a
// mutation remounts it and the lazy loads re-run against fresh data.
function AlbumsView({ facets, cardProps, onConfirmDelete }) {
  if (!facets) {
    return <div className="text-gray-500 text-sm">Loading albums…</div>;
  }
  const { universes = [], unlinkedCount = 0, orphanedCount = 0 } = facets;
  const albumProps = { ...cardProps, onConfirmDelete };
  const noAlbums = universes.length === 0 && unlinkedCount === 0 && orphanedCount === 0;
  if (noAlbums) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
        <p className="text-sm text-gray-400">No albums yet — ingest or create ingredients to get started.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {unlinkedCount > 0 && (
        <CatalogAlbum
          title="Unsorted / Raw"
          subtitle="not yet placed in a universe or series"
          count={unlinkedCount}
          defaultExpanded
          loadItems={() => listCatalogIngredients({ unlinked: true, limit: 200, silent: true })
            .then((d) => (Array.isArray(d?.items) ? d.items : []))}
          {...albumProps}
        />
      )}
      {universes.map((u) => (
        <CatalogAlbum
          key={u.refId}
          title={u.name}
          count={u.count}
          loadItems={() => listCatalogIngredients({ refKind: 'universe', refId: u.refId, limit: 200, silent: true })
            .then((d) => (Array.isArray(d?.items) ? d.items : []))}
          {...albumProps}
        />
      ))}
      {orphanedCount > 0 && (
        <CatalogAlbum
          title="Orphaned"
          subtitle="linked to a deleted universe/series — re-home these"
          count={orphanedCount}
          loadItems={() => listCatalogIngredients({ orphaned: true, limit: 200, silent: true })
            .then((d) => (Array.isArray(d?.items) ? d.items : []))}
          {...albumProps}
        />
      )}
    </div>
  );
}
