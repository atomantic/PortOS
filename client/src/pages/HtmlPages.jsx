import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { GalleryVertical, LoaderCircle, Play, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useSocketResource } from '../hooks/useSocketResource';
import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import PageSkeleton from '../components/ui/PageSkeleton';
import ListLoadError from '../components/ui/ListLoadError';
import EmptyState from '../components/EmptyState';
import HtmlPreviewFrame from '../components/htmlPages/HtmlPreviewFrame';
import ProviderModelSelector from '../components/ProviderModelSelector';
import useProviderModels from '../hooks/useProviderModels';
import toast from '../components/ui/Toast';
import { deleteHtmlPageRun, getHtmlPageRun, listHtmlPageModels, listHtmlPageRuns, resumeHtmlPageRun, startHtmlPageRuns } from '../services/apiHtmlPages.js';
import { formatDurationMs, timeAgo } from '../utils/formatters';

const RUN_EVENTS = ['html-page-run:changed'];
// The installed-model list changes when the user installs a model, not when a run changes.
const NO_EVENTS = [];
const MAX_COMPARE = 4;
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

/** Where a run's pages came from, for card and column subtitles: the provider and effort for a route, else the runtime and any LoRA adapter it applied. */
const runSource = (run) => (run.route
  ? [run.route.providerName, run.route.effort].filter(Boolean).join(' · ')
  : [run.backend, run.lora && `LoRA ${run.lora.name} ×${run.lora.scale}`].filter(Boolean).join(' · '));

// The strengths offered for an adapter. 1 is the scale it was trained at; 0.5 shows whether a partial dose moves the output.
const LORA_SCALES = [1, 0.5];
const loraValue = (lora) => (lora ? `${lora.id}@${lora.scale}` : '');
const parseLoraValue = (value) => {
  const [id, scale] = String(value).split('@').map(Number);
  return Number.isInteger(id) && Number.isFinite(scale) ? { id, scale } : null;
};

// Installed local models join the picker as one entry per runtime, grouped apart from the configured providers. They run straight on the runtime (with tok/s, and a downloaded MTPLX pack switched in for its run), which a provider route cannot do. ProviderModelSelector names a harness id it does not know verbatim, so the group id is its label.
const INSTALLED_GROUP = 'Installed on this machine';
const INSTALLED_PREFIX = 'installed:';

/** The catalog's installed models as picker entries: `{ id, name, models }` per runtime, plus the backend a pick runs on. */
const installedProviders = (models) => {
  const byBackend = new Map();
  for (const m of models) {
    const entry = byBackend.get(m.backend) || { id: `${INSTALLED_PREFIX}${m.backend}`, name: m.runtimeLabel, harnessId: INSTALLED_GROUP, enabled: true, backend: m.backend, models: [], loraAdapters: [] };
    entry.models.push(m.modelId);
    // A llama.cpp server's adapters apply to whatever it serves, so they are the runtime's, not one model's.
    if (m.loraAdapters?.length && !entry.loraAdapters.length) entry.loraAdapters = m.loraAdapters;
    byBackend.set(m.backend, entry);
  }
  return [...byBackend.values()];
};

/** What a row would run, as a comparable key: two rows naming the same target are one run, which the server refuses. */
const targetKey = (t) => (t.backend ? `m:${t.backend}:${t.modelId}:${loraValue(t.lora)}` : `r:${t.providerId}:${t.model ?? ''}:${t.effort ?? ''}`);

/**
 * One model to run: the shared provider > model > effort picker, with the installed local models as extra providers, plus a LoRA choice when the llama.cpp server has adapters loaded. Reports `{ backend, modelId, lora }` for an installed model, `{ providerId, model, effort }` for a provider route, or null until something is picked.
 */
