import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Activity, Ban, Check, Film, FolderInput, Image as ImageIcon, Library, Pencil, Search, Star, Trash2 } from 'lucide-react';
import TabPills from '../../ui/TabPills.jsx';
import InfiniteScrollFooter from '../../ui/InfiniteScrollFooter.jsx';
import { DeleteConfirm, applyPoolDelete, filterPool, poolKey, settlePoolDelete, usedLabel } from '../SceneTakePicker.jsx';
import { shotNumbers as numberShots } from '../ShotStepper.jsx';
import { addMusicVideoLibraryMedia, deleteMusicVideoPoolAssets, getMusicVideoMediaPool, importMusicVideoPool, listMusicVideoProjectSummaries, markMusicVideoPoolAssets, searchMusicVideoLibrary, searchMusicVideoMediaPool } from '../../../services/apiMusicVideo.js';
import { takeThumbUrl, takeClipUrl } from '../../../lib/musicVideoTakes.js';
import { formatCount } from '../../../utils/formatters.js';

const PAGE = 60;
const KINDS = { stills: 'image', clips: 'video' };
const NOUN = { image: 'still', video: 'clip' };
// Unsorted is the sorting queue: not on a shot and not marked yet.
const FILTERS = [
  { id: 'all', label: 'All' }, { id: 'used', label: 'In use' }, { id: 'ingredient', label: '★ Ingredients' },
  { id: 'unsorted', label: 'Unsorted' }, { id: 'bad', label: '✕ Bad' },
];
const inUse = (item) => item.inUseBy?.length > 0;
const MATCHES = {
  all: () => true,
  used: inUse,
  ingredient: (item) => item.mark === 'ingredient',
  unsorted: (item) => !item.mark && !inUse(item),
  bad: (item) => item.mark === 'bad',
};
const CHIP = 'min-h-[44px] rounded border px-2 text-xs sm:min-h-[28px]';
const ACTION = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-3 text-xs disabled:opacity-50 sm:min-h-[32px]';

/**
 * Assets: every still and clip made for this video on one page, in shot order
 * with the floor (takes a cut shot or a re-plan left behind) last. Search the
 * prompts or a shot number, sort them ★ ingredient or ✕ bad, delete bad ones
 * from the media library (the server refuses anything a shot uses), and jump
 * to the shot a file was made for. "Add media from another video" files an
 * earlier draft's stills and clips in too (they land on the floor). The open tab and file are in the URL
 * (`?kind=clips&asset=<id>`).
 */
