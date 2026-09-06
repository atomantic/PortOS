import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Clapperboard, FileText, Image as ImageIcon, Link2, Loader2, RefreshCw, Users, X,
} from 'lucide-react';
import { getWritersRoomSyncedReview } from '../../services/apiWritersRoom';
import { timeAgo } from '../../utils/formatters';
import useMounted from '../../hooks/useMounted';
import {
  DEPTH_META,
  FINDING_KIND_META,
  REVIEW_STATUS_META,
  humanizeIntegrityField,
} from '../../lib/characterIntegrity';

// Phase 4 synchronized review: prose ↔ script ↔ media ↔ cast in sync'd panes.
// Selecting any item highlights — and scrolls to — what it maps to in the
// other panes. The mapping + provenance is assembled server-side
// (GET /synced-review); see services/writersRoom/syncedReview.js.

const PANES = [
  { key: 'prose', label: 'Prose', icon: FileText },
  { key: 'script', label: 'Script', icon: Clapperboard },
  { key: 'media', label: 'Media', icon: ImageIcon },
  { key: 'cast', label: 'Cast', icon: Users },
];

const imgUrl = (ref) => `/data/images/${ref}`;

// The cast block a payload without one reads as. A work whose server predates
// the cast pane, or whose bible is empty, must render the same shape as a
// populated one rather than crashing a pane on a missing key.
const EMPTY_CAST = Object.freeze({
  available: false,
  findings: [],
  coverage: [],
  castCount: 0,
  reviewedCount: 0,
  semanticReviewedCount: 0,
  passed: false,
  staging: Object.freeze({ available: false, stale: false, stagedCount: 0, unstagedCount: 0, unmatchedNames: [] }),
});
const castOf = (data) => data?.cast || EMPTY_CAST;

