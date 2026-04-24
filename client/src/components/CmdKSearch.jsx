import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Brain, Cpu, Package, History, HeartPulse, Search, Loader2, Navigation, Play } from 'lucide-react';
import { useCmdKSearch } from '../hooks/useCmdKSearch';
import { useScrollLock } from '../hooks/useScrollLock';
import { search, getPaletteManifest, runPaletteAction } from '../services/api';
import toast from './ui/Toast';
import { modKey } from '../utils/platform';

const ICON_MAP = { Brain, Cpu, Package, History, HeartPulse };

// Cheap subsequence-based fuzzy scorer. No new deps. Ranks:
//   1. exact label match (highest)
//   2. label starts-with
//   3. alias exact match
//   4. keyword contains
//   5. subsequence over label
const scoreCommand = (cmd, q) => {
  if (!q) return 0;
  const label = (cmd.label || '').toLowerCase();
  const aliases = (cmd.aliases || []).map((a) => a.toLowerCase());
  const keywords = (cmd.keywords || []).map((k) => k.toLowerCase());
  const section = (cmd.section || '').toLowerCase();

  if (label === q) return 1000;
  if (label.startsWith(q)) return 800 - (label.length - q.length);
  if (aliases.includes(q)) return 750;
  if (label.includes(q)) return 500;
  if (aliases.some((a) => a.includes(q))) return 400;
  if (keywords.some((k) => k.includes(q))) return 300;
  if (section.includes(q)) return 150;
  // Subsequence fallback: every character in q appears in order inside label.
  let i = 0;
  for (const ch of label) if (ch === q[i]) i += 1;
  return i === q.length ? 100 + i : 0;
};

function Highlight({ text, query }) {
  if (!query || !text) return <span>{text}</span>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-port-accent/30 text-white rounded px-0.5 not-italic">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </span>
  );
}