export default function AssetsStage({ board }) {
  const { project, takes, onEditShot } = board;
  const projectId = project.id;
  const shotNumbers = numberShots(project.scenes);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('kind') === 'clips' ? 'clips' : 'stills';
  const kind = KINDS[tab];
  const pickedId = searchParams.get('asset');
  const setParams = (changes) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    return next;
  }, { replace: true });

  const [pool, setPool] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState(null);
  const [filter, setFilter] = useState('all');
  const [shown, setShown] = useState(PAGE);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    setPool(null); setError(null);
    getMusicVideoMediaPool(projectId, { silent: true })
      .then((res) => { if (active) setPool(res.items || []); })
      .catch((err) => { if (active) setError(err?.message || 'Could not load the assets'); });
    return () => { active = false; };
  }, [projectId]);

  // Typing searches the prompts each file was made from, after a short pause.
  useEffect(() => {
    const q = query.trim();
    setMatches(null);
    if (!q) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      searchMusicVideoMediaPool(projectId, q, { silent: true })
        .then((res) => { if (active) setMatches(new Set((res.items || []).map(poolKey))); })
        .catch(() => { if (active) setMatches(new Set()); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, query]);

  const order = (item) => (item.sceneId && shotNumbers.get(item.sceneId)) || Infinity;
  const searched = pool ? filterPool(pool, { kind, query, shotNumbers, matches }).sort((a, b) => order(a) - order(b)) : [];
  const kindCounts = { stills: 0, clips: 0 };
  for (const item of pool || []) if (item.kind === 'image') kindCounts.stills += 1; else if (item.kind === 'video') kindCounts.clips += 1;
  const filterCounts = Object.fromEntries(FILTERS.map(({ id }) => [id, searched.filter(MATCHES[id]).length]));
  const items = searched.filter(MATCHES[filter]);
  const picked = pool?.find((item) => item.kind === kind && item.assetId === pickedId) || null;
  const noun = NOUN[kind];
  const pickedShot = picked?.sceneId ? shotNumbers.get(picked.sceneId) : null;

  const run = (work) => { setWorking(true); setError(null); return work().catch((err) => setError(err?.message || 'That did not work')).finally(() => setWorking(false)); };
  // Tapping the active mark clears it.
  const toggleMark = (mark) => run(async () => {
    const next = picked.mark === mark ? null : mark;
    const result = await markMusicVideoPoolAssets(projectId, [{ kind: picked.kind, assetId: picked.assetId }], next, { silent: true });
    // Bad rejects its takes on the shots not using it; the shots pick that up at once.
    takes?.applyPoolMarks?.(projectId, result);
    setPool((prev) => prev.map((item) => (poolKey(item) === poolKey(picked) ? { ...item, mark: next } : item)));
  });
  const remove = (targets) => run(async () => {
    const result = await deleteMusicVideoPoolAssets(projectId, targets.map(({ kind: k, assetId }) => ({ kind: k, assetId })), { silent: true });
    const settled = settlePoolDelete(result, targets);
    const { gone } = settled;
    setPool((prev) => applyPoolDelete(prev, settled));
    if (picked && gone.has(poolKey(picked))) setParams({ asset: null });
    setConfirmDelete(null);
  });
  // Add media from another video (an earlier draft): its stills and clips join this one's assets and stats outro.
  const [importing, setImporting] = useState(null);
  const [imported, setImported] = useState(null);
  const [librarySearch, setLibrarySearch] = useState(false);
  const openImport = () => {
    setImporting({ projects: null, fromId: '' });
    listMusicVideoProjectSummaries({ limit: 100 }, { silent: true })
      .then((res) => setImporting((prev) => prev && { ...prev, projects: (res.items || []).filter((p) => p.id !== projectId) }))
      .catch((err) => { setImporting(null); setError(err?.message || 'Could not list the other videos'); });
  };
  const runImport = () => run(async () => {
    const from = importing.projects.find((p) => p.id === importing.fromId);
    const result = await importMusicVideoPool(projectId, importing.fromId, { silent: true });
    setPool(result.items || []);
    setImporting(null);
    setImported(`Added ${formatCount(result.added, { fallback: '0' })} stills and clips from ${from?.name || 'that video'}${result.added < result.total ? ` (${formatCount(result.total - result.added)} were already here)` : ''}.`);
  });
  // A shot using it keeps it: the server refuses to delete it, so it's never offered.
  const badHere = filter === 'bad' ? items.filter((item) => !inUse(item)) : [];
  const showMore = useCallback(() => setShown((n) => n + PAGE), []);

  return (
    <div className="space-y-2">
      <TabPills activeTab={tab} onChange={(id) => { setParams({ kind: id === 'clips' ? 'clips' : null, asset: null }); setShown(PAGE); setConfirmDelete(null); }}
        variant="pills" size="sm"
        tabs={[{ id: 'stills', label: 'Stills', icon: ImageIcon, count: kindCounts.stills }, { id: 'clips', label: 'Clips', icon: Film, count: kindCounts.clips }]} />
      <label htmlFor="mv-assets-search" className="flex items-center gap-2 rounded border border-port-border bg-port-bg px-2">
        <Search size={14} aria-hidden="true" className="shrink-0 text-port-text-muted" />
        <span className="sr-only">Search prompts or shot number</span>
        <input id="mv-assets-search" type="search" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
          placeholder="Search prompts or shot #" className="min-h-[44px] min-w-0 flex-1 bg-transparent text-sm outline-none sm:min-h-[32px]" />
      </label>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
        {FILTERS.map((entry) => (
          <button key={entry.id} type="button" aria-pressed={filter === entry.id}
            onClick={() => { setFilter(entry.id); setShown(PAGE); setConfirmDelete(null); }}
            className={`${CHIP} ${filter === entry.id ? 'border-port-accent text-port-accent' : 'border-port-border'} ${entry.id === 'bad' ? 'text-port-error' : ''}`}>
            {entry.label} {formatCount(filterCounts[entry.id], { fallback: '0' })}
          </button>
        ))}
      </div>
      {picked && (
        <div className="space-y-2 rounded border border-port-border p-2">
          {kind === 'video'
            ? <video key={picked.assetId} src={takeClipUrl(picked)} poster={takeThumbUrl(picked)} controls autoPlay muted loop playsInline className="max-h-[60vh] w-full aspect-video rounded bg-black object-contain" />
            : <img src={takeThumbUrl(picked)} alt="" className="max-h-[60vh] w-full aspect-video rounded bg-black object-contain" />}
          <p className="text-[11px] text-port-text-muted">
            {[pickedShot ? `Made for shot ${pickedShot}` : 'On the floor', usedLabel(picked, shotNumbers)].filter(Boolean).join(' · ')}
          </p>
          {picked.prompt && <p className="line-clamp-3 text-[11px] text-port-text-muted">{picked.prompt}</p>}
          <div className="flex flex-wrap gap-2">
            {pickedShot && onEditShot && (
              <button type="button" onClick={() => onEditShot(picked.sceneId)} className={ACTION}>
                <Pencil size={14} aria-hidden="true" />Open shot {pickedShot}
              </button>
            )}
            <button type="button" disabled={working} onClick={() => toggleMark('ingredient')} aria-pressed={picked.mark === 'ingredient'}
              title="Good, not placed yet: keep it as an ingredient" className={`${ACTION} ${picked.mark === 'ingredient' ? 'border-port-warning text-port-warning' : ''}`}>
              <Star size={14} aria-hidden="true" />Ingredient
            </button>
            <button type="button" disabled={working} onClick={() => toggleMark('bad')} aria-pressed={picked.mark === 'bad'}
              title="Failed or unusable: clean it up later" className={`${ACTION} ${picked.mark === 'bad' ? 'border-port-error text-port-error' : ''}`}>
              <Ban size={14} aria-hidden="true" />Bad
            </button>
            {!inUse(picked) && (
              <button type="button" disabled={working} onClick={() => setConfirmDelete('picked')} className={ACTION}>
                <Trash2 size={14} aria-hidden="true" />Delete
              </button>
            )}
          </div>
          {confirmDelete === 'picked' && (
            <DeleteConfirm count={1} noun={noun} working={working} onConfirm={() => remove([picked])} onCancel={() => setConfirmDelete(null)} />
          )}
        </div>
      )}
      {badHere.length > 0 && (confirmDelete === 'bad'
        ? <DeleteConfirm count={badHere.length} noun={noun} working={working} onConfirm={() => remove(badHere)} onCancel={() => setConfirmDelete(null)} />
        : (
          <button type="button" disabled={working} onClick={() => setConfirmDelete('bad')}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-1 rounded border border-port-error text-xs text-port-error disabled:opacity-50 sm:min-h-[32px]">
            <Trash2 size={14} aria-hidden="true" />Delete {formatCount(badHere.length)} bad
          </button>
        ))}
      {importing ? (
        <div className="flex flex-wrap items-center gap-2 rounded border border-port-border p-2 text-xs">
          <label htmlFor="mv-assets-import" className="shrink-0">Add media from</label>
          <select id="mv-assets-import" value={importing.fromId} disabled={!importing.projects || working}
            onChange={(e) => setImporting((prev) => ({ ...prev, fromId: e.target.value }))}
            className="min-h-[44px] min-w-0 flex-1 basis-48 rounded border border-port-border bg-port-bg px-2 text-sm sm:min-h-[32px]">
            <option value="">{importing.projects ? 'Pick a video' : 'Loading videos…'}</option>
            {(importing.projects || []).map((p) => <option key={p.id} value={p.id}>{p.name || 'Untitled'}{p.version > 1 ? ` (v${p.version})` : ''}</option>)}
          </select>
          <button type="button" disabled={!importing.fromId || working} onClick={runImport}
            className="inline-flex min-h-[44px] items-center gap-1 rounded bg-port-accent px-3 font-medium text-white disabled:opacity-50 sm:min-h-[32px]">
            {working && <Activity size={14} className="animate-spin" />}Add
          </button>
          <button type="button" disabled={working} onClick={() => setImporting(null)} className={ACTION}>Cancel</button>
        </div>
      ) : librarySearch ? (
        <LibraryAdd projectId={projectId} onCancel={() => setLibrarySearch(false)}
          onAdded={(result) => { setPool(result.items || []); setLibrarySearch(false); setImported(`Added ${formatCount(result.added, { fallback: '0' })} from the media library.`); }} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { setImported(null); openImport(); }} className={ACTION}>
            <FolderInput size={14} aria-hidden="true" />Add media from another video
          </button>
          <button type="button" onClick={() => { setImported(null); setLibrarySearch(true); }} className={ACTION}>
            <Library size={14} aria-hidden="true" />Add from the media library
          </button>
        </div>
      )}
      {imported && <p role="status" className="text-xs text-port-success">{imported}</p>}
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      {!pool && !error && <p className="flex items-center gap-2 text-xs text-port-text-muted"><Activity size={14} className="animate-spin" />Gathering every still and clip made for this video…</p>}
      {pool && items.length === 0 && (
        <p className="text-xs text-port-text-muted">{query && !matches ? 'Searching prompts…' : `No ${noun}s here.`}</p>
      )}
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8" aria-label={tab === 'clips' ? 'Clips' : 'Stills'}>
        {items.slice(0, shown).map((item) => {
          const number = item.sceneId ? shotNumbers.get(item.sceneId) : null;
          const selected = picked?.assetId === item.assetId;
          const used = usedLabel(item, shotNumbers);
          return (
            <li key={item.assetId}>
              <button type="button" onClick={() => setParams({ asset: selected ? null : item.assetId })} aria-pressed={selected}
                aria-label={`${noun}${number ? ` from shot ${number}` : ' on the floor'}${used ? `, ${used.toLowerCase()}` : ''}${item.prompt ? `: ${item.prompt.slice(0, 80)}` : ''}`}
                className={`relative block w-full overflow-hidden rounded border ${selected ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border'} ${item.mark === 'bad' ? 'opacity-50' : ''}`}>
                <img src={takeThumbUrl(item)} alt="" loading="lazy" className="block aspect-video w-full bg-black object-cover" />
                <span className="port-media-overlay-strong absolute left-1 top-1 rounded px-1 text-[10px] leading-tight">{number ? `#${number}` : 'Floor'}</span>
                {item.mark && (
                  <span className={`port-media-overlay-strong absolute right-1 top-1 rounded px-0.5 ${item.mark === 'bad' ? 'text-port-error' : 'text-port-warning'}`}>
                    {item.mark === 'bad' ? <Ban size={11} aria-label="bad" /> : <Star size={11} aria-label="ingredient" />}
                  </span>
                )}
                {item.pendingDelete && <span className="port-media-overlay-strong absolute bottom-6 left-1 rounded px-1 text-[10px] leading-tight text-port-warning">Delete pending</span>}
                {inUse(item) && <span className="port-media-overlay-strong absolute bottom-1 left-1 rounded px-1 text-[10px] leading-tight">In use</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {items.length > shown && (
        <InfiniteScrollFooter hasMore loading={false} error={null} onLoadMore={showMore}
          label={`Show more (${formatCount(items.length - shown)} left)`} />
      )}
    </div>
  );
}

/**
 * "Add from the media library": stills and clips made for the video but never
 * filed under it (rendered before renders named their video). Search the
 * prompts, tap to pick (or Pick all), then Add.
 */
function LibraryAdd({ projectId, onAdded, onCancel }) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const q = query.trim();
    setFound(null); setPicked(new Set());
    if (!q) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      searchMusicVideoLibrary(projectId, q, { silent: true })
        .then((res) => { if (active) setFound(res); })
        .catch((err) => { if (active) setError(err?.message || 'Search failed'); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, query]);

  const toggle = (key) => setPicked((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const items = found?.items || [];
  const add = () => {
    setBusy(true); setError(null);
    addMusicVideoLibraryMedia(projectId, items.filter((item) => picked.has(poolKey(item))).map(({ kind, assetId }) => ({ kind, assetId })), { silent: true })
      .then(onAdded)
      .catch((err) => setError(err?.message || 'Could not add them'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-2 rounded border border-port-border p-2">
      <label htmlFor="mv-assets-library" className="flex items-center gap-2 rounded border border-port-border bg-port-bg px-2">
        <Library size={14} aria-hidden="true" className="shrink-0 text-port-text-muted" />
        <span className="sr-only">Search the media library by prompt</span>
        <input id="mv-assets-library" type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
          placeholder="Search the media library by prompt" className="min-h-[44px] min-w-0 flex-1 bg-transparent text-sm outline-none sm:min-h-[32px]" />
      </label>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 text-port-text-muted">
          {!query.trim() ? 'Media not in this video yet.' : !found ? 'Searching…'
            : `${formatCount(items.length, { fallback: '0' })}${found.more ? '+' : ''} not in this video yet`}
        </span>
        {items.length > 0 && (
          <button type="button" disabled={busy} onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map(poolKey)))} className={ACTION}>
            {picked.size === items.length ? 'Pick none' : 'Pick all'}
          </button>
        )}
        <button type="button" disabled={!picked.size || busy} onClick={add}
          className="inline-flex min-h-[44px] items-center gap-1 rounded bg-port-accent px-3 font-medium text-white disabled:opacity-50 sm:min-h-[32px]">
          {busy && <Activity size={14} className="animate-spin" />}Add {formatCount(picked.size, { fallback: '0' })}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={ACTION}>Cancel</button>
      </div>
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      {items.length > 0 && (
        <ul className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 lg:grid-cols-6" aria-label="Media library matches">
          {items.map((item) => {
            const key = poolKey(item);
            const on = picked.has(key);
            return (
              <li key={key}>
                <button type="button" onClick={() => toggle(key)} aria-pressed={on} aria-label={`${NOUN[item.kind]}: ${String(item.prompt || '').slice(0, 80)}`}
                  className={`relative block w-full overflow-hidden rounded border ${on ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border'}`}>
                  <img src={takeThumbUrl(item)} alt="" loading="lazy" className="block aspect-video w-full bg-black object-cover" />
                  {item.kind === 'video' && <span className="port-media-overlay-strong absolute bottom-1 right-1 inline-flex items-center gap-0.5 rounded px-1 text-[10px] leading-tight"><Film size={10} aria-hidden="true" />clip</span>}
                  {on && <span className="port-media-overlay-strong absolute right-1 top-1 rounded p-0.5 text-port-accent"><Check size={12} aria-hidden="true" /></span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
