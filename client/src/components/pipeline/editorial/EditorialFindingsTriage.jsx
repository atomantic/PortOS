/**
 * Findings triage for the Editorial Checks page (#1285): the check-sourced
 * comments seeded into the manuscript review store, grouped by check with
 * severity counts. Each finding deep-links into the manuscript editor (which
 * opens its comment card via the `?comment=` param) where the full edit flow
 * lives — but the common preview/accept/dismiss path is also available inline
 * here (#1598): an open finding with a suggested fix expands a collapsed
 * before/after diff (reusing the manuscript card's `InlineDiff` + edit helpers)
 * and applies or dismisses it without leaving the page. Heavier edits (editing
 * the replacement text, per-edit selection) still deep-link into the editor.
 *
 * For reviewing a large batch, open findings carry a checkbox (#1599): select
 * across checks (or a whole group via the header checkbox) and a sticky action
 * bar bulk-accepts the selected findings that have an applicable fix and/or
 * bulk-dismisses the selection — each result reactively updates local state.
 */
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, History, Check, X, Loader2, GitCompareArrows, Search, Ban, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  groupFindingsByCheck,
  findingManuscriptLink,
  openFindingsTotal,
  deriveFindingFacets,
  applyFindingsView,
  normalizeFindingSort,
  FINDING_SORT_OPTIONS,
} from '../../../lib/editorialChecks';
import { fixEditsOf, selectedEditsFor } from '../manuscript/ManuscriptCommentCard';
import InlineDiff from '../../ui/InlineDiff';
import toast from '../../ui/Toast';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { acceptPipelineManuscriptFix, patchPipelineManuscriptComment } from '../../../services/api';

const SEVERITY_DOT = {
  high: 'bg-rose-400',
  medium: 'bg-amber-400',
  low: 'bg-gray-400',
};
const STATUS_TONE = {
  open: 'text-gray-200',
  accepted: 'text-emerald-400 line-through',
  dismissed: 'text-gray-600 line-through',
};
const SEVERITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };
const STATUS_LABELS = { open: 'Open', accepted: 'Accepted', dismissed: 'Dismissed' };
const SEVERITY_FILTER_ORDER = ['high', 'medium', 'low'];
const STATUS_FILTER_ORDER = ['open', 'accepted', 'dismissed'];

// URL params that persist the triage filters/sort (#1600). `f`-prefixed so they
// never collide with the page's own `series` / `custom` params.
const FILTER_PARAMS = { severity: 'fsev', status: 'fstatus', scope: 'fscope', check: 'fcheck', issue: 'fissue', query: 'fq', sort: 'fsort' };
const ALL_FILTER_PARAMS = Object.values(FILTER_PARAMS);
const parseSet = (raw) => new Set((raw || '').split(',').map((s) => s.trim()).filter(Boolean));
const serializeSet = (set) => [...set].join(',');

// A check-sourced finding that's still open — the only findings that are
// selectable / bulk-actionable. Named once so the predicate lives in one place.
const isOpenFinding = (c) => !!c.checkId && c.status === 'open';

// A fix is acceptable only when it carries usable replacement text — mirror the
// manuscript card so the inline/bulk Accept stays disabled for edge edits the
// editor must handle. Shared by the per-finding row and the bulk action bar.
const isAcceptableFix = (comment) =>
  !!comment.fix && fixEditsOf(comment).some((e) => (e.replace || '').trim());

// The edits payload the accept endpoint expects for a comment (drop the local
// `selected` flag). Shared by inline Accept and bulk Accept so both apply the
// same edits the editor would.
const acceptEditsOf = (comment) =>
  selectedEditsFor(comment, null).map(({ selected: _selected, ...edit }) => edit);

