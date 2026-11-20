import { useState, useCallback, useRef } from 'react';
import { Link } from 'react-router';
import { Download, ExternalLink, Sparkles, Check, Search, PlayCircle } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import Banner from '../ui/Banner';
import { formatCount } from '../../utils/formatters';
import { VIDEO_LORA_FAMILIES } from '../../lib/runnerFamilies';
import { searchVideoLoras } from '../../services/apiImageVideo.js';
import { RUNNER_BADGE_CLASS, RUNNER_LABEL, hfCardKey, pctOf } from './loraDisplay';

// Family filter for the live HuggingFace search below the curated list.
const VIDEO_FAMILY_FILTERS = [
  { id: 'all', label: 'All video' },
  { id: VIDEO_LORA_FAMILIES.LTX_VIDEO, label: 'LTX-Video' },
  { id: VIDEO_LORA_FAMILIES.MINIMAX_H3, label: 'MiniMax H3' },
];

// Curated HuggingFace video LoRAs (small hand-picked list, installed via the
// HF path) PLUS a live keyword/author/repository search across all of
// HuggingFace (#6500). Installed-state matches the exact repo+file pair
// because a repo may publish multiple independently installable LoRA
// versions, and a search result may offer more than one installable file.
export default function VideoSuggestionsSection({ cards, installedHfKeys, installingVideoKey, installingVideoProgress, videoInstallBusy, onInstall }) {
  const list = cards || [];
  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <h3 className="text-sm font-medium text-gray-300">Video LoRAs</h3>
        <span className="text-xs text-gray-600">{list.length}</span>
      </div>
      <p className="text-xs text-gray-500 mb-2">
        Curated LTX-Video LoRAs from HuggingFace — apply on an LTX-2 (ltx2) model in{' '}
        <Link to="/media/video" className="text-port-accent hover:underline">Video Gen</Link>.
      </p>
      {list.length === 0 ? (
        <p className="text-xs text-gray-600 italic">No video LoRA suggestions yet.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {list.map((card) => (
            <VideoSuggestionCard
              key={hfCardKey(card)}
              card={card}
              installedHfKeys={installedHfKeys}
              installingVideoKey={installingVideoKey}
              installingVideoProgress={installingVideoProgress}
              // Disable every quick-install button while ANY HF install is in
              // flight (this card's, another card's, or the form's) — one at a time.
              busy={!!installingVideoKey || videoInstallBusy}
              onInstall={onInstall}
            />
          ))}
        </div>
      )}
      <VideoSearchSection
        installedHfKeys={installedHfKeys}
        installingVideoKey={installingVideoKey}
        installingVideoProgress={installingVideoProgress}
        videoInstallBusy={videoInstallBusy}
        onInstall={onInstall}
      />
    </div>
  );
}