export default function CmdKSearch() {
  const { open, setOpen } = useCmdKSearch();
  const navigate = useNavigate();
  const inputRef = useRef(null);

  const [query, setQuery] = useState('');
  const [manifest, setManifest] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [expandedSources, setExpandedSources] = useState(new Set());
  const [running, setRunning] = useState(false);
  const resultRefs = useRef([]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useScrollLock(open);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSearchResults([]);
      setFocusedIndex(0);
      setExpandedSources(new Set());
    }
  }, [open]);

  // Lazy-load the palette manifest on first open and cache for the session.
  // The manifest rarely changes; re-fetching on every open wastes a roundtrip.
  useEffect(() => {
    if (!open || manifest) return;
    getPaletteManifest()
      .then((data) => setManifest(data))
      .catch(() => setManifest({ nav: [], actions: [] }));
  }, [open, manifest]);

  useEffect(() => {
    if (query.length < 2) {
      setSearchResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      search(query)
        .then((data) => setSearchResults(data?.sources ?? []))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setFocusedIndex(0);
  }, [searchResults, query]);

  const { navHits, actionHits } = useMemo(() => {
    if (!manifest) return { navHits: [], actionHits: [] };
    const q = query.trim().toLowerCase();
    if (!q) {
      // Default view: a curated set of "most useful" nav + actions so Enter
      // on empty query has meaning instead of doing nothing.
      const curatedNav = manifest.nav
            .filter((c) => ['nav.dashboard', 'nav.brain.inbox', 'nav.cos.tasks', 'nav.goals', 'nav.review-hub'].includes(c.id));
      const curatedActions = manifest.actions
            .filter((a) => ['brain_capture', 'time_now', 'goal_list', 'meatspace_summary_today'].includes(a.id));
      return { navHits: curatedNav, actionHits: curatedActions };
    }
    const scoredNav = manifest.nav
      .map((c) => ({ cmd: c, score: scoreCommand(c, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.cmd);
    const scoredActions = manifest.actions
      .map((a) => ({ cmd: a, score: scoreCommand(a, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.cmd);
    return { navHits: scoredNav, actionHits: scoredActions };
  }, [manifest, query]);

  const flatCommands = useMemo(
    () => [
      ...navHits.map((c) => ({ kind: 'nav', ...c })),
      ...actionHits.map((a) => ({ kind: 'action', ...a })),
    ],
    [navHits, actionHits]
  );

  const flatSearchResults = useMemo(
    () =>
      searchResults.flatMap((source) => {
        const isExpanded = expandedSources.has(source.id);
        const visible = isExpanded ? source.results : source.results.slice(0, 3);
        return visible.map((r) => ({ ...r, kind: 'search', sourceId: source.id }));
      }),
    [searchResults, expandedSources]
  );

  const combined = useMemo(() => [...flatCommands, ...flatSearchResults], [flatCommands, flatSearchResults]);

  useEffect(() => {
    const el = resultRefs.current[focusedIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const dispatchCommand = useCallback(async (item) => {
    if (item.kind === 'nav') {
      navigate(item.path);
      close();
      return;
    }
    if (item.kind === 'action') {
      // Actions with required args can't be run blind from the palette — the
      // parameters schema is served with the manifest for future inline arg
      // UIs. For v1, only dispatch tools whose required list is empty. For
      // others, offer a hint toast telling the user to use voice or the
      // relevant page.
      const required = item.parameters?.required || [];
      if (required.length > 0) {
        toast(`${item.label} needs arguments — use voice or open the related page.`);
        return;
      }
      setRunning(true);
      const res = await runPaletteAction(item.id).catch((e) => ({ error: e.message }));
      setRunning(false);
      const summary = res?.result?.summary || res?.error || `${item.label} ran.`;
      if (res?.ok === false || res?.error) toast.error(summary);
      else toast.success(summary);
      close();
      return;
    }
    if (item.kind === 'search') {
      navigate(item.url);
      close();
    }
  }, [navigate, close]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (combined.length > 0) setFocusedIndex((i) => Math.min(i + 1, combined.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (combined.length > 0) setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const item = combined[focusedIndex];
      if (item) dispatchCommand(item);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  if (!open) return null;

  let flatIdx = 0;

  const renderCommandRow = (item, kindLabel) => {
    const currentIdx = flatIdx++;
    const isFocused = focusedIndex === currentIdx;
    const Icon = item.kind === 'nav' ? Navigation : Play;
    const subtitle = item.kind === 'nav'
      ? `${item.section} · ${item.path}`
      : (item.description ? item.description.slice(0, 80) : item.section || '');
    return (
      <div
        key={`${item.kind}:${item.id}`}
        ref={(el) => { resultRefs.current[currentIdx] = el; }}
        onClick={() => dispatchCommand(item)}
        className={`flex items-start gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
          isFocused ? 'bg-port-accent/10' : 'hover:bg-white/5'
        }`}
        role="option"
        aria-selected={isFocused}
      >
        <Icon size={14} className="shrink-0 mt-0.5 text-gray-400" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">
            <Highlight text={item.label} query={query} />
          </p>
          {subtitle && (
            <p className="text-xs text-gray-500 truncate mt-0.5">{subtitle}</p>
          )}
        </div>
        <span className="text-[10px] uppercase tracking-wide text-gray-500 shrink-0 mt-1">{kindLabel}</span>
      </div>
    );
  };

  const overlay = (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-[10vh]"
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={close}
        aria-hidden="true"
      />

      <div className="relative w-full max-w-3xl mx-4 bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-4 border-b border-port-border">
          <Search size={18} className="text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Go to page, run an action, or search Brain / Memory / Apps…"
            className="flex-1 bg-transparent text-white placeholder-gray-500 outline-hidden text-sm"
            aria-label="Command palette"
          />
          {running && <Loader2 size={14} className="animate-spin text-gray-400 shrink-0" />}
          <span className="text-xs text-gray-500 border border-port-border rounded px-1.5 py-0.5 shrink-0">
            {`${modKey}+K`}
          </span>
        </div>

        <div className="max-h-96 overflow-y-auto p-2">
          {/* Commands: Navigate */}
          {navHits.length > 0 && (
            <div className="mb-2">
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400 uppercase tracking-wide">
                <Navigation size={14} />
                <span>Go to</span>
              </div>
              {navHits.map((c) => renderCommandRow({ kind: 'nav', ...c }, 'GO'))}
            </div>
          )}

          {/* Commands: Run */}
          {actionHits.length > 0 && (
            <div className="mb-2">
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400 uppercase tracking-wide">
                <Play size={14} />
                <span>Run</span>
              </div>
              {actionHits.map((a) => renderCommandRow({ kind: 'action', ...a }, 'RUN'))}
            </div>
          )}

          {/* Content search (lazy — only when query ≥ 2 chars) */}
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={18} className="animate-spin text-gray-400" />
            </div>
          )}

          {!loading && query.length >= 2 && searchResults.length === 0 && flatCommands.length === 0 && (
            <div className="text-center text-sm text-gray-500 py-8">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {!loading && !query && flatCommands.length === 0 && (
            <div className="text-center text-sm text-gray-600 py-8">
              Start typing to go to a page, run an action, or search.
            </div>
          )}

          {!loading && searchResults.map((source) => {
            const SourceIcon = ICON_MAP[source.icon] ?? Search;
            const isExpanded = expandedSources.has(source.id);
            const visible = isExpanded ? source.results : source.results.slice(0, 3);
            const hasMore = source.results.length > 3 && !isExpanded;

            return (
              <div key={source.id} className="mb-2">
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400 uppercase tracking-wide">
                  <SourceIcon size={14} />
                  <span>{source.label}</span>
                </div>

                {visible.map((result) => {
                  const currentIdx = flatIdx++;
                  const isFocused = focusedIndex === currentIdx;
                  return (
                    <div
                      key={result.id}
                      ref={(el) => { resultRefs.current[currentIdx] = el; }}
                      onClick={() => dispatchCommand({ kind: 'search', ...result })}
                      className={`flex items-start gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                        isFocused ? 'bg-port-accent/10' : 'hover:bg-white/5'
                      }`}
                      role="option"
                      aria-selected={isFocused}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{result.title}</p>
                        {result.snippet && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">
                            <Highlight text={result.snippet} query={query} />
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}

                {hasMore && (
                  <button
                    onClick={() => setExpandedSources((prev) => new Set([...prev, source.id]))}
                    className="text-xs text-port-accent px-3 py-1 hover:underline"
                  >
                    Show {source.results.length - 3} more
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-2 border-t border-port-border text-[11px] text-gray-500">
          <span>↑↓ navigate · ↵ run · Esc close</span>
          <span>Shared backbone with voice agent</span>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
