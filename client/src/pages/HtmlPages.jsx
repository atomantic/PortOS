import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, Check, GalleryVertical, LoaderCircle, Play, Trash2, X } from 'lucide-react';
import { useSocketResource } from '../hooks/useSocketResource';
import PageSkeleton from '../components/ui/PageSkeleton';
import ListLoadError from '../components/ui/ListLoadError';
import EmptyState from '../components/EmptyState';
import HtmlPreviewFrame from '../components/htmlPages/HtmlPreviewFrame';
import toast from '../components/ui/Toast';
import { deleteHtmlPageRun, getHtmlPageRun, listHtmlPageModels, listHtmlPageRuns, startHtmlPageRuns } from '../services/apiHtmlPages.js';
import { formatDurationMs, timeAgo } from '../utils/formatters';

const RUN_EVENTS = ['html-page-run:changed'];
// The installed-model list changes when the user installs a model, not when a run changes.
const NO_EVENTS = [];
const MAX_COMPARE = 4;

const STATUS = {
  queued: { label: 'Queued', cls: 'bg-port-border text-gray-300' },
  generating: { label: 'Generating', cls: 'bg-port-accent/15 text-port-accent' },
  complete: { label: 'Complete', cls: 'bg-port-success/15 text-port-success' },
  failed: { label: 'Failed', cls: 'bg-port-error/15 text-port-error' },
};
const isActive = (run) => run.status === 'queued' || run.status === 'generating';

function StatusChip({ run }) {
  const meta = STATUS[run.status] || STATUS.failed;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
      {isActive(run) && <LoaderCircle size={11} className="animate-spin" aria-hidden="true" />}
      {meta.label}{run.status === 'generating' ? ` ${run.progress?.done ?? 0}/${run.progress?.total ?? run.pageCount}` : ''}
    </span>
  );
}