// Live search across all of HuggingFace for LTX-Video / MiniMax H3 LoRAs —
// the video counterpart to SuggestionsSection's per-runner Civitai search
// below. Kept as its own always-mounted subsection (not gated by the curated
// list) so a curated fetch failure never hides the search box.
function VideoSearchSection({ installedHfKeys, installingVideoKey, installingVideoProgress, videoInstallBusy, onInstall }) {
  const [family, setFamily] = useState('all');
  const [query, setQuery] = useState('');
  const [author, setAuthor] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [activeAuthor, setActiveAuthor] = useState('');
  // null = no search run yet (box not shown as "searched"); [] = a real empty result.
  const [items, setItems] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Bumped on every fetch; a response is applied only if it's still the LATEST
  // request — so switching family/query mid-flight can't have a slower older
  // response clobber a faster newer one.
  const requestIdRef = useRef(0);

  const fetchPage = useCallback((q, a, fam, { append, useCursor }) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    searchVideoLoras({ family: fam, query: q, author: a, cursor: useCursor, limit: 12 })
      .then((res) => {
        if (requestIdRef.current !== requestId) return; // superseded by a later request
        const results = res?.items || [];
        setCursor(res?.nextCursor || null);
        setActiveQuery(q);
        setActiveAuthor(a);
        setItems((prev) => {
          if (!append || prev === null) return results;
          const seen = new Set(prev.map(hfCardKey));
          return [...prev, ...results.filter((c) => !seen.has(hfCardKey(c)))];
        });
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        setError(err?.message || 'HuggingFace search failed');
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, []);

  const handleSearch = (e) => {
    e?.preventDefault?.();
    if (loading) return;
    fetchPage(query.trim(), author.trim(), family, { append: false, useCursor: null });
  };

  // Switching family re-runs whatever search is active (or the box's current
  // values pre-submit) under the new filter — otherwise the header/family
  // pills would show results from the family the user just left.
  const handleFamilyChange = (nextFamily) => {
    setFamily(nextFamily);
    if (items !== null) fetchPage(activeQuery, activeAuthor, nextFamily, { append: false, useCursor: null });
  };

  const clearSearch = () => {
    requestIdRef.current += 1; // invalidate any in-flight request
    setQuery(''); setAuthor(''); setActiveQuery(''); setActiveAuthor('');
    setItems(null); setCursor(null); setError(null); setLoading(false);
  };

  const loadMore = () => {
    if (loading) return;
    fetchPage(activeQuery, activeAuthor, family, { append: true, useCursor: cursor });
  };

  const retry = () => fetchPage(activeQuery, activeAuthor, family, { append: false, useCursor: null });

  const list = items || [];
  const hasSearched = items !== null;
  const canLoadMore = hasSearched && !error && cursor !== null;

  return (
    <div className="mt-4 pt-4 border-t border-port-border/60">
      <div className="flex items-baseline gap-3 mb-2">
        <h3 className="text-sm font-medium text-gray-300">Search HuggingFace</h3>
        {hasSearched && <span className="text-xs text-gray-600">{list.length}</span>}
      </div>
      <p className="text-xs text-gray-500 mb-2">
        Search all of HuggingFace for LTX-Video / MiniMax H3 LoRAs by name, author, or repository.
      </p>
      <form onSubmit={handleSearch} className="flex flex-wrap items-start gap-2 mb-3">
        <div className="inline-flex max-w-full rounded-lg border border-port-border overflow-hidden">
          {VIDEO_FAMILY_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => handleFamilyChange(f.id)}
              aria-pressed={family === f.id}
              className={`min-h-11 px-3 text-xs font-medium transition-colors ${
                family === f.id ? 'bg-port-accent text-white' : 'bg-port-card text-gray-400 hover:text-gray-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 basis-40 max-w-md">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or repository…"
            aria-label="Search HuggingFace video LoRAs by name or repository"
            className="min-h-11 w-full bg-port-bg border border-port-border rounded pl-8 pr-3 py-1.5 text-xs text-gray-200 placeholder:text-gray-600"
          />
        </div>
        <input
          type="text"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="Author (optional)"
          aria-label="Filter HuggingFace video LoRAs by author"
          className="min-h-11 w-32 max-w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-xs text-gray-200 placeholder:text-gray-600"
        />
        <button
          type="submit"
          disabled={loading}
          className="min-h-11 bg-port-accent/90 text-white px-3 rounded text-xs font-medium hover:bg-port-accent disabled:opacity-50"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
        {hasSearched && (
          <button
            type="button"
            onClick={clearSearch}
            className="min-h-11 px-3 rounded text-xs text-gray-400 hover:text-gray-200 border border-port-border"
          >
            Clear
          </button>
        )}
      </form>
      {error && (
        <Banner
          tone="error"
          size="sm"
          align="center"
          className="mb-3"
          actions={(
            <button type="button" onClick={retry} disabled={loading} className="underline hover:no-underline disabled:opacity-50">
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          )}
        >
          {error}
        </Banner>
      )}
      {hasSearched && !error && list.length === 0 && !loading && (
        <p className="text-xs text-gray-600 italic">No matching video LoRAs found on HuggingFace.</p>
      )}
      {list.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {list.map((card) => (
            <VideoSuggestionCard
              key={hfCardKey(card)}
              card={card}
              installedHfKeys={installedHfKeys}
              installingVideoKey={installingVideoKey}
              installingVideoProgress={installingVideoProgress}
              busy={!!installingVideoKey || videoInstallBusy}
              onInstall={onInstall}
            />
          ))}
        </div>
      )}
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

// Shared by the curated list and the live search. Owns its own install-key
// (repo+file) so a search card offering several `.safetensors` files can let
// the user pick one — `installingVideoKey`/`installedHfKeys` are matched
// against the CURRENTLY SELECTED file, not just the card's recommended
// default. Curated cards never carry more than one file, so this collapses
// to the original behavior for them.
function VideoSuggestionCard({ card, installedHfKeys, installingVideoKey, installingVideoProgress, busy, onInstall }) {
  const fileOptions = Array.isArray(card.files) && card.files.length > 1 ? card.files : null;
  const [selectedFile, setSelectedFile] = useState(card.file);
  const [showPreview, setShowPreview] = useState(false);
  const effectiveCard = fileOptions && selectedFile !== card.file ? { ...card, file: selectedFile } : card;
  const key = hfCardKey(effectiveCard);
  const installed = installedHfKeys?.has(key);
  const installing = installingVideoKey === key;
  const pct = pctOf(installing ? installingVideoProgress : null);
  const inputId = `hf-video-file-${key}`;
  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col">
      {showPreview && card.previewVideoUrl ? (
        // Mounted only after a click — the browser makes no network request
        // for the clip until the user asks for it, and `controls` (no
        // `autoPlay`) keeps playback itself opt-in too.
        <video
          src={card.previewVideoUrl}
          controls
          preload="none"
          referrerPolicy="no-referrer"
          className="w-full h-64 object-cover bg-black"
        />
      ) : card.previewImageUrl ? (
        <div className="relative">
          <img src={card.previewImageUrl} alt="" className="w-full h-64 object-cover bg-port-bg" loading="lazy" referrerPolicy="no-referrer" />
          {card.previewVideoUrl && (
            <button
              type="button"
              onClick={() => setShowPreview(true)}
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/40 text-white/90 hover:text-white transition-colors"
              aria-label="Play example clip"
              title="Play example clip"
            >
              <PlayCircle size={40} />
            </button>
          )}
        </div>
      ) : card.previewVideoUrl ? (
        <button
          type="button"
          onClick={() => setShowPreview(true)}
          className="min-h-11 min-w-11 w-full h-64 bg-port-bg flex items-center justify-center text-gray-600 hover:text-gray-400"
          aria-label="Play example clip"
          title="Play example clip"
        >
          <PlayCircle size={32} />
        </button>
      ) : (
        <div className="w-full h-64 bg-port-bg flex items-center justify-center text-gray-700">
          <Sparkles size={32} />
        </div>
      )}
      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-semibold text-white text-sm flex-1 break-words">{card.name}</h4>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${RUNNER_BADGE_CLASS[card.runnerFamily] || 'bg-gray-600/20 text-gray-300 border-gray-500/30'}`}>
            {RUNNER_LABEL[card.runnerFamily] || 'Video'}
          </span>
        </div>
        {card.note && <p className="text-[11px] text-gray-400 italic break-words">{card.note}</p>}
        {typeof card.downloads === 'number' && (
          <div className="text-[10px] text-gray-600">↓ {formatCount(card.downloads)}</div>
        )}
        {card.description && (
          <details className="text-[11px] text-gray-500">
            <summary className="cursor-pointer hover:text-gray-300">Details</summary>
            <p className="mt-1 text-[10px] leading-snug bg-port-bg p-1.5 rounded border border-port-border line-clamp-4">{card.description}</p>
          </details>
        )}
        {fileOptions && (
          <div>
            <label htmlFor={inputId} className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">File</label>
            <select
              id={inputId}
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
              disabled={installed || installing}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200"
            >
              {fileOptions.map((f) => (
                <option key={f.file} value={f.file}>{f.file}{f.recommended ? ' (recommended)' : ''}</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-2 mt-auto">
          {installed ? (
            <button disabled className="flex-1 bg-port-success/20 text-port-success border border-port-success/30 px-3 py-1.5 rounded text-xs font-medium flex items-center justify-center gap-1">
              <Check size={12} /> Installed
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onInstall(effectiveCard)}
              disabled={installing || busy}
              className="flex-1 bg-port-accent text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {installing ? (pct != null ? `Installing ${pct}%` : 'Installing…') : 'Quick install'}
            </button>
          )}
        </div>
        {card.hfUrl && (
          <a href={card.hfUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 self-start" title="Open on HuggingFace">
            <ExternalLink size={11} /> View on HuggingFace
          </a>
        )}
      </div>
    </div>
  );
}
