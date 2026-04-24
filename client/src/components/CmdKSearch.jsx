import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Brain, Cpu, Package, History, HeartPulse, Search, Loader2, Navigation, Play, LayoutGrid } from 'lucide-react';
import { useCmdKSearch } from '../hooks/useCmdKSearch';
import { useScrollLock } from '../hooks/useScrollLock';
import { search, getPaletteManifest, runPaletteAction, getDashboardLayouts, setActiveDashboardLayout } from '../services/api';
import toast from './ui/Toast';
import { modKey } from '../utils/platform';
import { DASHBOARD_LAYOUT_CHANGED } from '../constants/events.js';

const ICON_MAP = { Brain, Cpu, Package, History, HeartPulse };

// Subsequence-based fuzzy scorer. Tiered: exact label > label-prefix > alias
// exact > label-contains > alias-contains > keyword-contains > section-contains
// > subsequence. Reads precomputed lowercased fields to keep each comparison
// allocation-free on the per-keystroke hot path.
const scoreCommand = (c, q) => {
  if (!q) return 0;
  const { _label, _aliases, _keywords, _section } = c;
  if (_label === q) return 1000;
  if (_label.startsWith(q)) return 800 - (_label.length - q.length);
  if (_aliases.includes(q)) return 750;
  if (_label.includes(q)) return 500;
  for (const a of _aliases) if (a.includes(q)) return 400;
  for (const k of _keywords) if (k.includes(q)) return 300;
  if (_section.includes(q)) return 150;
  let i = 0;
  for (const ch of _label) if (ch === q[i]) i += 1;
  return i === q.length ? 100 + i : 0;
};

const precompute = (cmd) => ({
  ...cmd,
  _label: (cmd.label || '').toLowerCase(),
  _aliases: (cmd.aliases || []).map((a) => a.toLowerCase()),
  _keywords: (cmd.keywords || []).map((k) => k.toLowerCase()),
  _section: (cmd.section || '').toLowerCase(),
});

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

