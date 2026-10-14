import { useCallback, useEffect, useState } from 'react';
import { X, Search, Film, Activity, Star, Ban, Trash2 } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import TabPills from '../ui/TabPills.jsx';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter.jsx';
import { deleteMusicVideoPoolAssets, getMusicVideoMediaPool, markMusicVideoPoolAssets } from '../../services/apiMusicVideo.js';
import { takeThumbUrl, takeClipUrl } from '../../lib/musicVideoTakes.js';
import { formatCount } from '../../utils/formatters.js';

const PAGE = 60;
const SLOT_NOUN = { image: 'still', video: 'clip', endImage: 'end frame' };
// An end frame is picked from the same unused stills as a start frame.
const POOL_KIND = { image: 'image', video: 'video', endImage: 'image' };

/** Which tab a pool item belongs on for this shot: its own takes, another shot's, or the floor. */
export const poolGroup = (item, sceneId) => (!item.sceneId ? 'floor' : item.sceneId === sceneId ? 'shot' : 'others');

// The director's sort of unused assets: ★ ingredients (good, not placed), unsorted, ✕ bad (to clean up).
const MARK_FILTERS = [
  { id: 'all', label: 'All' }, { id: 'ingredient', label: '★ Ingredients' }, { id: 'unsorted', label: 'Unsorted' }, { id: 'bad', label: '✕ Bad' },
];
const markOf = (item) => item.mark || 'unsorted';
const poolKey = (item) => `${item.kind}:${item.assetId}`;
const CHIP = 'min-h-[44px] rounded border px-2 text-xs sm:min-h-[28px]';
const ACTION = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-3 text-xs disabled:opacity-50 sm:min-h-[32px]';

