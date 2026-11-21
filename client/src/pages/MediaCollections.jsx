import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus, FolderOpen, Inbox, Trash2, Image as ImageIcon, Film, Search, AlertTriangle } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import Banner from '../components/ui/Banner';
import CollapsibleListItem from '../components/ui/CollapsibleListItem';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import EmptyState from '../components/EmptyState';
import toast from '../components/ui/Toast';
import {
  listMediaCollections,
  autoOrganizeMediaCollections,
  createMediaCollection,
  joinMediaCollections,
  deleteMediaCollection,
  listGalleryCollectionSummaries,
} from '../services/apiImageVideo.js';
import { buildUnsortedCollection } from '../lib/unsorted';
import {
  applyCollectionView, splitCollectionName, collectionItemCount,
  COLLECTION_SORTS, DEFAULT_COLLECTION_SORT, normalizeCollectionSort,
} from '../lib/mediaCollectionList';
import { formatCount, middleTruncate } from '../utils/formatters';
import MediaImage from '../components/MediaImage';
import SyncBadge from '../components/sync/SyncBadge';
import { useSyncIntegrity, syncBadgeStatus } from '../hooks/useSyncIntegrity';
import useUrlParams from '../hooks/useUrlParams';
import useCancelableDebounce from '../hooks/useCancelableDebounce';
import { useConfirmDelete } from '../hooks/useConfirmDelete';

// Cap for the card title AFTER the auto-creator prefix moves to its badge.
// Middle-truncating at this length keeps the trailing date/qualifier — the only
// thing distinguishing sibling auto-generated names — visible, which a plain
// end-clip (`line-clamp`) always eats.
const TITLE_MAX_CHARS = 34;