// Curated default shortlist — shown when the palette opens with no query so
// Enter always does something useful.
const DEFAULT_NAV_IDS = new Set(['nav.dashboard', 'nav.brain.inbox', 'nav.cos.tasks', 'nav.goals', 'nav.review-hub']);
const DEFAULT_ACTION_IDS = new Set(['brain_capture', 'time_now', 'goal_list', 'meatspace_summary_today']);

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
      resultRefs.current = [];
    }
  }, [open]);

  // Two effects so setManifest never retriggers a fetch loop:
  //   1. nav + actions are static server-side; fetched once per mount (guarded
  //      by a ref so remounting `open` doesn't re-hit the network).
  //   2. layouts change when the user creates/renames/deletes; re-fetched on
  //      every open-transition so the palette picks up changes immediately.
  // Each updates `manifest` functionally without depending on its value.
  const navActionsFetchedRef = useRef(false);
  useEffect(() => {
    if (!open || navActionsFetchedRef.current) return;
    navActionsFetchedRef.current = true;
    let cancelled = false;
    // request() toasts the failure centrally; on rejection we fall back to
    // an empty shape so the palette still renders (layouts + search work).
    // Also: if the fetch fails, allow a retry on next open by un-setting the
    // ref so the user isn't stuck with a blank nav list forever.
    getPaletteManifest()
      .catch(() => { navActionsFetchedRef.current = false; return { nav: [], actions: [] }; })
      .then((data) => {
        if (cancelled) return;
        const nav = (data?.nav || []).map(precompute);
        const actions = (data?.actions || []).map(precompute);
        setManifest((prev) => ({
          nav,
          actions,
          layouts: prev?.layouts || [],
        }));
      });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getDashboardLayouts()
      .catch(() => ({ layouts: [] }))
      .then((dashboards) => {
        if (cancelled) return;
        const layouts = (dashboards?.layouts || []).map((l) => precompute({
          id: `layout.${l.id}`,
          layoutId: l.id,
          layoutName: l.name,
          label: `Dashboard: ${l.name}`,
          section: 'Layouts',
          aliases: ['layout', l.id, ...l.name.toLowerCase().split(/\s+/)],
          keywords: ['dashboard', 'layout', 'view'],
        }));
        setManifest((prev) => ({
          nav: prev?.nav || [],
          actions: prev?.actions || [],
          layouts,
        }));
      });
    return () => { cancelled = true; };
  }, [open]);

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

  const combined = useMemo(() => {
    if (!manifest) return { nav: [], actions: [], layouts: [], commandCount: 0 };
    const q = query.trim().toLowerCase();
    if (!q) {
      const nav = manifest.nav.filter((c) => DEFAULT_NAV_IDS.has(c.id)).map((c) => ({ ...c, kind: 'nav' }));
      const actions = manifest.actions.filter((a) => DEFAULT_ACTION_IDS.has(a.id)).map((a) => ({ ...a, kind: 'action' }));
      return { nav, actions, layouts: [], commandCount: nav.length + actions.length };
    }
    const rank = (items, max) => items
      .map((c) => ({ cmd: c, score: scoreCommand(c, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((x) => x.cmd);
    const nav = rank(manifest.nav, 8).map((c) => ({ ...c, kind: 'nav' }));
    const actions = rank(manifest.actions, 5).map((a) => ({ ...a, kind: 'action' }));
    const layouts = rank(manifest.layouts || [], 5).map((l) => ({ ...l, kind: 'layout' }));
    return { nav, actions, layouts, commandCount: nav.length + actions.length + layouts.length };
  }, [manifest, query]);

  const flatSearchResults = useMemo(
    () => searchResults.flatMap((source) => {
      const visible = expandedSources.has(source.id) ? source.results : source.results.slice(0, 3);
      return visible.map((r) => ({ ...r, kind: 'search', sourceId: source.id }));
    }),
    [searchResults, expandedSources]
  );

  const focusable = useMemo(
    () => [...combined.nav, ...combined.actions, ...combined.layouts, ...flatSearchResults],
    [combined, flatSearchResults]
  );

  useEffect(() => {
    const el = resultRefs.current[focusedIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const DISPATCH = useMemo(() => ({
    nav: (item) => { navigate(item.path); close(); },
    search: (item) => { navigate(item.url); close(); },
    layout: async (item) => {
      // request() toasts errors centrally; swallow the rejection here so
      // clicks from sync event handlers don't bubble as unhandled. On
      // success, tell any mounted Dashboard to re-fetch because
      // navigate('/') is a no-op if the user is already there.
      const ok = await setActiveDashboardLayout(item.layoutId).then(() => true, () => false);
      if (!ok) { close(); return; }
      window.dispatchEvent(new CustomEvent(DASHBOARD_LAYOUT_CHANGED));
      navigate('/');
      toast.success(`Switched to "${item.layoutName}"`);
      close();
    },
    action: async (item) => {
      const required = item.parameters?.required || [];
      if (required.length > 0) {
        // Keep palette open so the user can pick another command.
        toast(`${item.label} needs arguments — use voice or open the related page.`);
        return;
      }
      const res = await runPaletteAction(item.id);
      const summary = res?.result?.summary || `${item.label} ran.`;
      if (res?.ok === false) toast.error(summary);
      else toast.success(summary);
      close();
    },
  }), [navigate, close]);

  const dispatchCommand = useCallback((item) => DISPATCH[item.kind]?.(item), [DISPATCH]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (focusable.length > 0) setFocusedIndex((i) => Math.min(i + 1, focusable.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focusable.length > 0) setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const item = focusable[focusedIndex];
      if (item) dispatchCommand(item);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  if (!open) return null;

  let flatIdx = 0;

  const renderRow = (item, { icon: Icon, title, subtitle, badge }) => {
    const currentIdx = flatIdx++;
    const isFocused = focusedIndex === currentIdx;
    return (
      <div
        key={`${item.kind}:${item.id ?? item.sourceId + ':' + title}`}
        ref={(el) => { resultRefs.current[currentIdx] = el; }}
        onClick={() => dispatchCommand(item)}
        className={`flex items-start gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
          isFocused ? 'bg-port-accent/10' : 'hover:bg-white/5'
        }`}
        role="option"
        aria-selected={isFocused}
      >
        {Icon && <Icon size={14} className="shrink-0 mt-0.5 text-gray-400" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">
            <Highlight text={title} query={query} />
          </p>
          {subtitle && (
            <p className="text-xs text-gray-500 truncate mt-0.5">
              <Highlight text={subtitle} query={query} />
            </p>
          )}
        </div>
        {badge && <span className="text-[10px] uppercase tracking-wide text-gray-500 shrink-0 mt-1">{badge}</span>}
      </div>
    );
  };

  const renderGroup = (headerIcon, headerLabel, rows) => rows.length > 0 && (
    <div className="mb-2">
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400 uppercase tracking-wide">
        {headerIcon}
        <span>{headerLabel}</span>
      </div>
      {rows}
    </div>
  );

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
          <span className="text-xs text-gray-500 border border-port-border rounded px-1.5 py-0.5 shrink-0">
            {`${modKey}+K`}
          </span>
        </div>

        <div className="max-h-96 overflow-y-auto p-2">
          {renderGroup(
            <Navigation size={14} />,
            'Go to',
            combined.nav.map((c) =>
              renderRow(c, { icon: Navigation, title: c.label, subtitle: `${c.section} · ${c.path}`, badge: 'GO' })
            )
          )}

          {renderGroup(
            <Play size={14} />,
            'Run',
            combined.actions.map((a) =>
              renderRow(a, { icon: Play, title: a.label, subtitle: (a.description || a.section || '').slice(0, 80), badge: 'RUN' })
            )
          )}

          {renderGroup(
            <LayoutGrid size={14} />,
            'Dashboard layout',
            combined.layouts.map((l) =>
              renderRow(l, { icon: LayoutGrid, title: l.label, subtitle: 'Switch dashboard layout', badge: 'LAYOUT' })
            )
          )}

          {loading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={18} className="animate-spin text-gray-400" />
            </div>
          )}

          {!loading && query.length >= 2 && searchResults.length === 0 && combined.commandCount === 0 && (
            <div className="text-center text-sm text-gray-500 py-8">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {!loading && !query && combined.commandCount === 0 && (
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

                {visible.map((result) =>
                  renderRow(
                    { ...result, kind: 'search' },
                    { title: result.title, subtitle: result.snippet }
                  )
                )}

                {hasMore && (
                  <button
                    onClick={() => setExpandedSources((prev) => new Set(prev).add(source.id))}
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