/** Items of one kind matching a search over their prompt, or a shot number ("12" or "#12"). */
export function filterPool(items, { kind, query, shotNumbers }) {
  const needle = query.trim().toLowerCase().replace(/^#/, '');
  return items.filter((item) => item.kind === kind && (!needle
    || String(item.prompt || '').toLowerCase().includes(needle)
    || (item.sceneId && String(shotNumbers.get(item.sceneId) ?? '') === needle)));
}

/**
 * "Swap from unused": every still (or clip) generated for this video that no
 * shot uses now, as a searchable contact sheet in three tabs: this shot's
 * other takes, other shots' unused takes, and the floor (takes a cut shot, a
 * re-plan or a merge left behind). Tap one to see it full size, then use it,
 * or use it with its partner: a still's rendered clip, or a clip's still.
 * `kind: 'endImage'` picks a still for the shot's end frame, on its own.
 * `onPlace({ kind, assetId, withAssetId? })` puts it on the shot.
 *
 * It is also where the video's assets are sorted: mark one ★ ingredient (good,
 * not placed yet) or ✕ bad, filter by mark, and delete bad ones from the
 * media library (the server refuses anything a shot uses).
 */
export default function SceneTakePicker({ open, onClose, projectId, scene, kind, shotNumbers = new Map(), onPlace, busy = false }) {
  const [pool, setPool] = useState(null);
  const [error, setError] = useState(null);
  const [group, setGroup] = useState('shot');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState(null);
  const [markFilter, setMarkFilter] = useState('all');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setPool(null); setError(null); setPicked(null); setQuery(''); setShown(PAGE); setMarkFilter('all'); setConfirmDelete(null);
    getMusicVideoMediaPool(projectId, { silent: true })
      .then((res) => {
        if (!active) return;
        const items = res.items || [];
        setPool(items);
        // Open on the first tab that has anything in it.
        const groups = new Set(items.filter((item) => item.kind === POOL_KIND[kind]).map((item) => poolGroup(item, scene.sceneId)));
        setGroup(['shot', 'others', 'floor'].find((g) => groups.has(g)) || 'shot');
      })
      .catch((err) => { if (active) setError(err?.message || 'Could not load the unused takes'); });
    return () => { active = false; };
  }, [open, projectId, scene.sceneId, kind]);

  const ofKind = pool ? filterPool(pool, { kind: POOL_KIND[kind], query, shotNumbers }) : [];
  const counts = { shot: 0, others: 0, floor: 0 };
  for (const item of ofKind) counts[poolGroup(item, scene.sceneId)] += 1;
  const activeGroup = group;
  const inGroup = ofKind.filter((item) => poolGroup(item, scene.sceneId) === activeGroup);
  const markCounts = { all: inGroup.length, ingredient: 0, unsorted: 0, bad: 0 };
  for (const item of inGroup) markCounts[markOf(item)] += 1;
  const items = markFilter === 'all' ? inGroup : inGroup.filter((item) => markOf(item) === markFilter);
  const noun = SLOT_NOUN[kind];
  const itemNoun = SLOT_NOUN[POOL_KIND[kind]];
  const shotName = shotNumbers.get(scene.sceneId) ? `Shot ${shotNumbers.get(scene.sceneId)}` : 'this shot';
  const partner = picked && (kind === 'image' ? picked.clipIds?.[0] : kind === 'video' ? picked.sourceImageId : null) || null;
  // Stays open when the shot refuses the pick (onPlace resolves false), so another can be tried.
  const place = (withAssetId) => Promise.resolve(onPlace?.({ kind, assetId: picked.assetId, ...(withAssetId ? { withAssetId } : {}) }))
    .then((placed) => { if (placed !== false) onClose?.(); });

  const run = (work) => { setWorking(true); setError(null); return work().catch((err) => setError(err?.message || 'That did not work')).finally(() => setWorking(false)); };
  // Tapping the active mark clears it; a rejected take then reads as bad again, as the server sees it.
  const toggleMark = (mark) => run(async () => {
    const next = picked.mark === mark ? null : mark;
    await markMusicVideoPoolAssets(projectId, [{ kind: picked.kind, assetId: picked.assetId }], next, { silent: true });
    const display = next || (picked.takeStatus === 'rejected' ? 'bad' : null);
    setPool((prev) => prev.map((item) => (poolKey(item) === poolKey(picked) ? { ...item, mark: display } : item)));
    setPicked((prev) => ({ ...prev, mark: display }));
  });
  const remove = (targets) => run(async () => {
    await deleteMusicVideoPoolAssets(projectId, targets.map(({ kind: k, assetId }) => ({ kind: k, assetId })), { silent: true });
    const gone = new Set(targets.map(poolKey));
    setPool((prev) => prev.filter((item) => !gone.has(poolKey(item))));
    setPicked((prev) => (prev && gone.has(poolKey(prev)) ? null : prev));
    setConfirmDelete(null);
  });
  const badHere = markFilter === 'bad' ? items : [];
  // The next page loads when the bottom of the grid scrolls into view.
  const showMore = useCallback(() => setShown((n) => n + PAGE), []);

  return (
    // Full height at every width, and nearly the full width on a desktop, so more of the contact sheet is in view.
    <Modal open={open} onClose={onClose} size="none" usePortal ariaLabel={`Swap ${noun} for ${shotName}`}
      panelClassName="w-full max-w-4xl lg:max-w-[min(100%,1600px)] min-h-dvh-cap bg-port-card border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">Swap {noun} · {shotName}</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded sm:min-h-0 sm:min-w-0 sm:p-1">
          <X size={16} />
        </button>
      </div>
      <TabPills activeTab={activeGroup} onChange={(id) => { setGroup(id); setShown(PAGE); setPicked(null); setConfirmDelete(null); }}
        tabs={[{ id: 'shot', label: 'This shot', count: counts.shot }, { id: 'others', label: 'Other shots', count: counts.others }, { id: 'floor', label: 'Floor', count: counts.floor }]} />
      <label htmlFor={`mv-pool-search-${scene.sceneId}`} className="flex items-center gap-2 rounded border border-port-border bg-port-bg px-2">
        <Search size={14} aria-hidden="true" className="shrink-0 text-port-text-muted" />
        <span className="sr-only">Search prompts or shot number</span>
        <input id={`mv-pool-search-${scene.sceneId}`} type="search" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
          placeholder="Search prompts or shot #" className="min-h-[44px] min-w-0 flex-1 bg-transparent text-sm outline-none sm:min-h-[32px]" />
      </label>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Show by mark">
        {MARK_FILTERS.map((filter) => (
          <button key={filter.id} type="button" aria-pressed={markFilter === filter.id}
            onClick={() => { setMarkFilter(filter.id); setShown(PAGE); setConfirmDelete(null); }}
            className={`${CHIP} ${markFilter === filter.id ? 'border-port-accent text-port-accent' : 'border-port-border'} ${filter.id === 'bad' ? 'text-port-error' : ''}`}>
            {filter.label} {formatCount(markCounts[filter.id], { fallback: '0' })}
          </button>
        ))}
      </div>
      {picked && (
        <div className="space-y-2 rounded border border-port-border p-2">
          {kind === 'video'
            ? <video key={picked.assetId} src={takeClipUrl(picked)} poster={takeThumbUrl(picked)} controls autoPlay muted loop playsInline className="w-full aspect-video rounded bg-black object-contain" />
            : <img src={takeThumbUrl(picked)} alt="" className="w-full aspect-video rounded bg-black object-contain" />}
          {picked.prompt && <p className="line-clamp-2 text-[11px] text-port-text-muted">{picked.prompt}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => place(null)}
              className="inline-flex min-h-[44px] items-center gap-1 rounded bg-port-accent px-3 text-xs font-medium text-white disabled:opacity-50 sm:min-h-[32px]">
              {busy && <Activity size={14} className="animate-spin" />}Use {noun}
            </button>
            {partner && (
              <button type="button" disabled={busy} onClick={() => place(partner)} className={ACTION}>
                Use {noun} + its {kind === 'image' ? 'clip' : 'still'}
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
            <button type="button" disabled={working} onClick={() => setConfirmDelete('picked')} className={ACTION}>
              <Trash2 size={14} aria-hidden="true" />Delete
            </button>
          </div>
          {confirmDelete === 'picked' && (
            <DeleteConfirm count={1} noun={itemNoun} working={working} onConfirm={() => remove([picked])} onCancel={() => setConfirmDelete(null)} />
          )}
        </div>
      )}
      {badHere.length > 0 && (confirmDelete === 'bad'
        ? <DeleteConfirm count={badHere.length} noun={itemNoun} working={working} onConfirm={() => remove(badHere)} onCancel={() => setConfirmDelete(null)} />
        : (
          <button type="button" disabled={working} onClick={() => setConfirmDelete('bad')}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-1 rounded border border-port-error text-xs text-port-error disabled:opacity-50 sm:min-h-[32px]">
            <Trash2 size={14} aria-hidden="true" />Delete {formatCount(badHere.length)} bad
          </button>
        ))}
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      {!pool && !error && <p className="flex items-center gap-2 text-xs text-port-text-muted"><Activity size={14} className="animate-spin" />Gathering every {itemNoun} made for this video…</p>}
      {pool && items.length === 0 && (
        <p className="text-xs text-port-text-muted">{query ? `No unused ${itemNoun}s match.` : `No unused ${itemNoun}s here.`}</p>
      )}
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8" aria-label={`Unused ${itemNoun}s`}>
        {items.slice(0, shown).map((item) => {
          const number = item.sceneId ? shotNumbers.get(item.sceneId) : null;
          const selected = picked?.assetId === item.assetId;
          return (
            <li key={item.assetId}>
              <button type="button" onClick={() => setPicked(item)} aria-pressed={selected}
                aria-label={`${itemNoun}${number ? ` from shot ${number}` : ''}${item.prompt ? `: ${item.prompt.slice(0, 80)}` : ''}`}
                className={`relative block w-full overflow-hidden rounded border ${selected ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border'} ${item.mark === 'bad' ? 'opacity-50' : ''}`}>
                <img src={takeThumbUrl(item)} alt="" loading="lazy" className="block aspect-video w-full bg-black object-cover" />
                {number && <span className="port-media-overlay-strong absolute left-1 top-1 rounded px-1 text-[10px] leading-tight">#{number}</span>}
                {item.mark && (
                  <span className={`port-media-overlay-strong absolute right-1 top-1 rounded px-0.5 ${item.mark === 'bad' ? 'text-port-error' : 'text-port-warning'}`}>
                    {item.mark === 'bad' ? <Ban size={11} aria-label="bad" /> : <Star size={11} aria-label="ingredient" />}
                  </span>
                )}
                {(kind === 'video' || item.clipIds?.length > 0) && (
                  <span className="port-media-overlay-strong absolute bottom-1 right-1 inline-flex items-center gap-0.5 rounded px-1 text-[10px] leading-tight">
                    <Film size={10} aria-hidden="true" />{kind === 'video' ? 'clip' : 'has clip'}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {items.length > shown && (
        <InfiniteScrollFooter hasMore loading={false} error={null} onLoadMore={showMore}
          label={`Show more (${formatCount(items.length - shown)} left)`} />
      )}
    </Modal>
  );
}

function DeleteConfirm({ count, noun, working, onConfirm, onCancel }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-port-error/50 p-2 text-xs">
      <span className="min-w-0 flex-1">Delete {count === 1 ? `this ${noun}` : `${formatCount(count)} ${noun}s`} from the media library? This can't be undone.</span>
      <button type="button" disabled={working} onClick={onConfirm}
        className="inline-flex min-h-[44px] items-center gap-1 rounded bg-port-error px-3 font-medium text-white disabled:opacity-50 sm:min-h-[32px]">
        {working && <Activity size={14} className="animate-spin" />}Yes, delete
      </button>
      <button type="button" disabled={working} onClick={onCancel} className={ACTION}>Keep</button>
    </div>
  );
}
