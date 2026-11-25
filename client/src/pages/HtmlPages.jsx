import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { GalleryVertical, LayoutGrid, List, LoaderCircle, Play, Plus, RotateCcw, SquarePen, Trash2, X } from 'lucide-react';
import { useSocketResource } from '../hooks/useSocketResource';
import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import PageSkeleton from '../components/ui/PageSkeleton';
import ListLoadError from '../components/ui/ListLoadError';
import EmptyState from '../components/EmptyState';
import HtmlPreviewFrame from '../components/htmlPages/HtmlPreviewFrame';
import HtmlPageGallery from '../components/htmlPages/HtmlPageGallery';
import PageFileActions from '../components/htmlPages/PageFileActions';
import PagePrompts from '../components/htmlPages/PagePrompts';
import RouteTabsHeader from '../components/ui/RouteTabsHeader';
import ProviderModelSelector from '../components/ProviderModelSelector';
import useProviderModels from '../hooks/useProviderModels';
import toast from '../components/ui/Toast';
import { deleteHtmlPageRun, getHtmlPageRun, listHtmlPageModels, listHtmlPageRuns, resumeHtmlPageRun, startHtmlPageRuns } from '../services/apiHtmlPages.js';
import { formatCount, formatDurationMs, timeAgo } from '../utils/formatters';
import { supportsStrictToolFreeOneShot } from '../utils/providerSelection';

const RUN_EVENTS = ['html-page-run:changed'];
// The installed-model list changes when the user installs a model, not when a run changes.
const NO_EVENTS = [];
const MAX_COMPARE = 4;
// Three routed tabs: the run form, the stored runs as cards, and one gallery of every page. `?view=gallery`, the gallery's old deep link, lands on the Gallery tab.
const TABS = [
  { id: 'create', label: 'Create', icon: SquarePen, to: '/html-pages' },
  { id: 'runs', label: 'Runs', icon: List, to: '/html-pages/runs' },
  { id: 'gallery', label: 'Gallery', icon: LayoutGrid, to: '/html-pages/gallery' },
];
const tabForPath = (pathname) => TABS.find((t) => t.id !== 'create' && (pathname === t.to || pathname.startsWith(`${t.to}/`)))?.id ?? 'create';
// Mirrors HTML_PAGES_MAX_MODELS on the server: local models and provider routes together.
const MAX_TARGETS = 8;

const STATUS = {
  queued: { label: 'Queued', cls: 'bg-port-border text-gray-300' },
  generating: { label: 'Generating', cls: 'bg-port-accent/15 text-port-accent' },
  complete: { label: 'Complete', cls: 'bg-port-success/15 text-port-success' },
  failed: { label: 'Failed', cls: 'bg-port-error/15 text-port-error' },
};
const isActive = (run) => run.status === 'queued' || run.status === 'generating';

// "Complete" is the generation finishing, which says nothing about whether the pages are usable, so a finished run is labelled by what its pages scored.
const FINISHED_BY_VERDICT = {
  partial: { label: 'Partial', cls: 'bg-port-warning/15 text-port-warning' },
  failed: { label: 'No usable pages', cls: 'bg-port-error/15 text-port-error' },
};

function StatusChip({ run }) {
  const meta = (run.status === 'complete' && FINISHED_BY_VERDICT[run.detail?.verdict]) || STATUS[run.status] || STATUS.failed;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
      {isActive(run) && <LoaderCircle size={11} className="animate-spin" aria-hidden="true" />}
      {meta.label}{run.status === 'generating' ? ` ${run.progress?.done ?? 0}/${run.progress?.total ?? run.pageCount}` : ''}
    </span>
  );
}

/** A short name for a page brief: its first clause, for column rows and frame titles. The full text is always kept on the run. */
const briefLabel = (brief) => {
  // A bullet list of guidelines (the default brief) labels by its first guideline, without the bullet.
  const first = String(brief || '').trim().split('\n')[0].replace(/^[-*•]\s*/, '');
  const clause = /^(.{1,40}?)[:.]/.exec(first)?.[1] || first;
  return clause.length > 40 ? `${clause.slice(0, 40).trimEnd()}…` : clause;
};

/** Where a run's pages came from, for card and column subtitles: the provider and effort for a route, else the runtime. */
const runSource = (run) => (run.route ? [run.route.providerName, run.route.effort].filter(Boolean).join(' · ') : run.backend);

