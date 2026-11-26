import { useEffect, useId, useMemo, useState } from 'react';
import { RefreshCw, Search, Tag, User } from 'lucide-react';
import { useThemeContext } from '../../ThemeContext';
import { chipColors } from '../../../lib/chipContrast';

// `in-progress` is the forge label a `/do:next` claim stamps on an issue it is
// actively working (server/services/issueReconcile.js#IN_PROGRESS_LABEL), and
// `blocked` marks work that should not be picked up by default. `needs-input`
// and `needs-decision` park issues awaiting human choices. Those rows aren't
// useful claim candidates, so the tab hides them until the user toggles the
// chip back on.
const DEFAULT_HIDDEN_LABELS = ['blocked', 'in-progress', 'needs-decision', 'needs-input'];
const defaultLabelFilter = () => ({
  mode: 'exclude',
  names: new Set(DEFAULT_HIDDEN_LABELS),
});

/** Exclude: drop any issue that carries a named label. Include: keep only issues that carry at least one named label. */
function issuePassesLabelFilter(issue, { mode, names }) {
  const labels = issue.labels || [];
  if (mode === 'include') return labels.some(l => names.has(l.name));
  return names.size === 0 || !labels.some(l => names.has(l.name));
}

/**
 * One label's show/hide toggle. Pressed (default) = issues carrying the label
 * are listed; un-pressed strikes the chip through and drops every issue that
 * carries it — so an issue tagged `bug` + `in-progress` disappears while
 * `in-progress` is off, which is what "hide in-progress work" has to mean.
 *
 * The count renders as a node adjacent to the name, so the computed accessible
 * name would be "bug1" — `aria-label` spells it out instead.
 *
 * NOT the shared `ui/ToggleChip`: that one is a fixed-accent pill wrapping a
 * real checkbox, which can't carry the forge's per-label color (the thing the
 * user recognizes a label by) and stacks a checkbox per chip into a row that
 * routinely runs 20+ labels wide.
 */