// Scroll a pane's scroll container so the element tagged with `data-sync-id`
// lands near the top, WITHOUT scrolling the whole window (manual scrollTop
// rather than scrollIntoView, which walks every scrollable ancestor).
function scrollPaneTo(container, syncId) {
  if (!container || !syncId || typeof container.scrollTo !== 'function') return;
  // CSS.escape guards against ids with regex/selector metachars; fall back to a
  // raw match on the off chance the runtime lacks it (older WebViews).
  const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(syncId) : syncId;
  const el = container.querySelector(`[data-sync-id="${sel}"]`);
  if (!el) return;
  const top = el.offsetTop - container.offsetTop - 12;
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

// Derive the highlight sets for a selection. Each pane reads its own set; the
// selected item itself always highlights. Empty sets when nothing is selected.
function computeHighlights(data, selection) {
  const proseIds = new Set();
  const sceneIds = new Set();
  const mediaSceneIds = new Set(); // media items are keyed by their source sceneId
  const castIds = new Set();
  const highlights = { proseIds, sceneIds, mediaSceneIds, castIds };
  if (!data || !selection) return highlights;
  const sceneCast = (id) => (data.script.scenes.find((s) => s.id === id)?.castCharacterIds || []);
  if (selection.type === 'prose') {
    proseIds.add(selection.id);
    const seg = data.prose.segments.find((s) => s.id === selection.id);
    (seg?.scriptSceneIds || []).forEach((id) => sceneIds.add(id));
    (seg?.media || []).forEach((m) => mediaSceneIds.add(m.sceneId));
    (seg?.castCharacterIds || []).forEach((id) => castIds.add(id));
  } else if (selection.type === 'script') {
    sceneIds.add(selection.id);
    const sc = data.script.scenes.find((s) => s.id === selection.id);
    (sc?.proseSegmentIds || []).forEach((id) => proseIds.add(id));
    (sc?.castCharacterIds || []).forEach((id) => castIds.add(id));
    if (sc?.media) mediaSceneIds.add(selection.id);
  } else if (selection.type === 'media') {
    mediaSceneIds.add(selection.id);
    const item = data.media.items.find((m) => m.sceneId === selection.id);
    (item?.proseSegmentIds || []).forEach((id) => proseIds.add(id));
    if (item && !item.orphan) {
      sceneIds.add(selection.id);
      sceneCast(selection.id).forEach((id) => castIds.add(id));
    }
  } else if (selection.type === 'cast') {
    castIds.add(selection.id);
    const row = castOf(data).coverage.find((c) => c.characterId === selection.id);
    (row?.scriptSceneIds || []).forEach((id) => sceneIds.add(id));
    (row?.proseSegmentIds || []).forEach((id) => proseIds.add(id));
  }
  return highlights;
}

// The id the selection anchors on within `paneType`, or null when the selection
// lives in another pane. `computeHighlights` also adds the selected item to its
// own pane's highlight set, so without this the anchor card would be
// indistinguishable from the cards it links to.
function selectedIdFor(selection, paneType) {
  return selection?.type === paneType ? selection.id : null;
}

// Visual state for a card given the active selection: 'selected' | 'linked' |
// 'dim' | 'none'. Drives the ring/opacity so a selection reads at a glance.
function cardState(isSelected, isLinked, hasSelection) {
  if (isSelected) return 'selected';
  if (isLinked) return 'linked';
  return hasSelection ? 'dim' : 'none';
}

const CARD_CLASS = {
  selected: 'border-port-accent ring-1 ring-port-accent bg-port-accent/[0.06]',
  linked: 'border-port-accent/50 bg-port-accent/[0.03]',
  dim: 'border-port-border opacity-40',
  none: 'border-port-border',
};

export default function SyncedReview({ work }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selection, setSelection] = useState(null);
  const [visible, setVisible] = useState(() => new Set(['prose', 'script', 'media']));
  // Below `lg` the three panes collapse to one column, so only one is shown at a
  // time — stacking them inside the fixed-height, overflow-hidden grid pushed
  // Script and Media off-screen with nothing to scroll (#3566).
  const [mobilePane, setMobilePane] = useState('prose');
  const mountedRef = useMounted();

  const proseRef = useRef(null);
  const scriptRef = useRef(null);
  const mediaRef = useRef(null);
  const castRef = useRef(null);

  // Derived (not stored) so disabling the active pane on desktop can't leave the
  // narrow layout pointing at a pane that is no longer rendered.
  const activePane = visible.has(mobilePane) ? mobilePane : [...visible][0];

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getWritersRoomSyncedReview(work.id, { silent: true }).catch((err) => {
      if (mountedRef.current) setError(err.message || 'Failed to load review');
      return null;
    });
    if (!mountedRef.current) return;
    setLoading(false);
    if (result) setData(result);
  }, [work.id, mountedRef]);

  useEffect(() => {
    setData(null);
    setSelection(null);
    refresh();
  }, [refresh]);

  const { proseIds, sceneIds, mediaSceneIds, castIds } = useMemo(
    () => computeHighlights(data, selection),
    [data, selection],
  );
  const cast = castOf(data);
  // Findings grouped by character so a coverage row renders its own evidence.
  const findingsByCharacter = useMemo(() => {
    const map = new Map();
    for (const finding of cast.findings) {
      const own = map.get(finding.characterId) || [];
      own.push(finding);
      map.set(finding.characterId, own);
    }
    return map;
  }, [cast]);
  const castGapCount = cast.coverage.filter((row) => row.findingCount > 0).length;

  // Resolve prose segment ids → headings for provenance labels.
  const segHeading = useMemo(() => {
    const map = new Map();
    (data?.prose.segments || []).forEach((s) => map.set(s.id, s.heading || s.id));
    return map;
  }, [data]);

  // On selection, scroll the OTHER panes to the first mapped item. Below `lg`
  // the non-active panes are `display:none`, where offsetTop reads 0 and the
  // scroll no-ops — so this also re-runs when the narrow layout swaps panes,
  // landing the newly revealed pane on the mapped item rather than at the top.
  useEffect(() => {
    if (!selection || !data) return;
    if (selection.type !== 'prose' && proseIds.size) scrollPaneTo(proseRef.current, [...proseIds][0]);
    if (selection.type !== 'script' && sceneIds.size) scrollPaneTo(scriptRef.current, [...sceneIds][0]);
    if (selection.type !== 'media' && mediaSceneIds.size) scrollPaneTo(mediaRef.current, [...mediaSceneIds][0]);
    if (selection.type !== 'cast' && castIds.size) scrollPaneTo(castRef.current, [...castIds][0]);
  }, [selection, data, proseIds, sceneIds, mediaSceneIds, castIds, activePane]);

  const select = useCallback((type, id) => {
    setSelection((prev) => (prev && prev.type === type && prev.id === id ? null : { type, id }));
  }, []);

  const togglePane = useCallback((key) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size === 1) return prev; // keep at least one pane visible
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Picking a pane on mobile also re-enables it, so the narrow layout never
  // needs the (desktop-only) visibility toggles to reach a pane.
  const showPane = useCallback((key) => {
    setVisible((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setMobilePane(key);
  }, []);

  const hasSelection = !!selection;
  const visibleCount = [...visible].length;
  const colClass = visibleCount === 1 ? 'lg:grid-cols-1'
    : visibleCount === 2 ? 'lg:grid-cols-2'
      : visibleCount === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4';
  // Every pane renders; below `lg` all but the active one are display:none.
  const paneClass = (key) => `${key === activePane ? '' : 'hidden'} lg:block`;

  if (loading && !data) {
    return (
      <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading synced review…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-sm gap-3 px-6 text-center">
        <AlertTriangle size={20} className="text-port-error" />
        <div className="text-gray-400">{error}</div>
        <button onClick={refresh} className="flex items-center gap-1 px-3 py-1 rounded bg-port-bg border border-port-border text-gray-300 hover:text-white">
          <RefreshCw size={12} /> Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const noProse = data.prose.segments.length === 0;

  return (
    <div className="w-full h-full flex flex-col bg-port-bg min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-port-border bg-port-bg/60 shrink-0 flex-wrap">
        {/* Desktop: pick which panes sit side by side. */}
        <div className="hidden lg:flex items-center bg-port-card border border-port-border rounded p-0.5" role="group" aria-label="Visible panes">
          {PANES.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              aria-pressed={visible.has(key)}
              onClick={() => togglePane(key)}
              className={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded ${
                visible.has(key) ? 'bg-port-accent text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
              title={`Toggle ${label} pane`}
            >
              <Icon size={11} /> {label}
            </button>
          ))}
        </div>

        {/* Mobile: one column fits one pane — switch between them instead. */}
        <div className="flex lg:hidden items-center gap-1 flex-1 bg-port-card border border-port-border rounded p-0.5" role="group" aria-label="Active pane">
          {PANES.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              aria-pressed={key === activePane}
              onClick={() => showPane(key)}
              className={`flex flex-1 items-center justify-center gap-1 px-2 min-h-[44px] text-[11px] rounded ${
                key === activePane ? 'bg-port-accent text-white' : 'text-gray-400'
              }`}
              title={`Show ${label} pane`}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>

        {cast.available && (
          <button
            type="button"
            onClick={() => showPane('cast')}
            className={`flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border ${
              castGapCount > 0
                ? 'text-port-warning border-port-warning/40 hover:bg-port-warning/10'
                : 'text-gray-400 border-port-border hover:text-gray-200'
            }`}
            title={castGapCount > 0
              ? `${castGapCount} of ${cast.castCount} characters have unauthored framework fields — open the Cast pane.`
              : 'Every framework field is authored — which is not the same as the cast holding together. No model has read it. Open the Cast pane.'}
          >
            <Users size={10} /> {castGapCount > 0 ? `${castGapCount} cast gap${castGapCount === 1 ? '' : 's'}` : 'cast fields filled'}
          </button>
        )}

        {data.script.stale && (
          <span className="flex items-center gap-1 text-[10px] text-port-warning border border-port-warning/40 rounded px-1.5 py-0.5" title="The draft changed after this script was generated — re-run Adapt to refresh the mapping.">
            <AlertTriangle size={10} /> Script is stale
          </span>
        )}

        {hasSelection && (
          <button
            onClick={() => setSelection(null)}
            className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-white px-2 py-0.5 rounded border border-port-border"
            title="Clear selection"
          >
            <X size={11} /> Clear link
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {data.script.completedAt && (
            <span className="text-[10px] text-gray-500" title={`Provider: ${data.script.providerId || '—'} · Model: ${data.script.model || '—'}`}>
              script {timeAgo(data.script.completedAt, '')}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1 text-[11px] text-gray-300 hover:text-white px-2 py-0.5 rounded bg-port-card border border-port-border disabled:opacity-50"
            title="Reload mappings"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {noProse ? (
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm px-6 text-center">
          Nothing to review yet — switch to Edit, write some prose, and save. Run “Adapt” to generate the script mapping.
        </div>
      ) : (
        <div className={`flex-1 min-h-0 grid grid-cols-1 ${colClass} gap-px bg-port-border overflow-hidden`}>
          {visible.has('prose') && (
            <ProsePane
              className={paneClass('prose')}
              containerRef={proseRef}
              segments={data.prose.segments}
              proseIds={proseIds}
              selectedId={selectedIdFor(selection, 'prose')}
              hasSelection={hasSelection}
              onSelect={(id) => select('prose', id)}
            />
          )}
          {visible.has('script') && (
            <ScriptPane
              className={paneClass('script')}
              containerRef={scriptRef}
              script={data.script}
              sceneIds={sceneIds}
              selectedId={selectedIdFor(selection, 'script')}
              hasSelection={hasSelection}
              segHeading={segHeading}
              onSelect={(id) => select('script', id)}
            />
          )}
          {visible.has('media') && (
            <MediaPane
              className={paneClass('media')}
              containerRef={mediaRef}
              items={data.media.items}
              mediaSceneIds={mediaSceneIds}
              selectedId={selectedIdFor(selection, 'media')}
              hasSelection={hasSelection}
              segHeading={segHeading}
              onSelect={(sceneId) => select('media', sceneId)}
            />
          )}
          {visible.has('cast') && (
            <CastPane
              className={paneClass('cast')}
              containerRef={castRef}
              cast={cast}
              findingsByCharacter={findingsByCharacter}
              castIds={castIds}
              selectedId={selectedIdFor(selection, 'cast')}
              hasSelection={hasSelection}
              onSelect={(id) => select('cast', id)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Shared pane chrome: the scroll container + sticky header. Each pane passes
// its own item list (or empty state) as children.
function ScrollPane({ containerRef, className = '', paneKey, icon: Icon, label, count, children }) {
  return (
    <div ref={containerRef} data-pane={paneKey} className={`bg-port-bg overflow-y-auto min-h-0 ${className}`}>
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-wider text-gray-400 border-b border-port-border bg-port-card/60 sticky top-0 z-10">
        <Icon size={12} /> {label}
        <span className="text-gray-600">· {count}</span>
      </div>
      {children}
    </div>
  );
}

// ---- Prose pane ----
function ProsePane({ containerRef, className, segments, proseIds, selectedId, hasSelection, onSelect }) {
  return (
    <ScrollPane containerRef={containerRef} className={className} paneKey="prose" icon={FileText} label="Prose" count={segments.length}>
      <div className="p-3 space-y-2">
        {segments.map((seg) => {
          const state = cardState(seg.id === selectedId, proseIds.has(seg.id), hasSelection);
          return (
            <button
              key={seg.id}
              data-sync-id={seg.id}
              aria-pressed={state === 'selected'}
              onClick={() => onSelect(seg.id)}
              className={`w-full text-left rounded border px-3 py-2 transition-all ${CARD_CLASS[state]}`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[11px] font-medium text-gray-300 truncate">{seg.heading}</span>
                <span className="flex items-center gap-2 shrink-0 text-[10px] text-gray-500">
                  {seg.scriptSceneIds.length > 0 && (
                    <span className="flex items-center gap-0.5"><Clapperboard size={10} />{seg.scriptSceneIds.length}</span>
                  )}
                  {seg.media.length > 0 && (
                    <span className="flex items-center gap-0.5"><ImageIcon size={10} />{seg.media.length}</span>
                  )}
                </span>
              </div>
              <p className="text-[11px] text-gray-400 leading-snug line-clamp-3 whitespace-pre-wrap font-serif">{seg.text}</p>
            </button>
          );
        })}
      </div>
    </ScrollPane>
  );
}

// ---- Script pane ----
function ScriptPane({ containerRef, className, script, sceneIds, selectedId, hasSelection, segHeading, onSelect }) {
  return (
    <ScrollPane containerRef={containerRef} className={className} paneKey="script" icon={Clapperboard} label="Script" count={script.scenes.length}>
      {!script.available ? (
        <div className="p-4 text-[11px] text-gray-500 text-center">
          {script.status === 'failed'
            ? `Adapt failed: ${script.error}`
            : 'No script yet — run “Adapt” to extract scenes from the prose.'}
        </div>
      ) : (
        <div className="p-3 space-y-2">
          {script.scenes.map((sc) => {
            const state = cardState(sc.id === selectedId, sceneIds.has(sc.id), hasSelection);
            return (
              <button
                key={sc.id}
                data-sync-id={sc.id}
                aria-pressed={state === 'selected'}
                onClick={() => onSelect(sc.id)}
                className={`w-full text-left rounded border px-3 py-2 transition-all ${CARD_CLASS[state]}`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[11px] font-medium text-gray-200 truncate">{sc.heading || sc.id}</span>
                  {sc.media && <ImageIcon size={11} className="text-port-accent shrink-0" />}
                </div>
                {sc.slugline && <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{sc.slugline}</div>}
                {sc.summary && <p className="text-[11px] text-gray-400 leading-snug line-clamp-2">{sc.summary}</p>}
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {sc.proseSegmentIds.length > 0 ? (
                    sc.proseSegmentIds.map((pid) => (
                      <span key={pid} className="flex items-center gap-0.5 text-[9px] text-gray-400 bg-port-card border border-port-border rounded px-1 py-0.5">
                        <Link2 size={8} /> {segHeading.get(pid) || pid}
                      </span>
                    ))
                  ) : (
                    <span className="text-[9px] text-gray-600 italic">no mapped prose</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </ScrollPane>
  );
}

// ---- Media pane ----
function MediaPane({ containerRef, className, items, mediaSceneIds, selectedId, hasSelection, segHeading, onSelect }) {
  return (
    <ScrollPane containerRef={containerRef} className={className} paneKey="media" icon={ImageIcon} label="Media" count={items.length}>
      {items.length === 0 ? (
        <div className="p-4 text-[11px] text-gray-500 text-center">
          No rendered media yet — generate scene images from the Storyboard panel.
        </div>
      ) : (
        <div className="p-3 grid grid-cols-2 gap-2">
          {items.map((m) => {
            const state = cardState(m.sceneId === selectedId, mediaSceneIds.has(m.sceneId), hasSelection);
            return (
              <button
                key={`${m.sceneId}-${m.ref}`}
                data-sync-id={m.sceneId}
                aria-pressed={state === 'selected'}
                onClick={() => onSelect(m.sceneId)}
                className={`text-left rounded border overflow-hidden transition-all ${CARD_CLASS[state]}`}
              >
                <img src={imgUrl(m.ref)} alt={m.sceneHeading || 'scene render'} loading="lazy" className="w-full aspect-video object-cover bg-port-card" />
                <div className="px-2 py-1.5 space-y-0.5">
                  <div className="text-[10px] font-medium text-gray-300 truncate">
                    {m.orphan ? <span className="text-port-warning">source scene removed</span> : (m.sceneHeading || m.sceneId)}
                  </div>
                  {!m.orphan && m.proseSegmentIds.length > 0 && (
                    <div className="text-[9px] text-gray-500 truncate" title={m.proseSegmentIds.map((p) => segHeading.get(p) || p).join(', ')}>
                      from {m.proseSegmentIds.map((p) => segHeading.get(p) || p).join(', ')}
                    </div>
                  )}
                  {m.prompt && <div className="text-[9px] text-gray-600 line-clamp-2" title={m.prompt}>{m.prompt}</div>}
                  {m.generatedAt && <div className="text-[9px] text-gray-600">{timeAgo(m.generatedAt, '')}</div>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </ScrollPane>
  );
}

// ---- Cast pane ----
//
// The author-knowledge half of the review, kept visibly apart from the cold
// read beside it (see services/writersRoom/syncedReview.js):
//   - **Findings** are measured against the AUTHORED bible only. A character
//     the prose stages vividly still reports every unauthored field — an
//     interior that lives only in the author's head is the defect, not the fix.
//   - **Staged in** is what the script extraction saw, labelled as such. It
//     never closes a finding, and an unstaged character is reported as a fact
//     rather than flagged: writing someone who stays offstage is a choice.
//   - **Named only in the script** lists cold-read names with no bible entry.
//     They are not findings — there is no record to hang a field path on.
//
// Nothing here calls a provider, and the deterministic sweep alone never reads
// as a clean pass: the footer says so explicitly rather than leaving a cast
// with no gaps looking reviewed.
const BADGE_CLASS = 'inline-flex items-center px-1 py-0.5 rounded border text-[9px] uppercase tracking-wider';
const KIND_TONE = { amber: 'text-amber-300 border-amber-500/40', rose: 'text-rose-300 border-rose-500/40' };

function CastPane({ containerRef, className, cast, findingsByCharacter, castIds, selectedId, hasSelection, onSelect }) {
  const { staging } = cast;
  return (
    <ScrollPane containerRef={containerRef} className={className} paneKey="cast" icon={Users} label="Cast" count={cast.castCount}>
      {!cast.available ? (
        <div className="p-4 text-[11px] text-gray-500 text-center">
          No characters in this work’s bible yet — add them from the Cast panel, or run “Characters” to extract them from the draft.
        </div>
      ) : (
        <div className="p-3 space-y-2">
          {cast.coverage.map((row) => {
            const state = cardState(row.characterId === selectedId, castIds.has(row.characterId), hasSelection);
            const depth = DEPTH_META[row.depth] || DEPTH_META.full;
            const status = REVIEW_STATUS_META[row.status] || REVIEW_STATUS_META['not-reviewed'];
            const findings = findingsByCharacter.get(row.characterId) || [];
            return (
              <button
                key={row.characterId}
                data-sync-id={row.characterId}
                aria-pressed={state === 'selected'}
                onClick={() => onSelect(row.characterId)}
                className={`w-full text-left rounded border px-3 py-2 transition-all ${CARD_CLASS[state]}`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[11px] font-medium text-gray-200 truncate">{row.characterName || row.characterId}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    <span className={`${BADGE_CLASS} text-gray-400 border-port-border`} title={depth.hint}>{depth.label}</span>
                    <span
                      className={`${BADGE_CLASS} ${row.findingCount ? KIND_TONE.amber : 'text-gray-400 border-port-border'}`}
                      title={row.findingCount ? `${row.findingCount} unauthored field(s)` : 'Nothing unauthored at this depth.'}
                    >
                      {status.label}
                    </span>
                  </span>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap mb-1">
                  {row.staged ? (
                    <span className="flex items-center gap-0.5 text-[9px] text-gray-400 bg-port-card border border-port-border rounded px-1 py-0.5">
                      <Clapperboard size={8} /> staged in {row.scriptSceneIds.length}
                    </span>
                  ) : (
                    <span className="text-[9px] text-gray-600 italic" title={staging.available
                      ? 'No extracted scene names this character. Offstage is a choice, not a defect.'
                      : 'No script yet — run “Adapt” before reading anything into this.'}>
                      {staging.available ? 'not staged in the script' : 'staging unknown'}
                    </span>
                  )}
                </div>

                {findings.length > 0 && (
                  <ul className="space-y-1">
                    {findings.map((f) => {
                      const meta = FINDING_KIND_META[f.kind];
                      return (
                        <li key={f.id} className="text-[10px] text-gray-400 leading-snug">
                          <span className={`${BADGE_CLASS} mr-1 ${KIND_TONE[meta?.tone] || 'text-gray-400 border-port-border'}`} title={meta?.hint}>
                            {meta?.label || f.kind}
                          </span>
                          <span className="font-mono text-gray-300">{humanizeIntegrityField(f.field)}</span>
                          {f.evidence && <span className="text-gray-500"> — {f.evidence}</span>}
                          {f.suggestion && <span className="text-gray-500 italic"> {f.suggestion}</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </button>
            );
          })}

          {staging.unmatchedNames.length > 0 && (
            <div className="rounded border border-port-border bg-port-card/40 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Named only in the script</div>
              <div className="text-[10px] text-gray-400">{staging.unmatchedNames.join(', ')}</div>
              <div className="text-[9px] text-gray-600 mt-1">
                The scene extraction found these on the page but the bible has no entry for them. Add them to the Cast panel if they matter.
              </div>
            </div>
          )}

          <p className="text-[9px] text-gray-600 leading-snug pt-1">
            Deterministic pass only — no model has read this cast, so nothing here is a clean bill of health.
            {staging.stale && ' The draft changed after this script was generated, so the “staged in” counts are out of date.'}
          </p>
        </div>
      )}
    </ScrollPane>
  );
}
