/**
 * CreativeLibrary — the Casting, Environments and Objects pages.
 *
 * One component, three kinds: each page is a type-scoped view over the
 * catalog's character / place / object ingredients (see lib/creativeLibraries).
 * The catalog row is the single record; universes, music videos and other
 * projects link to it. Filters live in the URL so a filtered view is shareable:
 * `scope` is a universe (or the unlinked bucket) and `story` (`<kind>:<id>`)
 * narrows to one storyboard, music video or series within it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Drama, Mountain, Package, Plus, Search, Loader2, Sparkles, Library, Import, Clapperboard, Film, BookOpen, Wand2, UserPlus, ExternalLink } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import RouteTabsHeader from '../components/ui/RouteTabsHeader';
import MediaImage from '../components/MediaImage';
import CharacterCard from '../components/catalog/CharacterCard';
import CatalogImageAction from '../components/catalog/CatalogImageAction';
import StoryDraftDrawer from '../components/catalog/StoryDraftDrawer';
import CatalogFamilyPicker from '../components/catalog/CatalogFamilyPicker';
import { addFamilyItem, familyRelations, removeFamilyItem } from '../lib/catalogFamily';
import IngredientPicker from '../components/IngredientPicker';
import useCatalogCards from '../hooks/useCatalogCards';
import InfiniteScrollFooter from '../components/ui/InfiniteScrollFooter';
import toast from '../components/ui/Toast';
import { listCatalogIngredients, getCatalogFacets, createCatalogIngredient, listCatalogStories, joinCatalogStory } from '../services/apiCatalog';
import { listUniverseNames } from '../services/apiUniverseBuilder';
import { useCatalogTypes } from '../hooks/useCatalogTypes.jsx';
import { usePagedCollection } from '../hooks/usePagedCollection';
import useUrlParams from '../hooks/useUrlParams';
import useCancelableDebounce from '../hooks/useCancelableDebounce';
import { libraryById, ingredientPath, ingredientCoverUrl, usageSummary, CATALOG_NAV_TABS } from '../lib/creativeLibraries';
import { formatCount } from '../utils/formatters';
import { threadRefUrl } from '../lib/threadRefKinds';
import { VideoCastLinksDisclosure } from '../components/musicVideo/VideoCastLinks.jsx';

const PAGE_SIZE = 48;
const LIBRARY_ICONS = { casting: Drama, environments: Mountain, objects: Package };
const UNLINKED = '__unlinked';
const STORY_KINDS = {
  storyboard: { label: 'Storyboard', icon: Clapperboard },
  'music-video': { label: 'Music video', icon: Film },
  series: { label: 'Series', icon: BookOpen },
};
const storyKey = (story) => `${story.kind}:${story.id}`;

function parseStoryParam(value) {
  const at = value.indexOf(':');
  return at > 0 ? { kind: value.slice(0, at), id: value.slice(at + 1) } : null;
}

const sideItemClass = (active) => `w-full min-h-[36px] flex items-center gap-2 px-2.5 py-1.5 rounded text-left text-sm ${
  active ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-border/40 hover:text-white'}`;
const chipClass = (active) => `shrink-0 inline-flex items-center gap-1.5 whitespace-nowrap text-xs px-3 py-2 rounded-full border ${
  active ? 'bg-port-accent border-port-accent text-white' : 'border-port-border text-gray-300 hover:text-white'}`;

function StoryHeader({ story, library, onDraft, onAddExisting, onLinked }) {
  const kind = STORY_KINDS[story.kind] || STORY_KINDS.storyboard;
  const Icon = kind.icon;
  const url = threadRefUrl(story.kind, story.id);
  return (
    <section aria-label="Story" className="p-3 bg-port-card border border-port-border rounded-lg flex flex-wrap items-center gap-2">
      <Icon size={18} className="text-port-accent shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm text-white font-medium break-words">{story.name}</h2>
        <p className="text-[11px] text-gray-500">{kind.label} · {formatCount(story.count)} {story.count === 1 ? library.singular : library.label.toLowerCase()}</p>
      </div>
      {url && (
        <Link to={url} className="inline-flex items-center gap-1 min-h-[40px] px-2 text-xs text-port-accent hover:underline">
          Open <ExternalLink size={12} aria-hidden="true" />
        </Link>
      )}
      {story.joinable ? (
        <div className="flex gap-2 w-full sm:w-auto">
          <button type="button" onClick={onAddExisting} className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 min-h-[40px] rounded-lg border border-port-border text-sm text-gray-200 hover:text-white">
            <UserPlus size={15} aria-hidden="true" /> Add existing
          </button>
          <button type="button" onClick={onDraft} className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 min-h-[40px] rounded-lg bg-port-accent/20 border border-port-accent/50 text-sm text-white">
            <Wand2 size={15} aria-hidden="true" /> New from prompt
          </button>
        </div>
      ) : null}
      {story.kind === 'music-video' && (
        <VideoCastLinksDisclosure summary={`Link the video’s ${library.label.toLowerCase()} to the catalog`}
          summaryClassName="min-h-[40px] flex items-center cursor-pointer text-xs text-port-accent"
          projectId={story.id} type={library.type} onLinked={onLinked} idPrefix="story-cast" />
      )}
    </section>
  );
}

function LibraryTile({ ingredient }) {
  const [generatedCover, setGeneratedCover] = useState(null);
  const name = ingredient.name || '(untitled)';
  const persistedCover = ingredientCoverUrl(ingredient);
  // Bridge the stale list row only until an authoritative cover/revision arrives.
  const cover = generatedCover?.baseline === persistedCover && generatedCover?.revision === ingredient.updatedAt
    ? generatedCover.src : persistedCover;
  const usage = usageSummary(ingredient.usage);
  return (
    <li className="min-w-0 flex flex-col bg-port-card border border-port-border rounded-lg overflow-hidden hover:border-port-accent/60">
      <Link
        to={ingredientPath(ingredient)}
        className="group flex flex-col flex-1 min-w-0"
      >
        <div className="aspect-[3/4] w-full bg-port-bg flex items-center justify-center overflow-hidden">
          {cover ? (
            <MediaImage thumbnail src={cover} alt={name} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <Sparkles size={22} className="text-gray-600" aria-hidden="true" />
          )}
        </div>
        <span className="flex flex-col gap-0.5 px-2.5 py-2 min-w-0">
          <span className="text-sm text-white font-medium truncate">{name}</span>
          <span className="text-[11px] text-gray-400 break-words">{ingredient.owningUniverse ? `Universe: ${ingredient.owningUniverse.name}` : 'Ownership needs review'}</span>
          <span className="text-[11px] text-gray-500 truncate">{usage || 'Not used yet'}</span>
        </span>
      </Link>
      <div className="p-2 border-t border-port-border">
        <CatalogImageAction ingredient={ingredient} onCover={src => setGeneratedCover({ src, baseline: persistedCover, revision: ingredient.updatedAt })} />
      </div>
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
  const storyParam = parseStoryParam(searchParams.get('story') || '');
  const drafting = searchParams.get('create') === 'prompt';
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

  const [universeNames, setUniverseNames] = useState([]);
  useEffect(() => {
    let active = true;
    listUniverseNames({ silent: true }).then((data) => { if (active && Array.isArray(data)) setUniverseNames(data); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const [stories, setStories] = useState([]);
  const [storiesNonce, setStoriesNonce] = useState(0);
  useEffect(() => {
    let active = true;
    listCatalogStories(library.type, { silent: true })
      .then((data) => { if (active) setStories(Array.isArray(data?.stories) ? data.stories : []); })
      .catch(() => {});
    return () => { active = false; };
  }, [library.type, storiesNonce]);
  const scopeStories = useMemo(() => (scope && scope !== UNLINKED ? stories.filter((st) => st.universeIds.includes(scope)) : []), [stories, scope]);
  const story = storyParam
    ? stories.find((st) => st.kind === storyParam.kind && st.id === storyParam.id) || { ...storyParam, name: 'Story', count: 0, universeIds: [], joinable: false }
    : null;

  const fetchPage = useCallback(async ({ cursor, signal }) => {
    const offset = cursor || 0;
    const filter = storyParam ? { refKind: storyParam.kind, refId: storyParam.id }
      : scope === UNLINKED ? { unlinked: true } : scope ? { refKind: 'universe', refId: scope } : {};
    const data = await listCatalogIngredients({ type: library.type, q: urlQ, ...filter, limit: PAGE_SIZE, offset, signal, silent: true });
    const items = Array.isArray(data?.items) ? data.items : [];
    return { items, nextCursor: items.length === PAGE_SIZE ? offset + items.length : null };
  }, [library.type, urlQ, scope, storyParam?.kind, storyParam?.id]);
  const page = usePagedCollection(fetchPage);
  const cards = useCatalogCards(library.type === 'character' ? page.items.map(item => item.id) : [], { initial: page.items });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', content: '', universeId: '' });
  const [family, setFamily] = useState([]);
  const [ownerChoices, setOwnerChoices] = useState(null);
  const [ownerLoadError, setOwnerLoadError] = useState(false);
  useEffect(() => {
    if (!showForm) return;
    let active = true;
    listUniverseNames({ silent: true }).then((data) => {
      if (!Array.isArray(data)) throw new Error('Invalid universe names response');
      if (active) { setOwnerChoices(data); setOwnerLoadError(false); }
    }).catch(() => { if (active) setOwnerLoadError(true); });
    return () => { active = false; };
  }, [showForm]);
  const joinStory = story?.joinable && story.universeIds.includes(form.universeId) ? story : null;
  const openForm = () => {
    if (!showForm && !form.universeId && scope && scope !== UNLINKED) setForm((f) => ({ ...f, universeId: scope }));
    setShowForm(!showForm);
  };
  const [picking, setPicking] = useState(false);
  const refreshAfterJoin = () => {
    page.reload();
    setStoriesNonce((n) => n + 1);
  };
  const addExisting = async (picked) => {
    setPicking(false);
    const items = Array.isArray(picked) ? picked : [picked];
    let joined = 0;
    for (const item of items) {
      const ok = await joinCatalogStory(story.kind, story.id, item.id, { silent: true }).then(() => true)
        .catch((err) => { toast.error(`${item.name} could not join ${story.name}: ${err?.message || 'unknown error'}`); return false; });
      if (ok) joined++;
    }
    if (joined) toast.success(`${formatCount(joined)} joined ${story.name}`);
    refreshAfterJoin();
  };
  const [creating, setCreating] = useState(false);
  const contentKey = typeMeta?.primaryContentKey || 'description';

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name || !form.universeId) return;
    const content = form.content.trim();
    setCreating(true);
    const created = await createCatalogIngredient(
      { type: library.type, name, universeId: form.universeId, payload: content ? { [contentKey]: content } : {}, tags: [],
        ...(family.length ? { relations: familyRelations(family) } : {}) },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || `Failed to create ${library.singular}`); return null; });
    if (created && joinStory) {
      await joinCatalogStory(joinStory.kind, joinStory.id, created.id, { silent: true })
        .catch((err) => toast.error(`${name} was saved but could not join ${joinStory.name}: ${err?.message || 'unknown error'}`));
    }
    setCreating(false);
    if (!created) return;
    navigate(ingredientPath(created));
  };


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
            {library.id === 'casting' && (
              <Link
                to="/casting/import"
                aria-label="Import from music videos"
                title="Import from music videos"
                className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-gray-300 hover:text-white text-sm"
              >
                <Import size={16} aria-hidden="true" /> <span className="hidden sm:inline">From videos</span>
              </Link>
            )}
            <button
              type="button"
              onClick={() => updateParams({ create: 'prompt' })}
              aria-label="New from prompt"
              title="New from prompt"
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-gray-300 hover:text-white text-sm"
            >
              <Wand2 size={16} aria-hidden="true" /> <span className="hidden sm:inline">From prompt</span>
            </button>
            <button
              type="button"
              onClick={openForm}
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
            >
              <Plus size={16} aria-hidden="true" /> New
            </button>
          </div>
        )}
      />
      <div className="shrink-0">
        <RouteTabsHeader tabs={CATALOG_NAV_TABS} activeTab={library.id} ariaLabel="Catalog sections" />
      </div>
      <div className="flex-1 min-h-0 flex">
      <aside aria-label="Universes and stories" className="hidden lg:flex flex-col w-60 shrink-0 border-r border-port-border overflow-auto p-2 gap-0.5">
        <p className="px-2.5 pt-1 pb-1 text-[11px] uppercase tracking-wider text-gray-500">Universes</p>
        <button type="button" aria-pressed={!scope && !storyParam} onClick={() => updateParams({ scope: '', story: '' })} className={sideItemClass(!scope && !storyParam)}>
          <span className="truncate flex-1">All</span>
          {totalForType != null && <span className="text-[11px] text-gray-500 tabular-nums">{formatCount(totalForType)}</span>}
        </button>
        {universeNames.map((universe) => (
          <div key={universe.id}>
            <button type="button" aria-pressed={scope === universe.id && !storyParam} onClick={() => updateParams({ scope: universe.id, story: '' })}
              className={sideItemClass(scope === universe.id && !storyParam)}>
              <span className="truncate flex-1">{universe.name}</span>
            </button>
            {scope === universe.id && scopeStories.length > 0 && (
              <ul aria-label={`Stories in ${universe.name}`} className="ml-3 pl-2 border-l border-port-border my-0.5">
                {scopeStories.map((item) => {
                  const KindIcon = (STORY_KINDS[item.kind] || STORY_KINDS.storyboard).icon;
                  const active = storyParam?.kind === item.kind && storyParam?.id === item.id;
                  return (
                    <li key={storyKey(item)}>
                      <button type="button" aria-pressed={active} onClick={() => updateParams({ story: storyKey(item) })} className={sideItemClass(active)}
                        title={`${(STORY_KINDS[item.kind] || STORY_KINDS.storyboard).label}: ${item.name}`}>
                        <KindIcon size={13} className="shrink-0 text-gray-500" aria-hidden="true" />
                        <span className="truncate flex-1">{item.name}</span>
                        <span className="text-[11px] text-gray-500 tabular-nums">{formatCount(item.count)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
        <button type="button" aria-pressed={scope === UNLINKED} onClick={() => updateParams({ scope: UNLINKED, story: '' })} className={sideItemClass(scope === UNLINKED)}>
          <span className="truncate flex-1">Not in a universe</span>
        </button>
      </aside>
      <div className="flex-1 min-w-0 min-h-0 overflow-auto p-3 sm:p-4 flex flex-col gap-3">
        {showForm && (
          <form onSubmit={handleCreate} className="p-3 bg-port-card border border-port-border rounded-lg flex flex-col gap-3">
            <div className="max-w-sm">
              <label htmlFor="library-new-universe" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Owning universe &amp; style</label>
              <select id="library-new-universe" value={form.universeId} required onChange={(event) => setForm((previous) => ({ ...previous, universeId: event.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm">
                <option value="">Choose a universe…</option>
                {(ownerChoices || []).map((universe) => <option key={universe.id} value={universe.id}>{universe.name}</option>)}
              </select>
              {ownerLoadError && <p role="alert" className="text-xs text-port-error">Could not load universes. Close and reopen to retry.</p>}
              {ownerChoices?.length === 0 && <Link to="/universes/new" className="text-xs text-port-accent hover:underline">Create a universe</Link>}
              {joinStory && <p className="text-xs text-gray-400">Joins {joinStory.name}.</p>}
            </div>
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
            {library.type === 'character' && <CatalogFamilyPicker items={family} selfName={form.name}
              onAdd={(kind, record) => setFamily((list) => addFamilyItem(list, kind, record))}
              onRemove={(item) => setFamily((list) => removeFamilyItem(list, item))} />}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="px-3 py-2 min-h-[40px] rounded-lg text-gray-400 hover:text-white text-sm">Cancel</button>
              <button
                type="submit"
                disabled={creating || !form.name.trim() || !form.universeId}
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

        <div className="lg:hidden flex flex-col gap-2">
          <div className="flex items-center gap-2 -mx-3 px-3 overflow-x-auto scrollbar-hide touch-pan-x sm:mx-0 sm:px-0 sm:flex-wrap" role="group" aria-label="Filter by universe">
            {[{ id: '', name: 'All' }, ...universeNames, { id: UNLINKED, name: 'Not in a universe' }].map((chip) => (
              <button key={chip.id || 'all'} type="button" aria-pressed={scope === chip.id} onClick={() => updateParams({ scope: chip.id, story: '' })} className={chipClass(scope === chip.id)}>
                {chip.name}
              </button>
            ))}
          </div>
          {scopeStories.length > 0 && (
            <div className="flex items-center gap-2 -mx-3 px-3 overflow-x-auto scrollbar-hide touch-pan-x sm:mx-0 sm:px-0 sm:flex-wrap" role="group" aria-label="Filter by story">
              <button type="button" aria-pressed={!storyParam} onClick={() => updateParams({ story: '' })} className={chipClass(!storyParam)}>All stories</button>
              {scopeStories.map((item) => {
                const KindIcon = (STORY_KINDS[item.kind] || STORY_KINDS.storyboard).icon;
                const active = storyParam?.kind === item.kind && storyParam?.id === item.id;
                return (
                  <button key={storyKey(item)} type="button" aria-pressed={active} onClick={() => updateParams({ story: storyKey(item) })} className={chipClass(active)}>
                    <KindIcon size={12} aria-hidden="true" /> {item.name} <span className="tabular-nums opacity-70">{formatCount(item.count)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {story && <StoryHeader story={story} library={library} onDraft={() => updateParams({ create: 'prompt' })} onAddExisting={() => setPicking(true)} onLinked={refreshAfterJoin} />}

        {cards.error && <p role="alert" className="text-sm text-port-error">Could not refresh card context. <button type="button" onClick={cards.retry} className="underline">Retry cards</button></p>}
        {page.loaded && page.items.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-8 text-center text-sm text-gray-400">
            {story && !urlQ ? `No ${library.label.toLowerCase()} in ${story.name} yet.` : urlQ || scope ? `No ${library.label.toLowerCase()} match this filter.` : library.empty}
          </div>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {page.items.map((it) => library.type === 'character'
              ? <CharacterCard key={it.id} ingredient={cards.cards[it.id] || it} onUpdated={cards.update} unavailable={!!cards.error || cards.missing.includes(it.id)}
                to={`${ingredientPath(it)}?${new URLSearchParams({ returnTo: `${library.path}${searchParams.size ? `?${searchParams}` : ''}` })}`} />
              : <LibraryTile key={it.id} ingredient={it} />)}
          </ul>
        )}
        <InfiniteScrollFooter hasMore={page.hasMore} loading={page.loading} error={page.error} onLoadMore={page.loadMore} />
      </div>
      </div>
      <StoryDraftDrawer
        open={drafting}
        onClose={() => updateParams({ create: '' })}
        library={library}
        typeMeta={typeMeta}
        universes={universeNames}
        stories={stories}
        initialUniverseId={scope && scope !== UNLINKED ? scope : (story?.universeIds?.[0] || '')}
        initialStory={story}
        onSaved={() => { updateParams({ create: '' }); refreshAfterJoin(); }}
      />
      {story?.joinable && (
        <IngredientPicker open={picking} onClose={() => setPicking(false)} onSelect={addExisting} type={library.type} multi
          excludeIds={page.items.map((item) => item.id)} />
      )}
    </div>
  );
}