function LabelFilterChip({ facet, hidden, onToggle }) {
  const { theme } = useThemeContext();
  const style = hidden ? null : chipColors(facet.color, theme?.mode);
  // The theme utilities carry `!important` (index.css remaps `.bg-port-bg`,
  // `.border-port-border`, and day-mode `.text-gray-300`), and author
  // `!important` beats an inline declaration — so a chip that ships BOTH renders
  // in theme neutrals with its graded color silently dead. Emit the neutrals
  // only when there's no graded style to paint, the way `Pill tone="bare"` does.
  const neutral = hidden
    ? 'border-port-border bg-port-bg text-gray-500 line-through opacity-60 hover:opacity-100'
    : 'border-port-border bg-port-bg text-gray-300 hover:opacity-80';
  return (
    <button
      type="button"
      onClick={() => onToggle(facet.name)}
      aria-pressed={!hidden}
      aria-label={`${facet.name} (${facet.count})`}
      title={facet.description
        ? `${facet.description} — click to ${hidden ? 'show' : 'hide'} these issues`
        : `Click to ${hidden ? 'show' : 'hide'} issues labeled ${facet.name}`}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 transition-opacity ${
        style ? 'hover:opacity-80' : neutral
      }`}
      style={style}
    >
      {facet.name}
      <span className="font-mono opacity-70">{facet.count}</span>
    </button>
  );
}

export function useIssueFilters(appId, data) {
  const [query, setQuery] = useState('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [filedBy, setFiledBy] = useState('');
  // Exclude mode tracks labels to hide (a later refresh's new label stays
  // visible). Include mode — entered by Hide all labels — tracks labels to
  // keep, so turning `critical` back on lists every issue that carries it,
  // even when the issue also has labels that are still off.
  const [labelFilter, setLabelFilter] = useState(defaultLabelFilter);

  useEffect(() => {
    setLabelFilter(defaultLabelFilter());
    setUnassignedOnly(false);
    setFiledBy('');
  }, [appId]);

  // Lowercase each issue's searchable text ONCE per fetch, not once per
  // keystroke: bodies are capped at 8000 chars and the list at 200 issues, so
  // re-deriving inside the filter churned up to 1.6 MB of throwaway strings on
  // every character typed. Digits are case-invariant, so the issue number folds
  // into the same haystack.
  const haystacks = useMemo(() => (data?.issues || []).map(issue => ({
    issue,
    hay: [
      String(issue.number),
      issue.title,
      issue.body || '',
      issue.labels.map(l => l.name).join(' '),
      issue.assignees.join(' ')
    ].join('\n').toLowerCase()
  })), [data]);

  // Every label present on the fetched issues, with how many issues carry it,
  // alphabetical so the chip row doesn't reshuffle between refreshes.
  const labelFacets = useMemo(() => {
    const byName = new Map();
    for (const issue of data?.issues || []) {
      for (const label of issue.labels || []) {
        const seen = byName.get(label.name);
        if (seen) seen.count += 1;
        else byName.set(label.name, { ...label, count: 1 });
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const authorOptions = useMemo(() => {
    const authors = new Set();
    for (const issue of data?.issues || []) {
      if (issue.author) authors.add(issue.author);
    }
    return [...authors].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const issues = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = haystacks.filter(h =>
      issuePassesLabelFilter(h.issue, labelFilter)
      && (!unassignedOnly || h.issue.assignees.length === 0)
      && (!filedBy || h.issue.author === filedBy)
      && (!q || h.hay.includes(q))
    );
    return rows.map(h => h.issue);
  }, [haystacks, query, labelFilter, unassignedOnly, filedBy]);

  const total = data?.issues?.length ?? 0;
  // Only labels actually on this tracker count as "filtering something" — the
  // seeded defaults must not claim to hide anything in a repo that never uses
  // them. Include mode is always a filter, even with an empty keep-set.
  const hidingByLabel = labelFilter.mode === 'include'
    || labelFacets.some(f => labelFilter.names.has(f.name));
  const canHideAll = labelFilter.mode !== 'include' || labelFilter.names.size > 0;

  const toggleLabel = (name) => setLabelFilter(prev => {
    const names = new Set(prev.names);
    if (names.has(name)) names.delete(name); else names.add(name);
    return { mode: prev.mode, names };
  });

  const hideAllLabels = () => setLabelFilter({ mode: 'include', names: new Set() });
  const showAllLabels = () => setLabelFilter({ mode: 'exclude', names: new Set() });
  const labelChipHidden = (name) => (labelFilter.mode === 'include'
    ? !labelFilter.names.has(name)
    : labelFilter.names.has(name));


  function resetFilters() {
    setQuery('');
    setUnassignedOnly(false);
    setFiledBy('');
    setLabelFilter(defaultLabelFilter());
  }

  return {
    query, setQuery, unassignedOnly, setUnassignedOnly, filedBy, setFiledBy,
    labelFacets, authorOptions, issues, total, hidingByLabel, canHideAll, toggleLabel,
    hideAllLabels, showAllLabels, labelChipHidden, resetFilters
  };
}

export default function IssueFilterToolbar({ filters, forgeLabel, fullName, load, loading }) {
  const { query, setQuery, unassignedOnly, setUnassignedOnly, filedBy, setFiledBy, authorOptions, issues, total } = filters;
  const searchId = useId();
  const filedById = useId();

  return (
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="text-lg font-semibold text-white">
        {forgeLabel} Issues
        {fullName && <span className="ml-2 text-xs font-mono text-gray-500">{fullName}</span>}
      </h3>
      {total > 0 && (
        <span className="text-xs text-gray-500">
          {issues.length === total ? `${total} open` : `${issues.length} of ${total} open`}
        </span>
      )}
      <button
        type="button"
        onClick={() => setUnassignedOnly(prev => !prev)}
        aria-pressed={unassignedOnly}
        title={unassignedOnly ? 'Show assigned issues too' : 'Show only issues without assignees'}
        className={`px-3 py-1.5 rounded-lg text-xs border flex items-center gap-1.5 transition-colors ${unassignedOnly
          ? 'bg-port-accent/20 text-port-accent border-port-accent/40'
          : 'bg-port-bg text-gray-400 border-port-border hover:text-white'
        }`}
      >
        <User size={13} /> Unassigned only
      </button>
      <div className="flex items-center gap-1.5">
        <label htmlFor={filedById} className="text-xs text-gray-400 shrink-0">
          Filed by
        </label>
        <select
          id={filedById}
          aria-label="Filed by"
          value={filedBy}
          onChange={e => setFiledBy(e.target.value)}
          className="px-2.5 py-1.5 bg-port-bg border border-port-border rounded-lg text-xs text-white focus:border-port-accent focus:outline-hidden"
        >
          <option value="">All</option>
          {authorOptions.map(author => (
            <option key={author} value={author}>{author}</option>
          ))}
        </select>
      </div>
      <div className="relative ml-auto">
        <label htmlFor={searchId} className="sr-only">Filter issues</label>
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter by title, label, assignee…"
          className="w-full sm:w-72 pl-8 pr-3 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
        />
      </div>
      <button
        onClick={load}
        disabled={loading}
        className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
      >
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
      </button>
    </div>
  );
}

export function IssueLabelFilters({ filters }) {
  const { labelFacets, labelChipHidden, toggleLabel, canHideAll, hidingByLabel, hideAllLabels, showAllLabels } = filters;
  if (!labelFacets.length) return null;

  return (
    <div
      role="group"
      aria-label="Label filters"
      className="flex flex-wrap items-center gap-1.5 px-3 py-2 bg-port-card border border-port-border rounded-lg"
    >
      <span className="flex items-center gap-1.5 text-xs text-gray-500 uppercase tracking-wide shrink-0">
        <Tag size={14} /> Labels
      </span>
      {labelFacets.map(facet => (
        <LabelFilterChip
          key={facet.name}
          facet={facet}
          hidden={labelChipHidden(facet.name)}
          onToggle={toggleLabel}
        />
      ))}
      {(canHideAll || hidingByLabel) && (
        <div className="ml-auto flex items-center gap-3">
          {canHideAll && (
            <button
              type="button"
              onClick={hideAllLabels}
              className="text-xs text-gray-500 hover:text-port-accent transition-colors"
            >
              Hide all labels
            </button>
          )}
          {hidingByLabel && (
            <button
              type="button"
              onClick={showAllLabels}
              className="text-xs text-gray-500 hover:text-port-accent transition-colors"
            >
              Show all labels
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function IssueFilterEmptyState({ filters }) {
  const { query, unassignedOnly, filedBy, hidingByLabel, resetFilters } = filters;

  return (
    <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg flex flex-wrap items-center gap-3">
      <span>
        {query.trim()
          ? <>No open issues match &ldquo;{query}&rdquo;{hidingByLabel ? ' with the current label filters' : ''}.</>
          : unassignedOnly && filedBy
            ? <>No unassigned open issues filed by {filedBy}{hidingByLabel ? ' match the current label filters' : ''}.</>
            : unassignedOnly
              ? <>No unassigned open issues{hidingByLabel ? ' match the current label filters' : ''}.</>
              : filedBy
                ? <>No open issues filed by {filedBy}{hidingByLabel ? ' match the current label filters' : ''}.</>
                : 'No open issues match the current label filters.'}
      </span>
      <button
        type="button"
        onClick={resetFilters}
        className="px-2.5 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-border/60"
      >
        Reset filters
      </button>
    </div>
  );
}