// Installed local models join the picker as one entry per runtime, grouped apart from the configured providers. They run straight on the runtime (with tok/s, and a downloaded MTPLX pack switched in for its run), which a provider route cannot do. ProviderModelSelector names a harness id it does not know verbatim, so the group id is its label.
const INSTALLED_GROUP = 'Installed on this machine';
const INSTALLED_PREFIX = 'installed:';

/** The catalog's installed models as picker entries: `{ id, name, models }` per runtime, plus the backend a pick runs on. */
const installedProviders = (models) => {
  const byBackend = new Map();
  for (const m of models) {
    const entry = byBackend.get(m.backend) || { id: `${INSTALLED_PREFIX}${m.backend}`, name: m.runtimeLabel, harnessId: INSTALLED_GROUP, enabled: true, backend: m.backend, models: [] };
    entry.models.push(m.modelId);
    byBackend.set(m.backend, entry);
  }
  return [...byBackend.values()];
};

/** What a row would run, as a comparable key: two rows naming the same target are one run, which the server refuses. */
const targetKey = (t) => (t.backend ? `m:${t.backend}:${t.modelId}` : `r:${t.providerId}:${t.model ?? ''}:${t.effort ?? ''}`);
const supportsHtmlPages = (provider) => supportsStrictToolFreeOneShot(provider)
  || (provider.enabled !== false && provider.htmlPagesModels?.length > 0);
const supportsHtmlPagesModel = (model, provider) => supportsStrictToolFreeOneShot(provider)
  || provider.htmlPagesModels?.includes(model);

/**
 * One model to run: the shared provider > model > effort picker, with the installed local models as extra providers. Reports `{ backend, modelId }` for an installed model, `{ providerId, model, effort }` for a provider route, or null until something is picked.
 */
function TargetRow({ rowKey, index, installed, duplicate, onChange, onRemove }) {
  const { providers, loading, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel } = useProviderModels({ filter: supportsHtmlPages, modelFilter: supportsHtmlPagesModel, withEffort: true, silent: true, preselectDefaults: true });
  // An installed pick lives here; the hook only knows configured providers.
  const [local, setLocal] = useState(null);
  const [effort, setEffort] = useState('');
  const localEntry = local ? installed.find((p) => p.id === local.providerId) : null;
  const providerId = localEntry ? local.providerId : selectedProviderId;
  const model = localEntry ? local.model : selectedModel;

  useEffect(() => {
    let target = null;
    if (localEntry) target = local.model ? { backend: localEntry.backend, modelId: local.model } : null;
    else if (selectedProviderId) target = { providerId: selectedProviderId, model: selectedModel || null, effort: effort || null };
    onChange(rowKey, target);
  }, [rowKey, onChange, localEntry, local, selectedProviderId, selectedModel, effort]);

  const pickProvider = (id) => {
    setEffort('');
    const entry = installed.find((p) => p.id === id);
    if (entry) { setLocal({ providerId: id, model: entry.models[0] || '' }); return; }
    setLocal(null);
    setSelectedProviderId(id);
  };
  const pickModel = (value) => (localEntry ? setLocal((prev) => ({ ...prev, model: value })) : setSelectedModel(value));

  return (
    <div className="flex items-start gap-1 rounded-lg border border-port-border p-2">
      <div className="min-w-0 flex-1">
        <ProviderModelSelector
          providers={[...installed, ...providers]}
          loading={loading}
          selectedProviderId={providerId}
          selectedModel={model}
          availableModels={localEntry ? localEntry.models : availableModels}
          onProviderChange={pickProvider}
          onModelChange={pickModel}
          effort={effort}
          onEffortChange={setEffort}
          label={`Provider ${index + 1}`}
          modelLabel={`Model ${index + 1}`}
          compose={false}
          dense
        />
        {duplicate && <p role="alert" className="mt-1 text-[11px] text-port-error">Already picked above.</p>}
      </div>
      <button type="button" onClick={() => onRemove(rowKey)} aria-label={`Remove model ${index + 1}`} className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded text-gray-500 hover:text-port-error"><X size={14} /></button>
    </div>
  );
}

/**
 * Pick the models and write the page briefs, then queue one run per model.
 * The briefs are sent as typed, between fixed PortOS text that is shown here and in the full prompt. A blank or over-long brief blocks the run instead of being altered.
 */
