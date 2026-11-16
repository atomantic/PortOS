// The Stages tab's record list: 100+ stages folded into family groups, with a
// title/description search and a SYSTEM-only filter (#3284).
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Search, X } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import Pill from '../ui/Pill';
import CatalogueNotice from './CatalogueNotice';
import { buildStageGroups, stageGroupKeyFor } from '../../lib/promptStageGroups';

const toggleInSet = (set, key) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
};

// Search, filter and disclosure state. Owned by the editor rather than the
// list, because the narrow layout moves the list between the page and a
// Drawer, which would otherwise drop a typed query on every move.
export function useStageCatalogueFilter({ stages, systemStageKeys, selectedStage }) {
  // The query is deliberately LOCAL, not a URL param: it's a transient way to
  // reach a stage, and the thing worth deep-linking (`?stage=`) is already in
  // the URL.
  const [query, setQuery] = useState('');
  const [systemOnly, setSystemOnly] = useState(false);
  // Two disclosure sets, because the default flips with the filter: unfiltered,
  // groups start CLOSED and this tracks the ones opened; filtered, they start
  // OPEN (hiding a match reads as "no results") and `collapsedWhileFiltering`
  // tracks the ones folded away — a broad query like "e" matches every stage,
  // so the user still needs to be able to fold Pipeline's 78 rows out of view.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [collapsedWhileFiltering, setCollapsedWhileFiltering] = useState(() => new Set());

  const filterActive = query.trim() !== '' || systemOnly;
  const { groups, matchCount, totalCount } = useMemo(
    () => buildStageGroups(stages, { query, systemOnly, systemStageKeys }),
    [stages, query, systemOnly, systemStageKeys],
  );
  // Badge lookup for the row render — a Set so the O(n) list render doesn't
  // re-scan the key array per row.
  const systemStageSet = useMemo(() => new Set(systemStageKeys), [systemStageKeys]);

  // The group holding the open stage expands itself so a deep link / reload
  // lands with its row visible. Seeding STATE (rather than forcing it open at
  // render time) keeps the user free to collapse it again afterwards.
  const selectedGroupKey = selectedStage && stages[selectedStage]
    ? stageGroupKeyFor(selectedStage, stages[selectedStage])
    : null;
  useEffect(() => {
    if (!selectedGroupKey) return;
    setExpandedGroups((prev) => new Set(prev).add(selectedGroupKey));
  }, [selectedGroupKey]);

  // A fold is scoped to the EXACT filter that motivated it, not merely to
  // "some filter is on". Carrying it across a refinement is how the refined
  // query's only hit ends up behind a collapsed header — the "reads as no
  // results" failure this whole disclosure default exists to avoid.
  const queryKey = query.trim();
  useEffect(() => {
    setCollapsedWhileFiltering((prev) => (prev.size === 0 ? prev : new Set()));
  }, [queryKey, systemOnly]);

  return {
    query,
    setQuery,
    systemOnly,
    toggleSystemOnly: () => setSystemOnly((v) => !v),
    filterActive,
    groups,
    matchCount,
    totalCount,
    systemStageSet,
    // A filter flips the default open — hits hidden behind collapsed headers
    // read as "no results" — but the toggle stays live so a broad query's
    // biggest group can still be folded away.
    isOpen: (key) => (filterActive ? !collapsedWhileFiltering.has(key) : expandedGroups.has(key)),
    toggleGroup: (key) => (filterActive
      ? setCollapsedWhileFiltering((prev) => toggleInSet(prev, key))
      : setExpandedGroups((prev) => toggleInSet(prev, key))),
  };
}

