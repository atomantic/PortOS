import { useState, useEffect, useCallback, useRef } from 'react';
import { Download, ExternalLink, Sparkles, Check, RefreshCw, Wand2, Search } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import { formatCount } from '../../utils/formatters';
import { RUNNER_FAMILIES } from '../../lib/runnerFamilies';
import { searchCivitaiLoras } from '../../services/apiImageVideo.js';
import VideoSuggestionsSection from './VideoLoraSuggestions';
import { RUNNER_BADGE_CLASS, RUNNER_LABEL, cardKey, suggestionKey } from './loraDisplay';

export default function SuggestionsPanel({ suggestions, loading, mediaFilter = 'all', installedFilenames, installedHfKeys, installingSuggestionKey, installingVideoKey, installingVideoProgress, videoInstallBusy, onRefresh, onInstall, onInstallVideo }) {
  const curated = suggestions?.curated || [];
  const runners = suggestions?.runners || {};
  const video = suggestions?.video || [];
  const showImage = mediaFilter !== 'video';
  const showVideo = mediaFilter !== 'image';
  const sections = [
    { key: 'curated', label: 'Curated picks', cards: curated, hint: 'Hand-picked LoRAs that work across multiple base models.' },
    // The runner-family sections always render, even when Civitai search
    // returns zero — `alwaysShow` lets the user see every base-model header at
    // a glance instead of silently collapsing the empty ones. `runner` (the
    // family key) marks the section as searchable + paginated; it's tracked
    // separately from `alwaysShow` so the two concerns can't accidentally couple.
    { key: RUNNER_FAMILIES.MFLUX,   runner: RUNNER_FAMILIES.MFLUX,   label: 'Top for Flux 1',  cards: runners[RUNNER_FAMILIES.MFLUX] || [],   hint: 'Most-downloaded LoRAs trained against Flux.1 D / Flux.1 S.', alwaysShow: true },
    { key: RUNNER_FAMILIES.FLUX2,   runner: RUNNER_FAMILIES.FLUX2,   label: 'Top for Flux 2',  cards: runners[RUNNER_FAMILIES.FLUX2] || [],   hint: 'Most-downloaded LoRAs trained against Flux.2 Klein 4B / 9B.', alwaysShow: true },
    { key: RUNNER_FAMILIES.Z_IMAGE, runner: RUNNER_FAMILIES.Z_IMAGE, label: 'Top for Z-Image', cards: runners[RUNNER_FAMILIES.Z_IMAGE] || [], hint: 'Most-downloaded LoRAs trained against Z-Image / Z-Image-Turbo.', alwaysShow: true },
    { key: RUNNER_FAMILIES.ERNIE,   runner: RUNNER_FAMILIES.ERNIE,   label: 'Top for ERNIE',   cards: runners[RUNNER_FAMILIES.ERNIE] || [],   hint: 'Most-downloaded LoRAs trained against ERNIE-Image.', alwaysShow: true },
    { key: RUNNER_FAMILIES.HIDREAM, runner: RUNNER_FAMILIES.HIDREAM, label: 'Top for HiDream', cards: runners[RUNNER_FAMILIES.HIDREAM] || [], hint: 'Most-downloaded LoRAs trained against HiDream.', alwaysShow: true },
    { key: RUNNER_FAMILIES.QWEN,    runner: RUNNER_FAMILIES.QWEN,    label: 'Top for Qwen',    cards: runners[RUNNER_FAMILIES.QWEN] || [],    hint: 'Most-downloaded LoRAs trained against Qwen-Image.', alwaysShow: true },
  ];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Wand2 size={18} className="text-port-accent" />
          Suggested LoRAs
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1 disabled:opacity-50"
          title="Re-fetch from Civitai (busts the 1-hour cache)"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
      {loading && !suggestions && (
        <div className="text-sm text-gray-500">Loading suggestions…</div>
      )}
      {showImage && sections.map((section) => (
        <SuggestionsSection
          key={section.key}
          label={section.label}
          hint={section.hint}
          cards={section.cards}
          alwaysShow={section.alwaysShow}
          // Runner-family sections carry a `runner` key → keyword search box +
          // "Load more" pagination; the curated section has none and stays static.
          runner={section.runner || null}
          resetSignal={suggestions?.fetchedAt}
          installedFilenames={installedFilenames}
          installingSuggestionKey={installingSuggestionKey}
          onInstall={onInstall}
        />
      ))}
      {showVideo && (
        <VideoSuggestionsSection
          cards={video}
          installedHfKeys={installedHfKeys}
          installingVideoKey={installingVideoKey}
          installingVideoProgress={installingVideoProgress}
          videoInstallBusy={videoInstallBusy}
          onInstall={onInstallVideo}
        />
      )}
    </div>
  );
}