function TargetRow({ rowKey, index, installed, duplicate, onChange, onRemove }) {
  const { providers, loading, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel } = useProviderModels({ withEffort: true, silent: true, preselectDefaults: true });
  // An installed pick lives here; the hook only knows configured providers.
  const [local, setLocal] = useState(null);
  const [effort, setEffort] = useState('');
  const [lora, setLora] = useState(null);
  const localEntry = local ? installed.find((p) => p.id === local.providerId) : null;
  const providerId = localEntry ? local.providerId : selectedProviderId;
  const model = localEntry ? local.model : selectedModel;
  const adapters = localEntry?.loraAdapters || [];
  const loraPick = adapters.some((a) => a.id === lora?.id) ? lora : null;

  useEffect(() => {
    let target = null;
    if (localEntry) target = local.model ? { backend: localEntry.backend, modelId: local.model, lora: loraPick } : null;
    else if (selectedProviderId) target = { providerId: selectedProviderId, model: selectedModel || null, effort: effort || null };
    onChange(rowKey, target);
  }, [rowKey, onChange, localEntry, local, loraPick, selectedProviderId, selectedModel, effort]);

  const pickProvider = (id) => {
    setEffort('');
    setLora(null);
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
          dense
        />
        {adapters.length > 0 && (
          <div className="mt-1">
            <label htmlFor={`html-pages-lora-${rowKey}`} className="mb-1 block text-xs text-gray-500">LoRA adapter {index + 1}</label>
            <select
              id={`html-pages-lora-${rowKey}`}
              value={loraValue(loraPick)}
              onChange={(e) => setLora(parseLoraValue(e.target.value))}
              className="min-h-[36px] w-full rounded-lg border border-port-border bg-port-bg px-3 py-1.5 text-sm text-white sm:min-h-8 sm:py-1 sm:text-xs"
            >
              <option value="">None (base model)</option>
              {adapters.flatMap((a) => LORA_SCALES.map((scale) => (
                <option key={`${a.id}@${scale}`} value={`${a.id}@${scale}`}>{a.name} ×{scale}</option>
              )))}
            </select>
          </div>
        )}
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

  const { before, after } = catalog.promptParts;
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
        models: targets.filter((t) => t.backend).map(({ backend, modelId, lora: pick }) => ({ backend, modelId, ...(pick ? { lora: pick } : {}) })),
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
          <summary className="cursor-pointer text-gray-300">Text PortOS adds around each brief</summary>
          <p className="mt-2">Before your brief:</p>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-port-border p-2 font-mono text-[11px] text-gray-300">{before}</pre>
          <p className="mt-2">After your brief:</p>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-port-border p-2 font-mono text-[11px] text-gray-300">{after}</pre>
        </details>
        <details className="rounded-lg border border-port-border bg-port-bg px-3 py-2 text-xs text-gray-400">
          <summary className="cursor-pointer text-gray-300">Show the full prompt for each page</summary>
          {pages.map((brief, index) => (
            <div key={index} className="mt-2">
              <p>Page {index + 1}</p>
              <pre className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded border border-port-border p-2 font-mono text-[11px] text-gray-300">{before + brief + after}</pre>
            </div>
          ))}
        </details>
      </div>

      <div className="space-y-2">
        <button type="submit" disabled={!ready || starting} className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-port-accent px-4 text-sm font-medium text-port-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto">
          {starting ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
          {targets.length ? `Run ${targets.length} model${targets.length === 1 ? '' : 's'} × ${pages.length} page${pages.length === 1 ? '' : 's'}` : 'Pick a model to run'}
        </button>
        <p className="text-[11px] text-gray-500">One model after another, one request per page. Pages preview sandboxed with network access blocked, and are stored exactly as returned.</p>
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
function Comparison({ ids, onRemove }) {
  const key = ids.join(',');
  const { data: runs, loading, error } = useSocketResource(
    async ({ signal }) => Promise.all(ids.map((id) => getHtmlPageRun(id, { silent: true, signal }))),
    { events: RUN_EVENTS, resourceKey: key, matchesEvent: (payload) => ids.includes(payload?.id), requestTimeoutMs: 30_000 },
  );
  if (error) return <ListLoadError what="the selected runs" error={error} />;
  if (loading || !runs) return <PageSkeleton label="Loading the selected runs" />;

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
                      <p>
                        {page.passed}/{page.total} checks · {formatDurationMs(page.elapsedMs)}{page.tokensPerSecond ? ` · ${Math.round(page.tokensPerSecond)} tok/s` : ''}
                        {page.error ? <span className="text-port-warning"> · {page.error}</span> : ''}
                      </p>
                      {page.hitTokenLimit && <p className="text-port-warning">Stopped at the token limit — the model was cut off before it finished.</p>}
                      {page.checks?.some((c) => !c.ok) && <p>Failed: {page.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')}</p>}
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

  // Keeps the pages the run already finished and asks only for the rest, with the prompts it recorded.
  const resume = async (id) => {
    const queued = await resumeHtmlPageRun(id, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not resume that run'); return null; });
    if (queued) updateData((prev) => (prev || []).map((r) => (r.id === id ? queued : r)));
  };

  const started = (created) => {
    updateData((prev) => [...created, ...(prev || [])]);
    toast.success(`Queued ${created.length} run${created.length === 1 ? '' : 's'}`);
  };

  return (
    <PageLayout
      header={(
        <PageHeader
          icon={GalleryVertical}
          title="HTML Pages"
          subtitle="Ask any model for standalone web pages and compare them side by side."
        />
      )}
    >
      <div className="mx-auto max-w-7xl space-y-5">
        {catalogError
          ? <ListLoadError what="installed models" error={catalogError} onRetry={refetchCatalog} />
          : (catalog ? <RunForm catalog={catalog} onStarted={started} /> : <PageSkeleton label="Loading installed models" />)}

        {compareIds.length > 0 && <Comparison ids={compareIds} onRemove={(id) => toggle(id)} />}

        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Runs</h2>
          {error && <ListLoadError what="runs" error={error} onRetry={refetch} />}
          {!error && loading && <PageSkeleton label="Loading runs" />}
          {!error && !loading && runs && runs.length === 0 && (
            <EmptyState icon={GalleryVertical} title="No runs yet" message="Pick a model above and run the pages." />
          )}
          {!error && runs && runs.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {runs.map((run) => (
                <RunCard key={run.id} run={run} selected={compareIds.includes(run.id)} compareFull={compareIds.length >= MAX_COMPARE} onToggle={toggle} onDelete={remove} onResume={resume} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageLayout>
  );
}