function CountPills({ counts }) {
  return (
    <span className="flex items-center gap-1.5">
      {['high', 'medium', 'low'].map((sev) => (counts[sev] ? (
        <span key={sev} className="flex items-center gap-1 text-[10px] text-gray-400">
          <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[sev]}`} />
          {counts[sev]}
        </span>
      ) : null))}
    </span>
  );
}

// Findings whose analyzed manuscript/canon changed since the check last ran
// (#1345) — re-run the check (or dismiss) so the finding reflects current content.
function StaleBadge({ count }) {
  return (
    <span
      className="flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
      title={count != null
        ? `${count} open finding${count === 1 ? '' : 's'} analyzed content that has since changed — re-run this check`
        : 'Analyzed content has changed since this check ran — re-run the check'}
    >
      <History size={10} className="shrink-0" />
      {count != null ? `${count} stale` : 'Stale'}
    </span>
  );
}

// Checkbox that can render the tri-state "some selected" indeterminate look —
// the DOM `indeterminate` flag is set imperatively since React has no prop for it.
function SelectCheckbox({ checked, indeterminate = false, onChange, label, className = '' }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className={`h-3.5 w-3.5 shrink-0 cursor-pointer accent-port-accent ${className}`}
    />
  );
}

// One finding: deep-link header + (for open findings) a selection checkbox and
// an inline preview/accept/dismiss bar (#1598). The collapsed diff reuses the
// manuscript card's edit helpers + `InlineDiff` so the preview here matches what
// the editor applies.
function FindingRow({ seriesId, comment, onCommentChange, selected, onToggleSelect }) {
  const [showFix, setShowFix] = useState(false);
  const hasFix = !!comment.fix;
  const isOpen = comment.status === 'open';
  const edits = useMemo(() => fixEditsOf(comment), [comment]);
  const acceptable = useMemo(() => isAcceptableFix(comment), [comment]);

  const [runAccept, accepting] = useAsyncAction(
    () => acceptPipelineManuscriptFix(
      seriesId,
      comment.id,
      { edits: acceptEditsOf(comment) },
      { silent: true },
    ),
    { errorMessage: 'Failed to apply fix' },
  );
  const [runDismiss, dismissing] = useAsyncAction(
    () => patchPipelineManuscriptComment(seriesId, comment.id, { status: 'dismissed' }, { silent: true }),
    { errorMessage: 'Failed to dismiss' },
  );

  const accept = async () => {
    const result = await runAccept();
    if (!result?.comment) return;
    onCommentChange?.(result.comment);
    toast.success('Fix applied to the manuscript');
  };
  const dismiss = async () => {
    const result = await runDismiss();
    if (result?.comment) onCommentChange?.(result.comment);
  };

  return (
    <li className="p-2.5 space-y-2">
      <div className="flex items-start gap-2">
        {isOpen ? (
          <SelectCheckbox
            checked={selected}
            onChange={() => onToggleSelect?.(comment.id)}
            label={`Select finding: ${comment.problem}`}
            className="mt-1"
          />
        ) : null}
        <Link
          to={findingManuscriptLink(seriesId, comment)}
          className="group flex min-w-0 flex-1 items-start justify-between gap-2"
        >
          <span className="min-w-0 space-y-0.5">
            <span className={`block text-xs ${STATUS_TONE[comment.status] || STATUS_TONE.open}`}>
              <span className={`mr-1.5 inline-block h-2 w-2 rounded-full align-middle ${SEVERITY_DOT[comment.severity] || SEVERITY_DOT.low}`} />
              {comment.problem}
            </span>
            <span className="flex items-center gap-2">
              {comment.location ? <span className="block text-[11px] text-gray-500">{comment.location}</span> : null}
              {isOpen && comment.stale ? <StaleBadge /> : null}
            </span>
          </span>
          <ExternalLink size={13} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-port-accent" />
        </Link>
      </div>

      {isOpen ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {hasFix ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowFix((v) => !v)}
                  aria-expanded={showFix}
                  className="inline-flex items-center gap-1 rounded border border-port-border px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-white hover:border-port-accent/40"
                >
                  <GitCompareArrows size={11} />
                  {showFix ? 'Hide fix' : 'Preview fix'}
                  {showFix ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </button>
                <button
                  type="button"
                  onClick={accept}
                  disabled={accepting || dismissing || !acceptable}
                  className="inline-flex items-center gap-1 rounded border border-port-success/40 bg-port-success/20 px-1.5 py-0.5 text-[10px] text-port-success hover:bg-port-success/30 disabled:opacity-40"
                >
                  {accepting ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  Accept
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={dismiss}
              disabled={accepting || dismissing}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:text-white disabled:opacity-40"
            >
              {dismissing ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
              Dismiss
            </button>
          </div>
          {hasFix && showFix ? (
            <div className="space-y-1.5 rounded border border-port-border/60 bg-port-card/40">
              {edits.map((edit, i) => (
                <div key={`${i}-${edit.issueId || ''}-${edit.find}`} className="overflow-hidden rounded border border-port-border/60">
                  <InlineDiff oldText={edit.find || ''} newText={edit.replace || ''} emptyLabel="No replacement changes." />
                </div>
              ))}
              <p className="px-2 pb-1.5 text-[10px] text-gray-500">
                Need to edit the replacement or pick individual edits? <Link to={findingManuscriptLink(seriesId, comment)} className="text-port-accent hover:underline">Open in the editor</Link>.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// `forceOpen` keeps a group expanded while filters are active (#1600): a group's
// default collapse derives from `group.open > 0`, so a status/search filter that
// matches only resolved findings (open === 0) would otherwise hide its matches
// behind a collapsed header and make the filtered view look empty.
function CheckGroup({ seriesId, group, onCommentChange, selectedIds, onToggleSelect, onSelectMany, forceOpen = false, canDisable = false, onDisableCheck }) {
  const [open, setOpen] = useState(group.open > 0);
  const expanded = forceOpen || open;
  const openIds = useMemo(
    () => group.comments.filter(isOpenFinding).map((c) => c.id),
    [group.comments],
  );
  const selectedCount = openIds.reduce((n, id) => n + (selectedIds.has(id) ? 1 : 0), 0);
  const allSelected = openIds.length > 0 && selectedCount === openIds.length;
  return (
    <div className="rounded-lg border border-port-border bg-port-card">
      <div className="flex items-center gap-2 p-2.5">
        {openIds.length > 0 ? (
          <SelectCheckbox
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            onChange={() => onSelectMany?.(openIds, !allSelected)}
            label={`Select all open findings in ${group.label}`}
          />
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={forceOpen}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left disabled:cursor-default"
          aria-expanded={expanded}
        >
          <span className="flex items-center gap-1.5 min-w-0">
            {expanded ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
            <span className="text-sm font-medium text-gray-100 truncate">{group.label}</span>
            <span className="text-[10px] text-gray-500 shrink-0">{group.open} open · {group.total} total</span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            {group.stale > 0 ? <StaleBadge count={group.stale} /> : null}
            <CountPills counts={group.counts} />
          </span>
        </button>
        {canDisable && onDisableCheck ? (
          // Mute a noisy/false-positive check without leaving the triage view
          // (#1602): disables it (skipped on future runs) and hides its findings
          // group here, with an undo toast. Only offered for currently-enabled
          // checks — an already-disabled check has nothing to mute.
          <button
            type="button"
            onClick={() => onDisableCheck(group.checkId, group.label)}
            title="Disable this check — hides its findings here and skips it on future runs"
            aria-label={`Disable check: ${group.label}`}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-port-border px-1.5 py-0.5 text-[10px] text-gray-500 hover:border-rose-400/40 hover:text-rose-300"
          >
            <Ban size={11} /> Disable
          </button>
        ) : null}
      </div>
      {expanded ? (
        <ul className="divide-y divide-port-border/60 border-t border-port-border/60">
          {group.comments.map((c) => (
            <FindingRow
              key={c.id}
              seriesId={seriesId}
              comment={c}
              onCommentChange={onCommentChange}
              selected={selectedIds.has(c.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Sticky bar shown while findings are selected (#1599): bulk-accept those with an
// applicable fix, bulk-dismiss the whole selection. Actions run sequentially so
// the accept endpoint's section writes don't race on the shared manuscript file.
function BulkActionBar({ seriesId, selected, onCommentChange, onClear }) {
  const [busy, setBusy] = useState(false);
  const acceptable = useMemo(() => selected.filter(isAcceptableFix), [selected]);

  const runBulk = async (mode) => {
    const targets = mode === 'accept' ? acceptable : selected;
    if (!targets.length) return;
    setBusy(true);
    let ok = 0;
    let failed = 0;
    for (const comment of targets) {
      const result = mode === 'accept'
        ? await acceptPipelineManuscriptFix(seriesId, comment.id, { edits: acceptEditsOf(comment) }, { silent: true }).catch(() => null)
        : await patchPipelineManuscriptComment(seriesId, comment.id, { status: 'dismissed' }, { silent: true }).catch(() => null);
      if (result?.comment) {
        onCommentChange?.(result.comment);
        ok += 1;
      } else {
        failed += 1;
      }
    }
    setBusy(false);
    onClear?.();
    if (ok) toast.success(`${mode === 'accept' ? 'Applied' : 'Dismissed'} ${ok} finding${ok === 1 ? '' : 's'}`);
    if (failed) toast.error(`${failed} finding${failed === 1 ? '' : 's'} failed — open them in the editor`);
  };

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-port-accent/40 bg-port-card p-2 shadow-lg">
      <span className="text-[11px] font-medium text-gray-200">{selected.length} selected</span>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => runBulk('accept')}
          disabled={busy || !acceptable.length}
          title={acceptable.length ? undefined : 'No selected finding has an applicable fix'}
          className="inline-flex items-center gap-1 rounded border border-port-success/40 bg-port-success/20 px-2 py-1 text-[11px] text-port-success hover:bg-port-success/30 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          Accept {acceptable.length}
        </button>
        <button
          type="button"
          onClick={() => runBulk('dismiss')}
          disabled={busy || !selected.length}
          className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-[11px] text-gray-300 hover:text-white hover:border-port-accent/40 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
          Dismiss {selected.length}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="rounded px-2 py-1 text-[11px] text-gray-500 hover:text-white disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// A small multi-select toggle chip used for severity / status facets.
function FilterChip({ active, onClick, label, dotClass }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? 'border-port-accent/60 bg-port-accent/20 text-gray-100'
          : 'border-port-border text-gray-400 hover:text-gray-200 hover:border-port-accent/40'
      }`}
    >
      {dotClass ? <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} /> : null}
      {label}
    </button>
  );
}

// Filter + search + sort toolbar (#1600). Reads/writes the page URL so a triage
// view (e.g. "high-severity open findings on Issue 5, sorted by severity") is
// deep-linkable. Single-pick selects for scope/check/issue (potentially many),
// multi-select chips for the small severity/status facets, a free-text search,
// and the sort order — only facets actually present in the findings are offered.
function FindingsToolbar({ facets, filters, sort, setParam, toggleInParam, onClear, activeCount }) {
  return (
    <div className="space-y-2 rounded-lg border border-port-border bg-port-card p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[10rem] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
          <label htmlFor="ec-find-search" className="sr-only">Search findings</label>
          <input
            id="ec-find-search"
            type="search"
            value={filters.query}
            onChange={(e) => setParam('query', e.target.value)}
            placeholder="Search problem / location…"
            className="w-full rounded border border-port-border bg-port-bg py-1 pl-7 pr-2 text-xs text-gray-200 placeholder:text-gray-600 focus:border-port-accent focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="ec-find-sort" className="text-[10px] text-gray-500">Sort</label>
          <select
            id="ec-find-sort"
            value={sort}
            onChange={(e) => setParam('sort', e.target.value)}
            className="rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-gray-200 focus:border-port-accent focus:outline-none"
          >
            {FINDING_SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        {activeCount > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded border border-port-border px-1.5 py-1 text-[10px] text-gray-400 hover:text-white hover:border-port-accent/40"
          >
            <X size={11} /> Clear {activeCount}
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {facets.severities.size > 1 ? (
          <span className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-600">Severity</span>
            {SEVERITY_FILTER_ORDER.filter((s) => facets.severities.has(s)).map((s) => (
              <FilterChip
                key={s}
                active={filters.severities.has(s)}
                onClick={() => toggleInParam('severity', s)}
                label={SEVERITY_LABELS[s]}
                dotClass={SEVERITY_DOT[s]}
              />
            ))}
          </span>
        ) : null}
        {facets.statuses.size > 1 ? (
          <span className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-600">Status</span>
            {STATUS_FILTER_ORDER.filter((s) => facets.statuses.has(s)).map((s) => (
              <FilterChip
                key={s}
                active={filters.statuses.has(s)}
                onClick={() => toggleInParam('status', s)}
                label={STATUS_LABELS[s]}
              />
            ))}
          </span>
        ) : null}
        {facets.scopes.length > 1 ? (
          <span className="flex items-center gap-1">
            <label htmlFor="ec-find-scope" className="text-[10px] uppercase tracking-wide text-gray-600">Category</label>
            <select
              id="ec-find-scope"
              value={[...filters.scopes][0] || ''}
              onChange={(e) => setParam('scope', e.target.value)}
              className="max-w-[9rem] rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-gray-200 focus:border-port-accent focus:outline-none"
            >
              <option value="">All</option>
              {facets.scopes.map((s) => <option key={s.scope} value={s.scope}>{s.label}</option>)}
            </select>
          </span>
        ) : null}
        {facets.checks.length > 1 ? (
          <span className="flex items-center gap-1">
            <label htmlFor="ec-find-check" className="text-[10px] uppercase tracking-wide text-gray-600">Check</label>
            <select
              id="ec-find-check"
              value={[...filters.checkIds][0] || ''}
              onChange={(e) => setParam('check', e.target.value)}
              className="max-w-[11rem] truncate rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-gray-200 focus:border-port-accent focus:outline-none"
            >
              <option value="">All</option>
              {facets.checks.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </span>
        ) : null}
        {facets.issues.length > 1 ? (
          <span className="flex items-center gap-1">
            <label htmlFor="ec-find-issue" className="text-[10px] uppercase tracking-wide text-gray-600">Issue</label>
            <select
              id="ec-find-issue"
              value={[...filters.issues][0] || ''}
              onChange={(e) => setParam('issue', e.target.value)}
              className="max-w-[9rem] rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-gray-200 focus:border-port-accent focus:outline-none"
            >
              <option value="">All</option>
              {facets.issues.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
            </select>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default function EditorialFindingsTriage({ seriesId, comments = [], checksById = {}, onCommentChange, onToggleCheckEnabled }) {
  const groups = useMemo(() => groupFindingsByCheck(comments, checksById), [comments, checksById]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  // Checks the user muted from this view this session (#1602). Disabling a check
  // doesn't delete its persisted findings, so the group is hidden locally until an
  // undo (or a fresh findings load) brings it back. Keyed by checkId.
  const [hiddenCheckIds, setHiddenCheckIds] = useState(() => new Set());
  const unhideCheck = (checkId) => setHiddenCheckIds((s) => {
    if (!s.has(checkId)) return s;
    const next = new Set(s);
    next.delete(checkId);
    return next;
  });
  const disableCheck = (checkId, label) => {
    setHiddenCheckIds((s) => new Set(s).add(checkId));
    const toastId = toast((t) => (
      <span className="flex items-center gap-3 text-xs">
        <span className="text-gray-200">Disabled <span className="font-medium text-white">{label}</span> — findings hidden</span>
        <button
          type="button"
          onClick={() => { unhideCheck(checkId); onToggleCheckEnabled?.(checkId, true); toast.dismiss(t.id); }}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-port-border px-2 py-0.5 text-[11px] text-port-accent hover:border-port-accent/40 hover:text-white"
        >
          <Undo2 size={12} /> Undo
        </button>
      </span>
    ), { duration: 8000 });
    // Optimistic hide above; reconcile if the persist fails (onToggleCheckEnabled
    // resolves false on error and has already reverted + toasted) so a failed
    // disable doesn't leave the group stuck hidden behind a dead undo toast.
    Promise.resolve(onToggleCheckEnabled?.(checkId, false)).then((ok) => {
      if (ok === false) { unhideCheck(checkId); toast.dismiss(toastId); }
    });
  };
  // Keep the muted set honest against the live enabled-state: if a muted check is
  // re-enabled elsewhere (the catalog toggle on this same page, or a findings
  // reload carrying fresh catalog rows), un-hide its group so visibility always
  // follows the check's actual enabled state — never stranding a group the empty
  // state tells the user to restore from the catalog. Re-enabling through the
  // undo path goes here too (its onToggleCheckEnabled flips enabled back to true).
  useEffect(() => {
    setHiddenCheckIds((s) => {
      if (!s.size) return s;
      let changed = false;
      const next = new Set();
      s.forEach((id) => { if (checksById[id]?.enabled === false) next.add(id); else changed = true; });
      return changed ? next : s;
    });
  }, [checksById]);

  // ---- Filter / search / sort, persisted in the URL so a view is deep-linkable
  // (#1600). Facets are derived from the full (unfiltered) groups so options never
  // vanish as you narrow; the toolbar only ever offers facets that exist. ----
  const [searchParams, setSearchParams] = useSearchParams();
  const facets = useMemo(() => deriveFindingFacets(groups), [groups]);
  const sort = normalizeFindingSort(searchParams.get(FILTER_PARAMS.sort));
  const filters = useMemo(() => ({
    severities: parseSet(searchParams.get(FILTER_PARAMS.severity)),
    statuses: parseSet(searchParams.get(FILTER_PARAMS.status)),
    scopes: parseSet(searchParams.get(FILTER_PARAMS.scope)),
    checkIds: parseSet(searchParams.get(FILTER_PARAMS.check)),
    issues: parseSet(searchParams.get(FILTER_PARAMS.issue)),
    query: searchParams.get(FILTER_PARAMS.query) || '',
  }), [searchParams]);
  const activeFilterCount = filters.severities.size + filters.statuses.size
    + filters.scopes.size + filters.checkIds.size + filters.issues.size
    + (filters.query ? 1 : 0);

  // Write a single facet param (empty value clears it), preserving every other
  // param the page owns. `replace` so filtering doesn't pile up history entries.
  const setParam = (key, value) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value) next.set(FILTER_PARAMS[key], value); else next.delete(FILTER_PARAMS[key]);
    return next;
  }, { replace: true });
  // Toggle one token in a comma-list (multi-select) param.
  const toggleInParam = (key, token) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    const set = parseSet(prev.get(FILTER_PARAMS[key]));
    if (set.has(token)) set.delete(token); else set.add(token);
    if (set.size) next.set(FILTER_PARAMS[key], serializeSet(set)); else next.delete(FILTER_PARAMS[key]);
    return next;
  }, { replace: true });
  const clearFilters = () => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    ALL_FILTER_PARAMS.forEach((p) => next.delete(p));
    return next;
  }, { replace: true });

  const view = useMemo(() => applyFindingsView(groups, filters, sort), [groups, filters, sort]);
  // Drop groups the user muted this session (#1602) so the disabled check's noise
  // disappears immediately; everything downstream (selection, counts, render) keys
  // off this so a hidden group can't be bulk-acted on either.
  const visibleView = useMemo(
    () => (hiddenCheckIds.size ? view.filter((g) => !hiddenCheckIds.has(g.checkId)) : view),
    [view, hiddenCheckIds],
  );

  // Selection only ever holds open findings — once a finding is accepted/dismissed
  // (here or in the editor) drop it so the bar's counts never count resolved ones.
  const openIds = useMemo(
    () => new Set(comments.filter(isOpenFinding).map((c) => c.id)),
    [comments],
  );
  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set();
      prev.forEach((id) => { if (openIds.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [openIds]);

  const toggleSelect = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectMany = (ids, on) => setSelectedIds((prev) => {
    const next = new Set(prev);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    return next;
  });
  const clearSelection = () => setSelectedIds(new Set());

  // Bulk actions only ever target findings that are BOTH selected and currently
  // VISIBLE in the filtered view (#1600) — a selection hidden by a filter must not
  // be silently accepted/dismissed by the sticky bar. Selection state itself is
  // preserved (clearing the filter brings hidden selections back).
  const selectedComments = useMemo(
    () => visibleView.flatMap((g) => g.comments).filter((c) => isOpenFinding(c) && selectedIds.has(c.id)),
    [visibleView, selectedIds],
  );

  if (!groups.length) {
    return (
      <p className="rounded-lg border border-dashed border-port-border p-4 text-center text-xs text-gray-500">
        No editorial-check findings yet. Run the enabled checks to populate this list.
      </p>
    );
  }
  const totalOpen = openFindingsTotal(groups);
  const shownOpen = openFindingsTotal(visibleView);
  return (
    <div className="space-y-2">
      <FindingsToolbar
        facets={facets}
        filters={filters}
        sort={sort}
        setParam={setParam}
        toggleInParam={toggleInParam}
        onClear={clearFilters}
        activeCount={activeFilterCount}
      />
      {selectedComments.length > 0 ? (
        <BulkActionBar
          seriesId={seriesId}
          selected={selectedComments}
          onCommentChange={onCommentChange}
          onClear={clearSelection}
        />
      ) : (
        <p className="text-[11px] text-gray-500">
          {activeFilterCount > 0 || hiddenCheckIds.size > 0
            ? `${shownOpen} of ${totalOpen} open finding${totalOpen === 1 ? '' : 's'} shown · ${visibleView.length} of ${groups.length} check${groups.length === 1 ? '' : 's'}`
            : `${totalOpen} open finding${totalOpen === 1 ? '' : 's'} across ${groups.length} check${groups.length === 1 ? '' : 's'}`}
        </p>
      )}
      {visibleView.length === 0 ? (
        <p className="rounded-lg border border-dashed border-port-border p-4 text-center text-xs text-gray-500">
          {activeFilterCount > 0 ? (
            <>No findings match the current filters. <button type="button" onClick={clearFilters} className="text-port-accent hover:underline">Clear filters</button>.</>
          ) : (
            'Every check with findings is disabled. Re-enable a check from the catalog to triage its findings.'
          )}
        </p>
      ) : null}
      {visibleView.map((g) => (
        <CheckGroup
          key={g.checkId}
          seriesId={seriesId}
          group={g}
          onCommentChange={onCommentChange}
          canDisable={!!onToggleCheckEnabled && checksById[g.checkId]?.enabled === true}
          onDisableCheck={disableCheck}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectMany={selectMany}
          forceOpen={activeFilterCount > 0}
        />
      ))}
    </div>
  );
}