function SuggestionsSection({ label, hint, cards, alwaysShow = false, runner = null, resetSignal, installedFilenames, installingSuggestionKey, onInstall }) {
  const baseCards = cards || [];
  const searchable = !!runner;

  // Live state for keyword search + "Load more" pagination. `liveCards === null`
  // means we're showing the cached top-N from props; once the user searches or
  // pages, we switch to the live list. `activeQuery` is the last submitted
  // keyword ('' = top ranking); `cursor` is Civitai's next-page token.
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [liveCards, setLiveCards] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  // Drop any live search/pagination so the section falls back to the cached
  // top-N. Shared by Clear, the empty-box submit, and the Refresh effect.
  // Stable identity (setters never change) so the effect can depend on it.
  const resetToCached = useCallback(() => {
    requestIdRef.current += 1;
    setActiveQuery(''); setLiveCards(null); setCursor(null);
    setLoading(false);
  }, []);

  // A global Refresh (new fetchedAt) re-seeds the cached top-N — drop live
  // results so the section doesn't show stale ones under the new header. Also
  // fires once harmlessly on mount (all setters are no-ops at their defaults).
  useEffect(() => { setQuery(''); resetToCached(); }, [resetSignal, resetToCached]);

  const fetchPage = useCallback(async (q, { append, useCursor }) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    await searchCivitaiLoras({ runner, query: q, cursor: useCursor, limit: 12 })
      .then((res) => {
        if (requestIdRef.current !== requestId) return;
        const items = res?.items || [];
        setCursor(res?.nextCursor || null);
        setActiveQuery(q);
        setLiveCards((prev) => {
          if (!append || prev === null) return items;
          // Dedup by modelId-versionId — re-fetched leaders can repeat.
          const seen = new Set(prev.map(cardKey));
          return [...prev, ...items.filter((c) => !seen.has(cardKey(c)))];
        });
      })
      .catch((err) => {
        if (requestIdRef.current === requestId) toast.error(err?.message || 'Civitai search failed');
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, [runner]);

  const handleSearch = (e) => {
    e?.preventDefault?.();
    if (loading) return; // Enter while a fetch is in flight → no overlapping requests
    const q = query.trim();
    if (!q) { resetToCached(); return; } // empty box → cached top-N
    fetchPage(q, { append: false, useCursor: null });
  };

  const clearSearch = () => { setQuery(''); resetToCached(); };

  const loadMore = () => {
    if (loading) return;
    // First click from the cached view fetches page 1 live (top ranking or the
    // active query); later clicks page forward with the cursor.
    if (liveCards === null) fetchPage(activeQuery, { append: false, useCursor: null });
    else fetchPage(activeQuery, { append: true, useCursor: cursor });
  };

  const list = liveCards !== null ? liveCards : baseCards;
  // "Load more" is available until we've gone live AND Civitai reports no
  // further cursor. In the cached view we assume more exists (only top-4 shown).
  const canLoadMore = searchable && (liveCards === null || cursor !== null);

  if (list.length === 0 && !alwaysShow && !searchable) return null;
  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <h3 className="text-sm font-medium text-gray-300">{label}</h3>
        <span className="text-xs text-gray-600">{list.length}</span>
        {activeQuery && (
          <span className="text-xs text-port-accent">results for “{activeQuery}”</span>
        )}
      </div>
      {hint && <p className="text-xs text-gray-500 mb-2">{hint}</p>}
      {searchable && (
        <form onSubmit={handleSearch} className="flex flex-wrap items-start gap-2 mb-3">
          <div className="relative min-w-0 flex-1 basis-40 max-w-md">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${RUNNER_LABEL[runner] || runner} LoRAs on Civitai…`}
              aria-label={`Search ${RUNNER_LABEL[runner] || runner} LoRAs on Civitai`}
              className="min-h-11 w-full bg-port-bg border border-port-border rounded pl-8 pr-3 py-1.5 text-xs text-gray-200 placeholder:text-gray-600"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="min-h-11 bg-port-accent/90 text-white px-3 rounded text-xs font-medium hover:bg-port-accent disabled:opacity-50"
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
          {activeQuery && (
            <button
              type="button"
              onClick={clearSearch}
              className="min-h-11 px-3 rounded text-xs text-gray-400 hover:text-gray-200 border border-port-border"
              title="Clear search — back to top ranking"
            >
              Clear
            </button>
          )}
        </form>
      )}
      {list.length === 0 ? (
        <p className="text-xs text-gray-600 italic">
          {activeQuery
            ? `No LoRAs match “${activeQuery}” for this base model${canLoadMore ? ' on this page — try Load more.' : '.'}`
            : 'No LoRAs found on Civitai for this base model yet.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {list.map((card) => (
            <SuggestionCard
              key={cardKey(card)}
              card={card}
              installedFilenames={installedFilenames}
              installingSuggestionKey={installingSuggestionKey}
              onInstall={onInstall}
            />
          ))}
        </div>
      )}
      {/* "Load more" sits OUTSIDE the empty/non-empty branch on purpose: a live
          Civitai page can come back empty yet carry a nextCursor (later pages
          hold matches for some keyword + base-model combos), so the control
          must stay reachable to advance past empty pages instead of trapping
          the user on a false "no matches" state. */}
      {canLoadMore && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="text-xs text-gray-300 hover:text-white px-4 py-1.5 rounded border border-port-border hover:border-port-accent/40 disabled:opacity-50 flex items-center gap-1.5"
          >
            {loading ? <BrailleSpinner text="Loading…" /> : <><Download size={12} /> Load more</>}
          </button>
        </div>
      )}
    </div>
  );
}

function SuggestionCard({ card, installedFilenames, installingSuggestionKey, onInstall }) {
  const installs = card.curated && card.installs && Object.keys(card.installs).length > 0 ? card.installs : null;
  // Badges: prefer the installs map's keys (per-family with versions), else
  // the runnerFamilies array, else the single primary-version family.
  const badgeFamilies = installs
    ? Object.keys(installs)
    : (Array.isArray(card.runnerFamilies) && card.runnerFamilies.length
      ? card.runnerFamilies
      : (card.runnerFamily ? [card.runnerFamily] : []));
  const isInstalled = (versionId) => versionId != null
    && [...installedFilenames].some((f) => f.endsWith(`-v${versionId}.safetensors`));
  const isInstalling = (versionId) => installingSuggestionKey === suggestionKey(card.modelId, versionId);
  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col">
      {card.previewImageUrl ? (
        <img src={card.previewImageUrl} alt="" className="w-full h-64 object-cover bg-port-bg" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="w-full h-64 bg-port-bg flex items-center justify-center text-gray-700">
          <Sparkles size={32} />
        </div>
      )}
      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-semibold text-white text-sm flex-1 break-words">{card.name}</h4>
          {card.curated && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-port-warning/20 text-port-warning border border-port-warning/30 whitespace-nowrap">curated</span>
          )}
        </div>
        {badgeFamilies.length > 0 && !installs && (
          <div className="flex flex-wrap gap-1">
            {badgeFamilies.map((f) => (
              <span key={f} className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${RUNNER_BADGE_CLASS[f] || 'bg-gray-600/20 text-gray-300 border-gray-500/30'}`}>
                {RUNNER_LABEL[f] || f}
              </span>
            ))}
          </div>
        )}
        {card.note && <p className="text-[11px] text-gray-400 italic break-words">{card.note}</p>}
        {card.samplePrompt && (
          <details className="text-[11px] text-gray-500">
            <summary className="cursor-pointer hover:text-gray-300">Sample prompt</summary>
            <p className="mt-1 font-mono text-[10px] leading-snug bg-port-bg p-1.5 rounded border border-port-border line-clamp-4">{card.samplePrompt}</p>
          </details>
        )}
        <div className="text-[10px] text-gray-600 flex items-center gap-3 mt-auto">
          {card.creator && <span className="truncate" title={card.creator}>by {card.creator}</span>}
          {typeof card.downloads === 'number' && <span>↓ {formatCount(card.downloads)}</span>}
        </div>
        {installs ? (
          <div className="flex flex-col gap-1">
            <p className="text-[10px] uppercase tracking-wide text-gray-500">Install for</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(installs).map(([family, info]) => {
                const installed = isInstalled(info.versionId);
                const installing = isInstalling(info.versionId);
                const baseClass = installed
                  ? 'bg-port-success/20 text-port-success border-port-success/30'
                  : (RUNNER_BADGE_CLASS[family] || 'bg-port-accent/20 text-port-accent border-port-accent/30');
                return (
                  <button
                    key={family}
                    type="button"
                    onClick={() => onInstall(card, info.installUrl, info.versionId)}
                    disabled={installed || installing}
                    title={installed ? 'Already installed' : `Install ${info.baseModel || family} version`}
                    className={`text-[11px] px-2 py-1 rounded border flex items-center gap-1 ${baseClass} hover:brightness-125 disabled:opacity-60 disabled:cursor-not-allowed`}
                  >
                    {installed ? <Check size={11} /> : null}
                    {installing ? 'Installing…' : (RUNNER_LABEL[family] || family)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {isInstalled(card.versionId) ? (
              <button disabled className="flex-1 bg-port-success/20 text-port-success border border-port-success/30 px-3 py-1.5 rounded text-xs font-medium flex items-center justify-center gap-1">
                <Check size={12} /> Installed
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onInstall(card, card.installUrl, card.versionId)}
                disabled={isInstalling(card.versionId)}
                className="flex-1 bg-port-accent text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-port-accent/90 disabled:opacity-50"
              >
                {isInstalling(card.versionId) ? 'Installing…' : 'Quick install'}
              </button>
            )}
          </div>
        )}
        {card.civitaiUrl && (
          <a href={card.civitaiUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 self-start" title="Open on Civitai">
            <ExternalLink size={11} /> View on Civitai
          </a>
        )}
      </div>
    </div>
  );
}
