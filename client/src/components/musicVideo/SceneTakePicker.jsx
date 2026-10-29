import { useCallback, useEffect, useState } from 'react';
import { X, Search, Film, Activity, Star, Ban, Trash2 } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import TabPills from '../ui/TabPills.jsx';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter.jsx';
import { deleteMusicVideoPoolAssets, getMusicVideoMediaPool, markMusicVideoPoolAssets, searchMusicVideoMediaPool } from '../../services/apiMusicVideo.js';
import { takeThumbUrl, takeClipUrl } from '../../lib/musicVideoTakes.js';
import { formatCount } from '../../utils/formatters.js';
import { mediaDeleteOutcome } from '../../lib/mediaDeleteOutcome.js';
import toast from '../ui/Toast';

const PAGE = 60;
const SLOT_NOUN = { image: 'still', video: 'clip', endImage: 'end frame' };
// An end frame is picked from the same stills as a start frame.
const POOL_KIND = { image: 'image', video: 'video', endImage: 'image' };
const SLOT_FIELD = { image: 'referenceImageId', video: 'videoHistoryId', endImage: 'endImageId' };

/** Which tab a pool item belongs on for this shot: its own takes, another shot's, or the floor. */
export const poolGroup = (item, sceneId) => (!item.sceneId ? 'floor' : item.sceneId === sceneId ? 'shot' : 'others');

// The director's sort of the video's assets: ★ ingredients (good, not placed), unsorted, ✕ bad (to clean up).
const MARK_FILTERS = [
  { id: 'all', label: 'All' }, { id: 'ingredient', label: '★ Ingredients' }, { id: 'unsorted', label: 'Unsorted' }, { id: 'bad', label: '✕ Bad' },
];
const markOf = (item) => item.mark || 'unsorted';
// The shot's own frame in the other slot: its end frame when swapping the start, its start when swapping the end.
const OTHER_FRAME = { image: { field: 'endImageId', takeKind: 'endImage', prompt: 'endFramePrompt', label: 'End frame' },
  endImage: { field: 'referenceImageId', takeKind: 'image', prompt: 'framePrompt', label: 'Start frame' } };

/**
 * The shot's frame in the other slot as a pool item, or null: labeled and listed
 * first on This shot, in place of its plain pool entry.
 */
function otherFrameItem(scene, kind) {
  const other = OTHER_FRAME[kind];
  const assetId = other && scene?.[other.field];
  if (!assetId) return null;
  const take = scene.takes?.find((t) => t.kind === other.takeKind && t.assetId === assetId);
  return { kind: 'image', assetId, sceneId: scene.sceneId, prompt: take?.prompt || scene[other.prompt] || null, clipIds: [], ownFrame: other.label };
}
export const poolKey = (item) => `${item.kind}:${item.assetId}`;
/**
 * What a pool delete response means for the listed targets: `gone` keys leave the
 * pool, `pending` maps a key to the marker an asset keeps while its owner is
 * unreachable. Notices other than plain success are toasted. A response without
 * per-item results (an older server) removes every target.
 */
export function settlePoolDelete(result, targets) {
  const gone = new Set();
  const pending = new Map();
  const results = new Map((result?.items || []).map((item) => [poolKey(item), item]));
  for (const target of targets) {
    const key = poolKey(target);
    const outcome = mediaDeleteOutcome(results.get(key) || { status: 'deleted' }, target.kind);
    if (outcome.remove) gone.add(key);
    else if (outcome.pendingDelete) pending.set(key, outcome.pendingDelete);
    if (outcome.tone !== 'success') toast(outcome.notice);
  }
  return { gone, pending };
}
// The pool after a delete: removed items drop out, pending ones carry their marker.
export const applyPoolDelete = (pool, { gone, pending }) => pool
  .filter((item) => !gone.has(poolKey(item)))
  .map((item) => (pending.has(poolKey(item)) ? { ...item, pendingDelete: pending.get(poolKey(item)) } : item));