function RunForm({ catalog, onStarted }) {
  const installed = useMemo(() => installedProviders(catalog.models), [catalog.models]);
  // Each row a stable key plus the target its picker last reported (null until something is picked).
  const [rows, setRows] = useState([{ key: 0, target: null }]);
  const [nextKey, setNextKey] = useState(1);
  const setTarget = useCallback((key, target) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, target } : r))), []);
  const addRow = () => { setRows((prev) => [...prev, { key: nextKey, target: null }]); setNextKey((k) => k + 1); };
  const removeRow = (key) => setRows((prev) => prev.filter((r) => r.key !== key));
  const [pages, setPages] = useState(() => catalog.defaultPages.slice(0, 3));
  const [starting, setStarting] = useState(false);

  const setBrief = (index, value) => setPages((prev) => prev.map((brief, i) => (i === index ? value : brief)));
  const addPage = () => setPages((prev) => [...prev, catalog.defaultPages[prev.length] ?? '']);
  const removePage = (index) => setPages((prev) => prev.filter((_, i) => i !== index));

  const { planBefore, planAfter, before, planLabel, after } = catalog.promptParts;
  const problems = pages.map((brief) => (!brief.trim() ? 'Write a brief for this page, or remove it.' : (brief.length > catalog.briefMaxChars ? `${brief.length} characters — the limit is ${catalog.briefMaxChars}.` : null)));
  const seen = new Set();
  const duplicates = new Set();
  for (const { key, target } of rows) {
    if (!target) continue;
    if (seen.has(targetKey(target))) duplicates.add(key); else seen.add(targetKey(target));
  }
  const targets = rows.map((r) => r.target).filter(Boolean);
  const ready = targets.length > 0 && targets.length <= MAX_TARGETS && duplicates.size === 0 && problems.every((p) => !p);

  const start = async (event) => {
    event.preventDefault();
    if (!ready || starting) return;
    setStarting(true);
    const runs = await startHtmlPageRuns(
      {
        models: targets.filter((t) => t.backend).map(({ backend, modelId }) => ({ backend, modelId })),
        routes: targets.filter((t) => !t.backend),
        pages,
      },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Could not start the runs'); return null; });
    setStarting(false);
    if (runs) onStarted(runs);
  };

  return (
    <form onSubmit={start} className="space-y-4 rounded-xl border border-port-border bg-port-card p-3 sm:p-4">
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-white">Models</h2>
        {rows.map((row, index) => (
          <TargetRow key={row.key} rowKey={row.key} index={index} installed={installed} duplicate={duplicates.has(row.key)} onChange={setTarget} onRemove={removeRow} />
        ))}
        {rows.length < MAX_TARGETS && (
          <button type="button" onClick={addRow} className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded border border-dashed border-port-border px-3 text-xs text-gray-300 hover:border-port-accent hover:text-white sm:w-auto">
            <Plus size={12} /> Add a model
          </button>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-white">Pages</h2>
          <button type="button" onClick={() => setPages(catalog.defaultPages.slice(0, 3))} className="inline-flex min-h-[44px] items-center gap-1 rounded px-2 text-xs text-gray-400 hover:text-white"><RotateCcw size={12} aria-hidden="true" /> Reset to the defaults</button>
        </div>
        {pages.map((brief, index) => (
          <div key={index} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`html-page-brief-${index}`} className="text-xs text-gray-400">Page {index + 1}</label>
              {pages.length > 1 && (
                <button type="button" onClick={() => removePage(index)} aria-label={`Remove page ${index + 1}`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-gray-500 hover:text-port-error"><X size={14} /></button>
              )}
            </div>
            <textarea
              id={`html-page-brief-${index}`}
              value={brief}
              onChange={(e) => setBrief(index, e.target.value)}
              rows={3}
              aria-invalid={Boolean(problems[index])}
              className="w-full resize-y rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-port-accent focus:outline-none"
            />
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className={problems[index] ? 'text-port-error' : 'text-gray-600'} role={problems[index] ? 'alert' : undefined}>{problems[index] || 'Sent exactly as written.'}</span>
              <span className={brief.length > catalog.briefMaxChars ? 'text-port-error' : 'text-gray-600'}>{brief.length}/{catalog.briefMaxChars}</span>
            </div>
          </div>
        ))}
        {pages.length < catalog.pageCountMax && (
          <button type="button" onClick={addPage} className="inline-flex min-h-[44px] items-center gap-1.5 rounded border border-dashed border-port-border px-3 text-xs text-gray-300 hover:border-port-accent hover:text-white">
            <Plus size={12} /> Add a page
          </button>
        )}
        <details className="rounded-lg border border-port-border bg-port-bg px-3 py-2 text-xs text-gray-400">
          <summary className="cursor-pointer text-gray-300">Show the full prompts for each page</summary>
          <p className="mt-2">Each page asks the model for a plan first, then for the page built from your brief and that plan. Both prompts and the plan are kept with the page.</p>
          {pages.map((brief, index) => (
            <div key={index} className="mt-2 space-y-1">
              <p>Page {index + 1}: plan request</p>
              <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded border border-port-border p-2 font-mono text-[11px] text-gray-300">{planBefore + brief + planAfter}</pre>
              <p>Page {index + 1}: page prompt</p>
              <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded border border-port-border p-2 font-mono text-[11px] text-gray-300">{before + brief + planLabel}<span className="text-port-accent">[the model's plan]</span>{after}</pre>
            </div>
          ))}
        </details>
      </div>

      <div className="space-y-2">
        <button type="submit" disabled={!ready || starting} className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-port-accent px-4 text-sm font-medium text-port-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto">
          {starting ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
          {targets.length ? `Run ${targets.length} model${targets.length === 1 ? '' : 's'} × ${pages.length} page${pages.length === 1 ? '' : 's'}` : 'Pick a model to run'}
        </button>
        <p className="text-[11px] text-gray-500">One model after another, a plan request then a page request for each page. Pages preview sandboxed with network access blocked, and are stored exactly as returned.</p>
      </div>
    </form>
  );
}

// Mirrors the server's isRetryable: a failed run, or a finished one with a page that did not pass every check (summaries carry passed/total, not the HTML).
const retryable = (run) => run.status === 'failed' || (run.status === 'complete' && run.pages.some((page) => page.passed !== page.total));

function RunCard({ run, selected, compareFull, onToggle, onDelete, onResume }) {
  const [confirming, setConfirming] = useState(false);
  const [resuming, setResuming] = useState(false);
  const resume = async () => {
    setResuming(true);
    await onResume(run.id);
    setResuming(false);
  };
  return (
    <li className={`flex flex-col gap-2 rounded-xl border bg-port-card p-3 ${selected ? 'border-port-accent' : 'border-port-border'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-all font-mono text-sm text-white">{run.modelId}</h3>
          <p className="text-[11px] text-gray-500">{runSource(run)} · {timeAgo(run.createdAt)}</p>
        </div>
        <StatusChip run={run} />
      </div>
      <p className="text-xs text-gray-400">
        {run.status === 'complete' && (run.detail?.summary || `${run.pages.length} pages`)}
        {run.status === 'failed' && <span className="text-port-error">{run.error || 'Failed'}</span>}
        {isActive(run) && `${run.progress?.done ?? 0} of ${run.progress?.total ?? run.pageCount} pages`}
        {run.status === 'complete' && run.finishedAt && run.startedAt ? ` · ${formatDurationMs(Date.parse(run.finishedAt) - Date.parse(run.startedAt))}` : ''}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onToggle(run.id)} disabled={!selected && compareFull} aria-pressed={selected} className={`min-h-[44px] rounded border px-3 text-xs ${selected ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-300 hover:border-port-accent'} disabled:opacity-40`}>
          {selected ? 'In comparison' : 'Compare'}
        </button>
        {retryable(run) && (
          <button type="button" onClick={resume} disabled={resuming} aria-label={`${run.status === 'failed' ? 'Resume' : 'Retry'} the ${run.modelId} run`} className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-accent px-3 text-xs text-white hover:bg-port-accent/10 disabled:opacity-40">
            <RotateCcw size={13} aria-hidden="true" /> {run.status === 'failed' ? 'Resume' : 'Retry failed pages'}
          </button>
        )}
        {confirming ? (
          <>
            <button type="button" onClick={() => onDelete(run.id)} className="min-h-[44px] rounded border border-port-error px-3 text-xs text-port-error">Delete run</button>
            <button type="button" onClick={() => setConfirming(false)} className="min-h-[44px] rounded border border-port-border px-3 text-xs text-gray-300">Keep</button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} aria-label={`Delete the ${run.modelId} run`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-gray-400 hover:border-port-error hover:text-port-error">
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

/** Selected runs as columns, themes as rows, so one theme reads across every model. */
function Comparison({ ids, onRemove, onClear, onPruneMissing }) {
  const key = ids.join(',');
  const { data: runs, loading, error, refetch } = useSocketResource(
    async ({ signal }) => {
      const settled = await Promise.allSettled(ids.map((id) => getHtmlPageRun(id, { silent: true, signal })));
      // A deleted run (stale bookmark, other tab) is dropped from ?compare= instead of failing the whole panel; any other failure still surfaces.
      const isMissing = (r) => r.status === 'rejected' && (r.reason?.status === 404 || r.reason?.code === 'NOT_FOUND');
      const other = settled.find((r) => r.status === 'rejected' && !isMissing(r));
      if (other) throw other.reason;
      const missing = ids.filter((_, i) => isMissing(settled[i]));
      if (missing.length) onPruneMissing(missing);
      return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    },
    { events: RUN_EVENTS, resourceKey: key, matchesEvent: (payload) => ids.includes(payload?.id), requestTimeoutMs: 30_000 },
  );
  if (error) {
    return (
      <div className="space-y-2">
        <ListLoadError what="the selected runs" error={error} onRetry={refetch} />
        <button type="button" onClick={onClear} className="min-h-[44px] rounded border border-port-border px-3 text-xs text-gray-300 hover:border-port-accent">Clear comparison</button>
      </div>
    );
  }
  if (loading || !runs || runs.length === 0) return <PageSkeleton label="Loading the selected runs" />;

  const rows = Math.max(0, ...runs.map((run) => run.themes.length));
  // A phone shows one column at a time, most of the screen wide, and swipes between them; wider screens fit what they can and scroll the rest.
  const columns = { gridTemplateColumns: `repeat(${runs.length}, minmax(min(85vw, 17rem), 1fr))` };
  return (
    <section aria-label="Comparison" className="space-y-3">
      <div className="-mx-4 snap-x snap-mandatory scroll-px-4 overflow-x-auto px-4 pb-2 md:mx-0 md:scroll-px-0 md:px-0">
        <div className="grid min-w-full gap-3" style={columns}>
          {runs.map((run) => (
            <div key={run.id} className="flex snap-start items-start justify-between gap-2 rounded-lg border border-port-border bg-port-card px-3 py-2">
              <div className="min-w-0">
                <p className="break-all font-mono text-sm text-white">{run.modelId}</p>
                <p className="text-[11px] text-gray-500">{runSource(run)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <StatusChip run={run} />
                <button type="button" onClick={() => onRemove(run.id)} aria-label={`Remove ${run.modelId} from the comparison`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-gray-500 hover:text-white"><X size={14} /></button>
              </div>
            </div>
          ))}
          {Array.from({ length: rows }, (_, row) => (
            runs.map((run) => {
              const page = run.pages[row];
              const brief = run.themes[row];
              const label = briefLabel(brief);
              return (
                <div key={`${run.id}:${row}`} className="min-w-0 snap-start space-y-1">
                  <p className="truncate text-[11px] text-gray-400" title={brief}>{label || '—'}</p>
                  {page
                    ? <HtmlPreviewFrame html={page.html} title={`${run.modelId} — ${label}`} />
                    : <div className="flex aspect-[16/10] items-center justify-center rounded-lg border border-dashed border-port-border text-xs text-gray-500">{isActive(run) ? 'Not generated yet' : 'No page'}</div>}
                  {page && (
                    <div className="space-y-0.5 text-[11px] text-gray-500">
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0">
                          {page.passed}/{page.total} checks · {formatDurationMs(page.elapsedMs + (page.planElapsedMs ?? 0))}{page.tokensPerSecond ? ` · ${Math.round(page.tokensPerSecond)} tok/s` : ''}
                          {Number.isFinite(page.completionTokens) ? ` · ${formatCount(page.completionTokens)} tokens` : ''}
                          {page.error ? <span className="text-port-warning"> · {page.error}</span> : ''}
                        </p>
                        {page.html && <PageFileActions runId={run.id} index={row} label={`${run.modelId} — ${label}`} />}
                      </div>
                      {page.hitTokenLimit && <p className="text-port-warning">Stopped at the token limit — the model was cut off before it finished.</p>}
                      {page.checks?.some((c) => !c.ok) && <p>Failed: {page.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')}</p>}
                      <PagePrompts run={run} page={page} index={row} label={`${run.modelId} — ${label}`} />
                    </div>
                  )}
                </div>
              );
            })
          ))}
        </div>
      </div>
    </section>
  );
}

/** The Create tab: the installed-model catalog the form needs is read only here. */
function CreateTab({ onStarted }) {
  const { data: catalog, error, refetch } = useSocketResource(
    ({ signal }) => listHtmlPageModels({ silent: true, signal }),
    { events: NO_EVENTS, requestTimeoutMs: 30_000 },
  );
  if (error) return <ListLoadError what="installed models" error={error} onRetry={refetch} />;
  return catalog ? <RunForm catalog={catalog} onStarted={onStarted} /> : <PageSkeleton label="Loading installed models" />;
}

export default function HtmlPages() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const compareIds = useMemo(() => (searchParams.get('compare') || '').split(',').filter(Boolean).slice(0, MAX_COMPARE), [searchParams]);
  const tab = tabForPath(pathname);
  const legacyGallery = tab === 'create' && searchParams.get('view') === 'gallery';

  const { data: runs, loading, error, refetch, updateData } = useSocketResource(
    ({ signal }) => listHtmlPageRuns({ silent: true, signal }),
    { events: RUN_EVENTS, requestTimeoutMs: 30_000 },
  );

  const setCompare = useCallback((ids) => {
    const next = new URLSearchParams(searchParams);
    if (ids.length) next.set('compare', ids.join(',')); else next.delete('compare');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const toggle = (id) => setCompare(compareIds.includes(id) ? compareIds.filter((x) => x !== id) : [...compareIds, id]);

  const remove = async (id) => {
    const ok = await deleteHtmlPageRun(id, { silent: true }).then(() => true).catch((err) => { toast.error(err?.message || 'Could not delete that run'); return false; });
    if (!ok) return;
    updateData((prev) => (prev || []).filter((r) => r.id !== id));
    if (compareIds.includes(id)) setCompare(compareIds.filter((x) => x !== id));
  };

  // Keeps the pages the run already finished and asks only for the rest, with the prompts it recorded.
  const resume = async (id) => {
    const queued = await resumeHtmlPageRun(id, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not resume that run'); return null; });
    if (queued) updateData((prev) => (prev || []).map((r) => (r.id === id ? queued : r)));
  };

  const started = (created) => {
    updateData((prev) => [...created, ...(prev || [])]);
    toast.success(`Queued ${created.length} run${created.length === 1 ? '' : 's'}`);
    navigate({ pathname: '/html-pages/runs', search });
  };

  if (legacyGallery) {
    const next = new URLSearchParams(searchParams);
    next.delete('view');
    const query = next.toString();
    return <Navigate to={`/html-pages/gallery${query ? `?${query}` : ''}`} replace />;
  }

  // The comparison rides along between Runs and Gallery.
  const tabs = TABS.map((t) => ({ ...t, to: t.id === 'create' ? t.to : `${t.to}${search}` }));
  const compareFull = compareIds.length >= MAX_COMPARE;
  return (
    <PageLayout
      header={(
        <PageHeader
          icon={GalleryVertical}
          title="HTML Pages"
          subtitle="Ask any model for standalone web pages and compare them side by side."
        />
      )}
      navigation={<RouteTabsHeader tabs={tabs} activeTab={tab} ariaLabel="HTML Pages sections" />}
    >
      <div className="mx-auto max-w-7xl space-y-5">
        {tab === 'create' && <CreateTab onStarted={started} />}

        {tab !== 'create' && compareIds.length > 0 && <Comparison ids={compareIds} onRemove={(id) => toggle(id)} onClear={() => setCompare([])} onPruneMissing={(missing) => setCompare(compareIds.filter((id) => !missing.includes(id)))} />}

        {tab !== 'create' && (
          <section className="space-y-3">
            {error && <ListLoadError what="runs" error={error} onRetry={refetch} />}
            {!error && loading && <PageSkeleton label="Loading runs" />}
            {!error && !loading && runs && runs.length === 0 && (
              <EmptyState icon={GalleryVertical} title="No runs yet" message="Pick a model on the Create tab and run the pages." />
            )}
            {!error && runs && runs.length > 0 && tab === 'gallery' && (
              <HtmlPageGallery runs={runs} compareIds={compareIds} compareFull={compareFull} onCompare={toggle} />
            )}
            {!error && runs && runs.length > 0 && tab === 'runs' && (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {runs.map((run) => (
                  <RunCard key={run.id} run={run} selected={compareIds.includes(run.id)} compareFull={compareFull} onToggle={toggle} onDelete={remove} onResume={resume} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </PageLayout>
  );
}
