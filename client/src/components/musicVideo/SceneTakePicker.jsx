import { useEffect, useState } from 'react';
import { X, Search, Film, Activity } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import TabPills from '../ui/TabPills.jsx';
import { getMusicVideoMediaPool } from '../../services/apiMusicVideo.js';
import { takeThumbUrl, takeClipUrl } from '../../lib/musicVideoTakes.js';
import { formatCount } from '../../utils/formatters.js';

const PAGE = 60;
const SLOT_NOUN = { image: 'still', video: 'clip' };

/** Which tab a pool item belongs on for this shot: its own takes, another shot's, or the floor. */
export const poolGroup = (item, sceneId) => (!item.sceneId ? 'floor' : item.sceneId === sceneId ? 'shot' : 'others');

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
 * `onPlace({ kind, assetId, withAssetId? })` puts it on the shot.
 */
export default function SceneTakePicker({ open, onClose, projectId, scene, kind, shotNumbers = new Map(), onPlace, busy = false }) {
  const [pool, setPool] = useState(null);
  const [error, setError] = useState(null);
  const [group, setGroup] = useState('shot');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setPool(null); setError(null); setPicked(null); setQuery(''); setShown(PAGE);
    getMusicVideoMediaPool(projectId, { silent: true })
      .then((res) => {
        if (!active) return;
        const items = res.items || [];
        setPool(items);
        // Open on the first tab that has anything in it.
        const groups = new Set(items.filter((item) => item.kind === kind).map((item) => poolGroup(item, scene.sceneId)));
        setGroup(['shot', 'others', 'floor'].find((g) => groups.has(g)) || 'shot');
      })
      .catch((err) => { if (active) setError(err?.message || 'Could not load the unused takes'); });
    return () => { active = false; };
  }, [open, projectId, scene.sceneId, kind]);

  const ofKind = pool ? filterPool(pool, { kind, query, shotNumbers }) : [];
  const counts = { shot: 0, others: 0, floor: 0 };
  for (const item of ofKind) counts[poolGroup(item, scene.sceneId)] += 1;
  const activeGroup = group;
  const items = ofKind.filter((item) => poolGroup(item, scene.sceneId) === activeGroup);
  const noun = SLOT_NOUN[kind];
  const shotName = shotNumbers.get(scene.sceneId) ? `Shot ${shotNumbers.get(scene.sceneId)}` : 'this shot';
  const partner = picked && (kind === 'image' ? picked.clipIds?.[0] : picked.sourceImageId) || null;
  const place = (withAssetId) => Promise.resolve(onPlace?.({ kind, assetId: picked.assetId, ...(withAssetId ? { withAssetId } : {}) }))
    .then(() => onClose?.());

  return (
    <Modal open={open} onClose={onClose} size="2xl" align="top" usePortal ariaLabel={`Swap ${noun} for ${shotName}`}
      panelClassName="bg-port-card border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">Swap {noun} · {shotName}</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded sm:min-h-0 sm:min-w-0 sm:p-1">
          <X size={16} />
        </button>
      </div>
      <TabPills activeTab={activeGroup} onChange={(id) => { setGroup(id); setShown(PAGE); setPicked(null); }}
        tabs={[{ id: 'shot', label: 'This shot', count: counts.shot }, { id: 'others', label: 'Other shots', count: counts.others }, { id: 'floor', label: 'Floor', count: counts.floor }]} />
      <label htmlFor={`mv-pool-search-${scene.sceneId}`} className="flex items-center gap-2 rounded border border-port-border bg-port-bg px-2">
        <Search size={14} aria-hidden="true" className="shrink-0 text-port-text-muted" />
        <span className="sr-only">Search prompts or shot number</span>
        <input id={`mv-pool-search-${scene.sceneId}`} type="search" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
          placeholder="Search prompts or shot #" className="min-h-[44px] min-w-0 flex-1 bg-transparent text-sm outline-none sm:min-h-[32px]" />
      </label>
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
              <button type="button" disabled={busy} onClick={() => place(partner)}
                className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-3 text-xs disabled:opacity-50 sm:min-h-[32px]">
                Use {noun} + its {kind === 'image' ? 'clip' : 'still'}
              </button>
            )}
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      {!pool && !error && <p className="flex items-center gap-2 text-xs text-port-text-muted"><Activity size={14} className="animate-spin" />Gathering every {noun} made for this video…</p>}
      {pool && items.length === 0 && (
        <p className="text-xs text-port-text-muted">{query ? `No unused ${noun}s match.` : `No unused ${noun}s here.`}</p>
      )}
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-label={`Unused ${noun}s`}>
        {items.slice(0, shown).map((item) => {
          const number = item.sceneId ? shotNumbers.get(item.sceneId) : null;
          const selected = picked?.assetId === item.assetId;
          return (
            <li key={item.assetId}>
              <button type="button" onClick={() => setPicked(item)} aria-pressed={selected}
                aria-label={`${noun}${number ? ` from shot ${number}` : ''}${item.prompt ? `: ${item.prompt.slice(0, 80)}` : ''}`}
                className={`relative block w-full overflow-hidden rounded border ${selected ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border'} ${item.takeStatus === 'rejected' ? 'opacity-60' : ''}`}>
                <img src={takeThumbUrl(item)} alt="" loading="lazy" className="block aspect-video w-full bg-black object-cover" />
                {number && <span className="port-media-overlay-strong absolute left-1 top-1 rounded px-1 text-[10px] leading-tight">#{number}</span>}
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
        <button type="button" onClick={() => setShown((n) => n + PAGE)}
          className="w-full min-h-[44px] rounded border border-port-border text-xs sm:min-h-[32px]">
          Show more ({formatCount(items.length - shown)} left)
        </button>
      )}
    </Modal>
  );
}