/** "Used on #3, #12" for an item other shots (or this one) use now, else null. */
export const usedLabel = (item, shotNumbers) => {
  const numbers = (item.inUseBy || []).map((id) => shotNumbers.get(id)).filter(Boolean);
  return item.inUseBy?.length ? `Used on ${numbers.length ? numbers.map((n) => `#${n}`).join(', ') : 'a shot'}` : null;
};
const CHIP = 'min-h-[44px] rounded border px-2 text-xs sm:min-h-[28px]';
const ACTION = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-3 text-xs disabled:opacity-50 sm:min-h-[32px]';

/**
 * Items of one kind matching a search over their prompt, or a shot number ("12" or "#12").
 * `matches` holds the keys the server's prompt search found (the prompt each file was made from).
 */
export function filterPool(items, { kind, query, shotNumbers, matches = null }) {
  const needle = query.trim().toLowerCase().replace(/^#/, '');
  return items.filter((item) => item.kind === kind && (!needle
    || String(item.prompt || '').toLowerCase().includes(needle)
    || matches?.has(poolKey(item))
    || (item.sceneId && String(shotNumbers.get(item.sceneId) ?? '') === needle)));
}

/**
 * "Swap": every still (or clip) generated for this video, as a searchable
 * contact sheet in three tabs: this shot's other takes, other shots' takes
 * (one another shot uses is marked "In use"), and the floor (takes a cut shot, a
 * re-plan or a merge left behind). Tap one to see it full size, then use it,
 * or use it with its partner: a still's rendered clip, or a clip's still.
 * `kind: 'endImage'` picks a still for the shot's end frame, on its own.
 * `onPlace({ kind, assetId, withAssetId? })` puts it on the shot.
 *
 * It is also where the video's assets are sorted: mark one ★ ingredient (good,
 * not placed yet) or ✕ bad, filter by mark, and delete bad ones from the
 * media library (the server refuses anything a shot uses).
 */
export default function SceneTakePicker({ open, onClose, projectId, scene, kind, shotNumbers = new Map(), onPlace, onMarked = null, busy = false }) {
  const [pool, setPool] = useState(null);
  const [error, setError] = useState(null);
  const [group, setGroup] = useState('shot');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState(null);
  const [markFilter, setMarkFilter] = useState('all');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [working, setWorking] = useState(false);
  const [matches, setMatches] = useState(null);

  // The shot's frame in the other slot always sits on This shot, so the picker opens there when it has one.
  const hasOwnFrame = !!otherFrameItem(scene, kind);
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
        setGroup(hasOwnFrame ? 'shot' : ['shot', 'others', 'floor'].find((g) => groups.has(g)) || 'shot');
      })
      .catch((err) => { if (active) setError(err?.message || 'Could not load the takes'); });
    return () => { active = false; };
  }, [open, projectId, scene.sceneId, kind, hasOwnFrame]);

  // Typing searches the prompts each still and clip was made from, after a short pause.
  useEffect(() => {
    const q = query.trim();
    setMatches(null);
    if (!open || !q) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      searchMusicVideoMediaPool(projectId, q, { silent: true })
        .then((res) => { if (active) setMatches(new Set((res.items || []).map(poolKey))); })
        // A failed search leaves the matches on the prompts already shown here.
        .catch(() => { if (active) setMatches(new Set()); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [open, projectId, query]);

  const own = pool ? otherFrameItem(scene, kind) : null;
  // What already fills this slot isn't offered back; a frame other shots use is, marked with where it's used.
  const current = scene[SLOT_FIELD[kind]];
  const offered = pool ? pool.filter((item) => (!own || poolKey(item) !== poolKey(own)) && !(item.kind === POOL_KIND[kind] && item.assetId === current)) : [];
  const ofKind = pool ? filterPool([...(own ? [own] : []), ...offered],
    { kind: POOL_KIND[kind], query, shotNumbers, matches }) : [];
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
  // Tapping the active mark clears it.
  const toggleMark = (mark) => run(async () => {
    const next = picked.mark === mark ? null : mark;
    const result = await markMusicVideoPoolAssets(projectId, [{ kind: picked.kind, assetId: picked.assetId }], next, { silent: true });
    // Bad rejects its takes on the shots not using it; the board shows that at once.
    onMarked?.(result);
    setPool((prev) => prev.map((item) => (poolKey(item) === poolKey(picked) ? { ...item, mark: next } : item)));
    setPicked((prev) => ({ ...prev, mark: next }));
  });
  const remove = (targets) => run(async () => {
    const result = await deleteMusicVideoPoolAssets(projectId, targets.map(({ kind: k, assetId }) => ({ kind: k, assetId })), { silent: true });
    const settled = settlePoolDelete(result, targets);
    const { gone } = settled;
    setPool((prev) => applyPoolDelete(prev, settled));
    setPicked((prev) => (prev && gone.has(poolKey(prev)) ? null : prev));
    setConfirmDelete(null);
  });
  // A shot using it keeps it: the server refuses to delete it, so it's never offered.
  const badHere = markFilter === 'bad' ? items.filter((item) => !item.inUseBy?.length) : [];
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
          {!picked.ownFrame && usedLabel(picked, shotNumbers) && <p className="text-[11px] text-port-text-muted">{usedLabel(picked, shotNumbers)}</p>}
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
            {!picked.ownFrame && (<>
            <button type="button" disabled={working} onClick={() => toggleMark('ingredient')} aria-pressed={picked.mark === 'ingredient'}
              title="Good, not placed yet: keep it as an ingredient" className={`${ACTION} ${picked.mark === 'ingredient' ? 'border-port-warning text-port-warning' : ''}`}>
              <Star size={14} aria-hidden="true" />Ingredient
            </button>
            <button type="button" disabled={working} onClick={() => toggleMark('bad')} aria-pressed={picked.mark === 'bad'}
              title="Failed or unusable: clean it up later" className={`${ACTION} ${picked.mark === 'bad' ? 'border-port-error text-port-error' : ''}`}>
              <Ban size={14} aria-hidden="true" />Bad
            </button>
            {!picked.inUseBy?.length && (
            <button type="button" disabled={working} onClick={() => setConfirmDelete('picked')} className={ACTION}>
              <Trash2 size={14} aria-hidden="true" />Delete
            </button>
            )}
            </>)}
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
        <p className="text-xs text-port-text-muted">{query ? (matches ? `No ${itemNoun}s match.` : 'Searching prompts…') : `No ${itemNoun}s here.`}</p>
      )}
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8" aria-label={`${itemNoun[0].toUpperCase()}${itemNoun.slice(1)}s`}>
        {items.slice(0, shown).map((item) => {
          const number = item.sceneId ? shotNumbers.get(item.sceneId) : null;
          const selected = picked?.assetId === item.assetId;
          return (
            <li key={item.assetId}>
              <button type="button" onClick={() => setPicked(item)} aria-pressed={selected}
                aria-label={`${item.ownFrame ? `This shot's ${item.ownFrame.toLowerCase()}` : `${itemNoun}${number ? ` from shot ${number}` : ''}${usedLabel(item, shotNumbers) ? `, ${usedLabel(item, shotNumbers).toLowerCase()}` : ''}`}${item.prompt ? `: ${item.prompt.slice(0, 80)}` : ''}`}
                className={`relative block w-full overflow-hidden rounded border ${selected ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border'} ${item.mark === 'bad' ? 'opacity-50' : ''}`}>
                <img src={takeThumbUrl(item)} alt="" loading="lazy" className="block aspect-video w-full bg-black object-cover" />
                {(item.ownFrame || number) && <span className="port-media-overlay-strong absolute left-1 top-1 rounded px-1 text-[10px] leading-tight">{item.ownFrame || `#${number}`}</span>}
                {item.mark && (
                  <span className={`port-media-overlay-strong absolute right-1 top-1 rounded px-0.5 ${item.mark === 'bad' ? 'text-port-error' : 'text-port-warning'}`}>
                    {item.mark === 'bad' ? <Ban size={11} aria-label="bad" /> : <Star size={11} aria-label="ingredient" />}
                  </span>
                )}
                {item.pendingDelete && <span className="port-media-overlay-strong absolute bottom-6 left-1 rounded px-1 text-[10px] leading-tight text-port-warning">Delete pending</span>}
                {!item.ownFrame && item.inUseBy?.length > 0 && (
                  <span className="port-media-overlay-strong absolute bottom-1 left-1 rounded px-1 text-[10px] leading-tight">In use</span>
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

/** Inline "Delete … from the media library?" with Yes, delete and Keep. */
export function DeleteConfirm({ count, noun, working, onConfirm, onCancel }) {
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