export default function StageCatalogue({
  filter, catalogue, selectedStage, dirty, openLabel, isPending, onRequest, onConfirmSwitch, onCancelPending, onNew,
}) {
  const unavailable = catalogue.failed && !catalogue.loaded;
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-gray-400">Prompt Stages</h2>
        <button
          onClick={onNew}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-accent hover:text-port-accent/80"
          title="New Stage" aria-label="New Stage"
        >
          <Plus size={16} />
        </button>
      </div>
      {/* Search + SYSTEM filter, pinned above the list so it stays reachable
          while the grouped rows scroll. */}
      <div className="sticky top-0 z-10 -mx-4 px-4 pb-3 bg-port-card">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input
            type="search"
            aria-label="Search prompt stages"
            value={filter.query}
            onChange={(e) => filter.setQuery(e.target.value)}
            placeholder="Search stages…"
            // WebKit paints its own cancel glyph on a non-empty type=search,
            // which would sit on top of the labelled clear button below;
            // Tailwind's preflight resets only ::-webkit-search-decoration, so
            // suppress it here.
            className="w-full pl-8 pr-9 py-2.5 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder:text-gray-500 focus:border-port-accent focus:outline-hidden [&::-webkit-search-cancel-button]:appearance-none"
          />
          {filter.query && (
            <button
              onClick={() => filter.setQuery('')}
              aria-label="Clear stage search"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 absolute right-1 top-1/2 -translate-y-1/2 p-2 text-gray-500 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 mt-2">
          <button
            onClick={filter.toggleSystemOnly}
            aria-pressed={filter.systemOnly}
            className={`text-[10px] pointer-coarse:min-h-11 px-2.5 py-1.5 rounded uppercase font-semibold transition-colors ${
              filter.systemOnly
                ? 'bg-port-accent text-white'
                : 'bg-port-border text-gray-400 hover:text-white'
            }`}
          >
            System only
          </button>
          <span className="text-xs text-gray-500">
            {unavailable ? 'Unavailable' : filter.filterActive ? `${filter.matchCount} of ${filter.totalCount}` : `${filter.totalCount} stages`}
          </span>
        </div>
      </div>
      {catalogue.failed && (
        <CatalogueNotice label="Stages" stale={catalogue.loaded} onRetry={catalogue.reload} />
      )}
      <div className="space-y-1">
        {filter.groups.map(({ key: groupKey, label, stages: groupStages }) => {
          const open = filter.isOpen(groupKey);
          const Chevron = open ? ChevronDown : ChevronRight;
          return (
            <div key={groupKey}>
              <button
                onClick={() => filter.toggleGroup(groupKey)}
                aria-expanded={open}
                // Without this the name computes to "Pipeline78" — the count
                // span abuts the label with no separator.
                aria-label={`${label}, ${groupStages.length} stage${groupStages.length === 1 ? '' : 's'}`}
                className="w-full flex items-center gap-1 px-2 py-2 rounded-lg text-xs font-semibold uppercase tracking-wide text-gray-400 hover:bg-port-border hover:text-white"
              >
                <Chevron size={12} className="shrink-0" />
                <span className="min-w-0 truncate">{label}</span>
                <span className="ml-auto shrink-0 text-gray-500 normal-case">{groupStages.length}</span>
              </button>
              {open && (
                <div className="space-y-1 pl-2">
                  {groupStages.map(([name, config]) => (
                    isPending(name) ? (
                      <InlineConfirmRow
                        key={name}
                        className="rounded-lg"
                        question={`Discard unsaved changes to "${openLabel}"?`}
                        confirmText="Discard"
                        cancelText="Keep editing"
                        aria-label={`Confirm discarding unsaved changes to ${openLabel}`}
                        autoFocus
                        onConfirm={() => onConfirmSwitch(name)}
                        onCancel={onCancelPending}
                      />
                    ) : (
                      <button
                        key={name}
                        onClick={() => onRequest(name)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                          selectedStage === name
                            ? 'bg-port-accent/20 text-port-accent'
                            : 'text-gray-300 hover:bg-port-border'
                        }`}
                      >
                        <div className="flex items-center gap-1">
                          <span className="font-medium truncate">{config.name || name}</span>
                          {filter.systemStageSet.has(name) && (
                            <Pill tone="bare" size="xs" bordered={false} className="shrink-0 bg-port-accent/20 text-port-accent uppercase font-semibold">
                              System
                            </Pill>
                          )}
                          {selectedStage === name && dirty && (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-port-warning/20 text-port-warning rounded uppercase font-semibold">
                              Unsaved
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 truncate">{config.description}</div>
                      </button>
                    )
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {filter.groups.length === 0 && !unavailable && (
          <div className="text-sm text-gray-500 px-3 py-2">
            {filter.filterActive ? 'No stages match that search' : 'No prompt stages found'}
          </div>
        )}
      </div>
    </>
  );
}