export default function MediaCollections() {
  // Focus target for the empty state's call to action — the create form sits
  // above the list, so the button has to point back up at it.
  const nameInputRef = useRef(null);
  const navigate = useNavigate();
  const [searchParams, updateParams] = useUrlParams();
  // `null` = collections were never successfully fetched (initial state, or a
  // first-load failure); `[]` = the server really has none. Collapsing the two
  // is what let a failed fetch render the "No collections yet" onboarding copy
  // and hand every image/video in the library to the synthetic "Unsorted"
  // bucket, reading as "all my collections were deleted" (#6019).
  const [collections, setCollections] = useState(null);
  const [collectionsError, setCollectionsError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState(null);
  const [joinedName, setJoinedName] = useState('');
  const [joining, setJoining] = useState(false);
  const [keepOriginals, setKeepOriginals] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [removedId, setRemovedId] = useState(null);
  const { isConfirming, requestDelete, cancelDelete } = useConfirmDelete();
  const [summaries, setSummaries] = useState([]);
  // null is the ordinary browsing mode. Selection survives changes to the
  // search and sort, but only collections still present in the list can join.
  const selecting = selectedIds !== null;
  const selected = selecting ? collections?.filter((c) => selectedIds.has(c.id)) ?? [] : [];
  const deleting = deletingId !== null || removedId !== null;

  // Sync integrity — no peers prop (the page doesn't fetch peers itself),
  // so the hook fetches instances internally.
  const sync = useSyncIntegrity('mediaCollection');

  const refresh = async () => {
    setLoading(true);
    // The collections leg resolves to an array on success and to an
    // `{ error }` envelope on failure, so the failure survives `Promise.all`
    // as data instead of being flattened into an indistinguishable `[]`.
    // `silent: true` because this page owns the failure UI below — the shared
    // `request()` toast would fade and leave the banner as the only signal.
    const [cols, mediaSummaries] = await Promise.all([
      listMediaCollections({ silent: true }).then(
        (list) => (Array.isArray(list) ? list : []),
        (err) => ({ error: err?.message || 'The collections list could not be loaded.' }),
      ),
      listGalleryCollectionSummaries({ silent: true }).catch(() => null),
    ]);
    if (Array.isArray(cols)) {
      setCollections(cols);
      setCollectionsError(null);
    } else {
      // Deliberately leave `collections` alone: the sentinel on a first-load
      // failure, or the last good list on a refresh failure. Either way the
      // grid never claims the library is unfiled.
      setCollectionsError(cols.error);
    }
    if (mediaSummaries) setSummaries(mediaSummaries);
    else setCollectionsError('Could not load collection covers and counts.');
    setLoading(false);
  };
  useEffect(() => { refresh(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const created = await createMediaCollection({ name: trimmed }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to create');
      return null;
    });
    setCreating(false);
    if (created) {
      // Only extend a list we actually have — fabricating one from a single
      // record while the fetch is still failed would clear the sentinel and
      // resurrect the "everything is unsorted" lie.
      setCollections((prev) => (prev ? [...prev, created] : prev));
      setName('');
      toast.success(`Created "${created.name}"`);
      // Open the new collection instead of dropping the user back on the grid.
      // A new collection is always empty, so any filter state that hides
      // empties — or an active search it doesn't match — would swallow it and
      // make the create read as broken. Navigating is the one feedback that
      // holds regardless of the filter row, and an empty bucket exists to be
      // filled anyway.
      // Drop any pending query→URL mirror write first — it would otherwise be
      // free to fire after this navigation and clobber the detail route back
      // to the list route (#8187).
      cancelQueryMirror();
      navigate(`/media/collections/${encodeURIComponent(created.id)}`);
    }
  };

  const handleOrganize = async () => {
    cancelDelete();
    setOrganizing(true);
    try {
      const { added, updatedCollections, missingAssets, failedCollections } = await autoOrganizeMediaCollections({ silent: true });
      const summary = added
        ? `Added ${formatCount(added)} memberships across ${formatCount(updatedCollections)} collections.`
        : 'No new collection memberships found.';
      const missing = missingAssets ? ` ${formatCount(missingAssets)} unavailable assets skipped.` : '';
      if (failedCollections) toast.error(`${summary}${missing} ${formatCount(failedCollections)} collections could not be updated.`);
      else toast.success(summary + missing);
      await refresh();
    } catch (error) {
      toast.error(error.message || 'Could not auto-organize media.');
    } finally {
      setOrganizing(false);
    }
  };

  const handleDelete = async (collection) => {
    setDeletingId(collection.id);
    const deleted = await deleteMediaCollection(collection.id, { silent: true }).then(() => true).catch((err) => {
      toast.error(err.message || 'Delete failed');
      return false;
    });
    if (!deleted) {
      setDeletingId(null);
      refresh();
      return;
    }
    setRemovedId(collection.id);
    cancelDelete();
    // Removing the last membership makes its media Unsorted. Counts and covers
    // are server-owned now, so update that projection after the delete commits.
    const nextSummaries = await listGalleryCollectionSummaries({ silent: true }).catch(() => null);
    if (nextSummaries) setSummaries(nextSummaries);
    else toast.error('Collection deleted. Could not refresh covers and counts.');
    setDeletingId(null);
  };

  const finishDelete = useCallback((id) => {
    setCollections((prev) => prev?.filter((c) => c.id !== id) ?? prev);
    setRemovedId(null);
  }, []);

  const toggleSelection = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleJoin = async (e) => {
    e.preventDefault();
    if (joining || selected.length < 2 || !joinedName.trim()) return;
    setJoining(true);
    try {
      const { removedCollectionIds = [], keptCollectionIds = [], ...joined } = await joinMediaCollections({
        name: joinedName.trim(),
        collectionIds: selected.map((c) => c.id),
        keepOriginals,
      }, { silent: true });
      const removed = new Set(removedCollectionIds);
      setCollections((prev) => prev
        ? [...prev.filter((c) => c.id !== joined.id && !removed.has(c.id)), joined]
        : prev);
      setSelectedIds(null);
      setJoinedName('');
      const retired = removed.size ? `; merged and removed ${formatCount(removed.size)} original${removed.size === 1 ? '' : 's'}` : '';
      const kept = !keepOriginals && keptCollectionIds.length
        ? `; kept ${formatCount(keptCollectionIds.length)} owned by a project or board` : '';
      toast.success(`Joined into "${joined.name}"${retired}${kept}`);
      cancelQueryMirror();
      navigate(`/media/collections/${encodeURIComponent(joined.id)}`);
    } catch (err) {
      toast.error(err.message || 'Could not join collections.');
    } finally {
      setJoining(false);
    }
  };

  const unsorted = useMemo(() => ({ ...buildUnsortedCollection([], [], []),
    ...(summaries.find(s => s.id === 'unsorted') || {}),
  }), [summaries]);

  const enriched = useMemo(() => {
    if (!collections) return [];
    // Pinned synthetic "Unsorted" entry first, then real collections.
    const all = [unsorted, ...collections];
    return all.map((c) => {
      const summary = summaries.find(s => s.id === c.id);
      const counts = summary?.counts || (c.items || []).reduce((counts, item) => ({ ...counts, [item.kind]: counts[item.kind] + 1 }), { image: 0, video: 0 });
      // Lift the shared auto-creator prefix ("Creative Director: ") out of the
      // title into its own badge, then middle-truncate what's left — otherwise
      // every auto-generated card renders the same clipped prefix and the
      // trailing project name/date that tells them apart is what gets cut.
      const { badge, title } = splitCollectionName(c.name);
      return {
        ...c,
        cover: summary?.cover,
        itemCount: summary?.total ?? (c.items || []).length,
        counts,
        badge,
        displayTitle: middleTruncate(title, TITLE_MAX_CHARS),
      };
    });
  }, [collections, unsorted, summaries]);

  // Filter/sort state lives in the URL so a filtered grid is shareable and
  // survives a back-navigation from a collection. `empty=1` OPTS IN to showing
  // empty collections — the default (param absent) hides them, because an empty
  // auto-created collection has nothing to open.
  const sort = normalizeCollectionSort(searchParams.get('sort'));
  const hideEmpty = searchParams.get('empty') !== '1';

  // Two-stage search (same shape as Catalog): `query` is what the user is
  // typing and drives the client-side filter instantly; `mirroredQuery` is the
  // debounced copy written to the URL, so a shareable `?q=` doesn't cost a
  // history write + full route re-render per keystroke.
  const [query, setQuery] = useState(() => searchParams.get('q') || '');
  const [mirroredQuery, setMirroredQuery] = useState(() => searchParams.get('q') || '');
  // Cancelable so a route change (opening the just-created collection) can
  // drop a still-pending mirror write before it fires — otherwise the stale
  // write can land after the navigation and clobber it back to the list
  // route (#8187). React's own unmount cleanup isn't enough: it runs
  // asynchronously relative to the `navigate()` call in `handleCreate`, and
  // under load the gap can outlast the 300ms debounce.
  const [scheduleQueryMirror, cancelQueryMirror] = useCancelableDebounce();
  useEffect(() => {
    scheduleQueryMirror(() => {
      const trimmed = query.trim();
      setMirroredQuery(trimmed);
      updateParams({ q: trimmed }, { replace: true });
    }, 300);
  }, [query, updateParams, scheduleQueryMirror]);

  // Adopt an externally-changed `?q=` (Back/Forward, or a ⌘K/voice link while
  // this page stays mounted). Our own debounced write lands `urlQuery ===
  // mirroredQuery`, so this is a no-op for typing and only fires on a real
  // external change.
  const urlQuery = searchParams.get('q') || '';
  useEffect(() => {
    if (urlQuery !== mirroredQuery) {
      setQuery(urlQuery);
      setMirroredQuery(urlQuery);
    }
  }, [urlQuery, mirroredQuery]);

  // Search + sort first, then apply "hide empty" as a slice of that result, so
  // the "N empty hidden" count only ever names rows the toggle removed — not
  // rows the search already dropped.
  const matching = useMemo(
    () => applyCollectionView(enriched, { query, sort }),
    [enriched, query, sort],
  );
  const visible = useMemo(
    () => (hideEmpty ? matching.filter((c) => collectionItemCount(c) > 0) : matching),
    [matching, hideEmpty],
  );
  const hiddenEmptyCount = matching.length - visible.length;
  const removingCardVisible = !loading && visible.some((c) => c.id === removedId);
  useEffect(() => {
    // A filter change can unmount the card before its exit callback.
    if (removedId && !removingCardVisible) finishDelete(removedId);
  }, [removedId, removingCardVisible, finishDelete]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <form onSubmit={handleCreate} className="flex flex-1 min-w-0 gap-2 items-center">
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            aria-label="New collection name"
            placeholder="New collection name"
            className="min-w-0 flex-1 bg-port-card border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          />
          <button
            type="submit"
            disabled={creating || joining || !name.trim()}
            className="px-3 py-2 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-40"
          >
            <Plus className="w-4 h-4" /> Create
          </button>
        </form>
        <button
          type="button"
          disabled={organizing || joining || deleting}
          onClick={handleOrganize}
          title="File existing project media using saved project records and render history"
          className="px-3 py-2 rounded-lg border border-port-border bg-port-card hover:bg-port-border text-sm disabled:opacity-40"
        >
          {organizing ? 'Organizing…' : 'Auto-organize'}
        </button>
        {collections?.length >= 2 && !selecting && (
          <button
            type="button"
            onClick={() => {
              cancelDelete();
              setSelectedIds(new Set());
            }}
            disabled={deleting}
            className="px-3 py-2 rounded-lg border border-port-border bg-port-card hover:bg-port-border text-sm disabled:opacity-40"
          >
            Select collections
          </button>
        )}
      </div>

      {selecting && (
        <form onSubmit={handleJoin} className="rounded-lg border border-port-border bg-port-card p-3 space-y-2">
          <p className="text-sm text-gray-400">
            <span role="status">{formatCount(selected.length)} selected.</span>{' '}
            Join at least two collections. Items go into the selected collection with this name, or a new one,
            and the other selected collections are merged away unless you keep them. Collections owned by a
            mood board, music video or project are always kept.
          </p>
          <label htmlFor="join-keep-originals" className="flex items-center gap-2 text-sm text-gray-300">
            <input
              id="join-keep-originals"
              type="checkbox"
              checked={keepOriginals}
              onChange={(e) => setKeepOriginals(e.target.checked)}
              disabled={joining}
            />
            Keep the original collections
          </label>
          <div className="flex flex-wrap gap-2 items-center">
            <label htmlFor="joined-collection-name" className="sr-only">Joined collection name</label>
            <input
              id="joined-collection-name"
              value={joinedName}
              onChange={(e) => setJoinedName(e.target.value)}
              maxLength={80}
              disabled={joining}
              placeholder="Joined collection name"
              className="min-w-0 flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm focus:border-port-accent"
            />
            <button
              type="submit"
              disabled={joining || creating || organizing || loading || selected.length < 2 || !joinedName.trim()}
              className="px-3 py-2 rounded-lg bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-sm disabled:opacity-40"
            >
              {joining ? 'Joining…' : 'Join collections'}
            </button>
            <button
              type="button"
              disabled={joining}
              onClick={() => {
                setSelectedIds(null);
                setJoinedName('');
              }}
              className="px-3 py-2 rounded-lg border border-port-border hover:bg-port-border text-sm disabled:opacity-40"
            >
              Cancel selection
            </button>
          </div>
        </form>
      )}

      {/* Filter row. Stacks under `sm` so the search box keeps a usable width
          on a phone instead of sharing one line with the sort + toggle. */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <label htmlFor="collection-search" className="sr-only">Search collections</label>
          <input
            id="collection-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search collections…"
            className="w-full pl-9 pr-3 py-2 bg-port-card border border-port-border rounded-lg text-white text-sm focus:outline-none focus:border-port-accent"
          />
        </div>
        <label htmlFor="collection-sort" className="sr-only">Sort collections</label>
        <select
          id="collection-sort"
          value={sort}
          onChange={(e) => updateParams({ sort: e.target.value === DEFAULT_COLLECTION_SORT ? '' : e.target.value })}
          className="bg-port-card border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
        >
          {COLLECTION_SORTS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <label htmlFor="collection-hide-empty" className="flex items-center gap-2 text-sm text-gray-400 px-1 py-2 cursor-pointer whitespace-nowrap">
          <input
            id="collection-hide-empty"
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => updateParams({ empty: e.target.checked ? '' : '1' })}
            className="accent-port-accent"
          />
          Hide empty
        </label>
      </div>

      {collectionsError && (
        <Banner
          tone="error"
          size="md"
          icon={AlertTriangle}
          title="Couldn't load collections"
          actions={(
            <button
              type="button"
              onClick={refresh}
              disabled={loading || joining || deleting}
              className="px-2.5 py-1 bg-port-error/20 hover:bg-port-error/40 text-port-error rounded text-xs disabled:opacity-40"
            >
              Retry
            </button>
          )}
        >
          <div className="break-words">{collectionsError}</div>
          {/* A read failed — say so, or the missing grid reads as data loss. */}
          <div className="opacity-80">Nothing was deleted; the list just couldn't be read.</div>
        </Banner>
      )}

      {loading ? (
        <PageSkeleton header="none" label="Loading collections" cards={4} sidebar={false} />
      ) : collections ? (
        <div className="space-y-2">
          {/* Precedence chain, not independent gates. First run wins only when
              no search is active — gated on the REAL collections, since the
              synthetic "Unsorted" entry is always prepended and an
              `enriched.length === 0` test would never fire. Otherwise the
              hidden-empties notice and the empty-result panel render TOGETHER,
              so the panel's "use Show above" can never point at a link that
              isn't on screen. The grid is independent of both — a fresh install
              with loose media shows the onboarding copy AND its Unsorted card. */}
          {collections.length === 0 && !query ? (
            <EmptyState
              icon={FolderOpen}
              title="No collections yet"
              message="Group images and videos into a collection — name one above, or use the folder icon on any image/video card."
              actionLabel="Name your first collection"
              onAction={() => nameInputRef.current?.focus()}
            />
          ) : (
            <>
              {hiddenEmptyCount > 0 && (
                <div className="text-xs text-gray-500">
                  {hiddenEmptyCount} empty {hiddenEmptyCount === 1 ? 'collection' : 'collections'} hidden.{' '}
                  <button type="button" onClick={() => updateParams({ empty: '1' })} className="text-port-accent hover:underline">
                    Show
                  </button>
                </div>
              )}
              {visible.length === 0 && (
                <div className="text-gray-500 text-sm bg-port-card border border-port-border rounded-lg p-6 text-center">
                  {/* "No match" is only true when the search itself came up
                      empty. When it matched rows that "Hide empty" then
                      removed, saying that would contradict the "N empty hidden
                      — Show" line above and send the user hunting for a
                      collection that does exist. */}
                  {matching.length === 0
                    ? 'No collections match that search.'
                    : 'Every collection here is empty — use Show above to see them.'}
                </div>
              )}
            </>
          )}
          {visible.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {visible.map((c) => (
                <CollapsibleListItem key={c.id} removing={removedId === c.id} onExited={() => finishDelete(c.id)} spacing="0">
                  <div className={`bg-port-card border rounded-xl overflow-hidden flex flex-col ${c.synthetic ? 'border-port-accent/40' : 'border-port-border'}`}>
                    <Link
                      to={`/media/collections/${encodeURIComponent(c.id)}`}
                      className="block aspect-square bg-port-bg relative"
                    >
                      {c.cover ? (
                        // A cover can point at a pruned video thumbnail or an unpulled
                        // peer asset; MediaImage degrades to the syncing tile instead
                        // of the browser's broken-image icon.
                        <MediaImage src={c.cover} alt={c.name} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-600">
                          {c.synthetic ? <Inbox className="w-12 h-12" /> : <FolderOpen className="w-12 h-12" />}
                        </div>
                      )}
                    </Link>
                    <div className="p-2 space-y-1.5 flex-1 flex flex-col">
                      {c.badge && (
                        <span className="inline-block self-start text-[9px] uppercase tracking-wide text-gray-400 bg-port-bg border border-port-border rounded px-1.5 py-0.5">
                          {c.badge}
                        </span>
                      )}
                      <Link to={`/media/collections/${encodeURIComponent(c.id)}`} className="text-sm text-white hover:text-port-accent break-words" title={c.name}>
                        {c.displayTitle}
                      </Link>
                      <div className="flex items-center gap-2 text-[10px] text-gray-500">
                        {c.counts.image > 0 && <span className="flex items-center gap-1"><ImageIcon className="w-3 h-3" />{c.counts.image}</span>}
                        {c.counts.video > 0 && <span className="flex items-center gap-1"><Film className="w-3 h-3" />{c.counts.video}</span>}
                        {c.counts.image === 0 && c.counts.video === 0 && <span>Empty</span>}
                      </div>
                      <div className="flex-1" />
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        {!c.synthetic && (
                          <SyncBadge
                            status={syncBadgeStatus(sync, c.id)}
                            onClick={() => navigate(`/media/collections/${encodeURIComponent(c.id)}/sync`)}
                          />
                        )}
                        {!c.synthetic && selecting && (
                          <label className="flex items-center gap-2 px-2 min-h-9 pointer-coarse:min-h-11 rounded border border-port-border cursor-pointer text-xs">
                            <input
                              type="checkbox"
                              aria-label={`Select ${c.name}`}
                              checked={selectedIds.has(c.id)}
                              disabled={joining}
                              onChange={() => toggleSelection(c.id)}
                              className="accent-port-accent"
                            />
                            Select
                          </label>
                        )}
                        {!c.synthetic && !selecting && isConfirming(c.id) && (
                          <ConfirmButtonPair
                            prompt="Delete?"
                            ariaLabel={`Delete ${c.name}`}
                            busy={deletingId === c.id}
                            busyText="Deleting…"
                            onConfirm={() => handleDelete(c)}
                            onCancel={cancelDelete}
                            className="flex-wrap"
                          />
                        )}
                        {!c.synthetic && !selecting && !isConfirming(c.id) && (
                          <button
                            type="button"
                            onClick={() => requestDelete(c.id)}
                            disabled={deleting || organizing}
                            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 px-1.5 py-1 bg-port-error/20 hover:bg-port-error/40 text-port-error text-[10px] rounded flex items-center gap-1"
                            title="Delete collection" aria-label="Delete collection"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </CollapsibleListItem>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