/** Pick installed models, then queue one run per model. Names the models, page count and exact prompt before anything runs. */
function RunForm({ catalog, onStarted }) {
  const [selected, setSelected] = useState(() => new Set());
  const [pageCount, setPageCount] = useState(catalog.pageCountDefault);
  const [starting, setStarting] = useState(false);
  const keyOf = (m) => `${m.backend}\u0000${m.modelId}`;
  const byRuntime = useMemo(() => {
    const groups = new Map();
    for (const m of catalog.models) groups.set(m.runtimeLabel, [...(groups.get(m.runtimeLabel) || []), m]);
    return [...groups.entries()];
  }, [catalog.models]);

  const toggle = (m) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(keyOf(m))) next.delete(keyOf(m)); else next.add(keyOf(m));
    return next;
  });

  const chosen = catalog.models.filter((m) => selected.has(keyOf(m)));
  const start = async (event) => {
    event.preventDefault();
    if (!chosen.length || starting) return;
    setStarting(true);
    const runs = await startHtmlPageRuns(
      { models: chosen.map(({ backend, modelId }) => ({ backend, modelId })), pageCount },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Could not start the runs'); return null; });
    setStarting(false);
    if (!runs) return;
    setSelected(new Set());
    onStarted(runs);
  };

  return (
    <form onSubmit={start} className="space-y-3 rounded-xl border border-port-border bg-port-card p-4">
      <div>
        <h3 className="text-sm font-medium text-white">Run a comparison</h3>
        <p className="mt-1 text-xs text-gray-400">
          Each selected model is asked for the same fixed pages, one request per page, one after another. Pick as many installed models as you like.
        </p>
      </div>

      {catalog.listErrors.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-port-warning" role="alert">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          Could not read: {catalog.listErrors.map((e) => `${e.label}${e.offline ? ' (not running)' : ''}`).join(', ')}.
        </p>
      )}
      {catalog.models.length === 0 && <p className="text-xs text-gray-500">No installed models were found on any runtime.</p>}

      <div className="space-y-2">
        {byRuntime.map(([label, models]) => (
          <fieldset key={label} className="min-w-0">
            <legend className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</legend>
            <div className="flex flex-wrap gap-2">
              {models.map((m) => {
                const on = selected.has(keyOf(m));
                return (
                  <label key={keyOf(m)} className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${on ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-300 hover:border-port-accent'}`}>
                    <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(m)} />
                    <span className={`flex h-4 w-4 items-center justify-center rounded border ${on ? 'border-port-accent bg-port-accent text-port-on-accent' : 'border-port-border'}`} aria-hidden="true">
                      {on && <Check size={11} />}
                    </span>
                    <span className="break-all font-mono">{m.modelId}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="html-pages-count" className="mb-1 block text-xs text-gray-400">Pages per model</label>
          <select id="html-pages-count" value={pageCount} onChange={(e) => setPageCount(Number(e.target.value))} className="min-h-[44px] rounded-lg border border-port-border bg-port-bg px-3 text-sm text-white focus:border-port-accent focus:outline-none">
            {Array.from({ length: catalog.pageCountMax }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button type="submit" disabled={!chosen.length || starting} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 text-sm font-medium text-port-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
          {starting ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
          {chosen.length ? `Run ${chosen.length} model${chosen.length === 1 ? '' : 's'} × ${pageCount} page${pageCount === 1 ? '' : 's'}` : 'Select models to run'}
        </button>
      </div>

      <details className="text-xs text-gray-400">
        <summary className="cursor-pointer text-gray-300">What PortOS will send</summary>
        <p className="mt-2">Page N always uses theme N, so every model gets the same brief: {catalog.themes.slice(0, pageCount).map((t) => t.split(':')[0]).join(', ')}.</p>
        <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-port-border bg-port-bg p-3 font-mono text-[11px] leading-relaxed text-gray-300">{catalog.promptExample}</pre>
        <p className="mt-2">Pages are previewed in a sandbox with network access blocked. The model&apos;s HTML is stored exactly as it returned it.</p>
      </details>
    </form>
  );
}

function RunCard({ run, selected, compareFull, onToggle, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const checked = run.pages.filter((p) => p.passed === p.total).length;
  return (
    <li className={`flex flex-col gap-2 rounded-xl border bg-port-card p-3 ${selected ? 'border-port-accent' : 'border-port-border'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="break-all font-mono text-sm text-white">{run.modelId}</h4>
          <p className="text-[11px] text-gray-500">{run.backend} · {timeAgo(run.createdAt)}</p>
        </div>
        <StatusChip run={run} />
      </div>
      <p className="text-xs text-gray-400">
        {run.status === 'complete' && (run.detail?.summary || `${run.pages.length} pages`)}
        {run.status === 'failed' && <span className="text-port-error">{run.error || 'Failed'}</span>}
        {isActive(run) && `${run.progress?.done ?? 0} of ${run.progress?.total ?? run.pageCount} pages`}
        {run.status === 'complete' && run.finishedAt && run.startedAt ? ` · ${formatDurationMs(Date.parse(run.finishedAt) - Date.parse(run.startedAt))}` : ''}
      </p>
      {run.pages.length > 0 && <p className="text-[11px] text-gray-500">{checked} of {run.pages.length} pages pass every check</p>}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onToggle(run.id)} disabled={!selected && compareFull} aria-pressed={selected} className={`min-h-[44px] rounded border px-3 text-xs ${selected ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-300 hover:border-port-accent'} disabled:opacity-40`}>
          {selected ? 'In comparison' : 'Compare'}
        </button>
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
function Comparison({ ids, onRemove }) {
  const key = ids.join(',');
  const { data: runs, loading, error } = useSocketResource(
    async ({ signal }) => Promise.all(ids.map((id) => getHtmlPageRun(id, { silent: true, signal }))),
    { events: RUN_EVENTS, resourceKey: key, matchesEvent: (payload) => ids.includes(payload?.id), requestTimeoutMs: 30_000 },
  );
  if (error) return <ListLoadError what="the selected runs" error={error} />;
  if (loading || !runs) return <PageSkeleton label="Loading the selected runs" />;

  const themes = runs.reduce((longest, run) => (run.themes.length > longest.length ? run.themes : longest), []);
  const columns = { gridTemplateColumns: `repeat(${runs.length}, minmax(17rem, 1fr))` };
  return (
    <section aria-label="Comparison" className="space-y-3">
      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-full gap-3" style={columns}>
          {runs.map((run) => (
            <div key={run.id} className="flex items-start justify-between gap-2 rounded-lg border border-port-border bg-port-card px-3 py-2">
              <div className="min-w-0">
                <p className="break-all font-mono text-sm text-white">{run.modelId}</p>
                <p className="text-[11px] text-gray-500">{run.backend}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <StatusChip run={run} />
                <button type="button" onClick={() => onRemove(run.id)} aria-label={`Remove ${run.modelId} from the comparison`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-gray-500 hover:text-white"><X size={14} /></button>
              </div>
            </div>
          ))}
          {themes.map((theme, row) => (
            runs.map((run) => {
              const page = run.pages[row];
              return (
                <div key={`${run.id}:${row}`} className="min-w-0 space-y-1">
                  <p className="truncate text-[11px] text-gray-400" title={theme}>{theme.split(':')[0]}</p>
                  {page
                    ? <HtmlPreviewFrame html={page.html} title={`${run.modelId} — ${theme.split(':')[0]}`} />
                    : <div className="flex aspect-[16/10] items-center justify-center rounded-lg border border-dashed border-port-border text-xs text-gray-500">{isActive(run) ? 'Not generated yet' : 'No page'}</div>}
                  {page && (
                    <p className="text-[11px] text-gray-500">
                      {page.passed}/{page.total} checks · {formatDurationMs(page.elapsedMs)}{page.tokensPerSecond ? ` · ${Math.round(page.tokensPerSecond)} tok/s` : ''}
                      {page.error ? <span className="text-port-warning"> · {page.error}</span> : ''}
                    </p>
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

export default function HtmlPages() {
  const [searchParams, setSearchParams] = useSearchParams();
  const compareIds = useMemo(() => (searchParams.get('compare') || '').split(',').filter(Boolean).slice(0, MAX_COMPARE), [searchParams]);

  const { data: catalog, error: catalogError, refetch: refetchCatalog } = useSocketResource(
    ({ signal }) => listHtmlPageModels({ silent: true, signal }),
    { events: NO_EVENTS, requestTimeoutMs: 30_000 },
  );
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

  const started = (created) => {
    updateData((prev) => [...created, ...(prev || [])]);
    toast.success(`Queued ${created.length} run${created.length === 1 ? '' : 's'}`);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex items-start gap-3">
        <GalleryVertical className="mt-0.5 h-7 w-7 shrink-0 text-port-accent" aria-hidden="true" />
        <div>
          <h2 className="text-xl font-semibold text-white">HTML Pages</h2>
          <p className="mt-1 text-sm text-gray-400">
            Ask local models for creative standalone web pages and compare them side by side. Every run is kept here as a reference.
          </p>
        </div>
      </header>

      {catalogError
        ? <ListLoadError what="installed models" error={catalogError} onRetry={refetchCatalog} />
        : (catalog ? <RunForm catalog={catalog} onStarted={started} /> : <PageSkeleton label="Loading installed models" />)}

      {compareIds.length > 0 && <Comparison ids={compareIds} onRemove={(id) => toggle(id)} />}

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Runs</h3>
        {error && <ListLoadError what="runs" error={error} onRetry={refetch} />}
        {!error && loading && <PageSkeleton label="Loading runs" />}
        {!error && !loading && runs && runs.length === 0 && (
          <EmptyState icon={GalleryVertical} title="No runs yet" message="Select one or more models above and run the brief." />
        )}
        {!error && runs && runs.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} selected={compareIds.includes(run.id)} compareFull={compareIds.length >= MAX_COMPARE} onToggle={toggle} onDelete={remove} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
