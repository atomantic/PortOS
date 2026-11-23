import { useEffect, useMemo, useRef, useState } from 'react';
import HtmlPreviewFrame from './HtmlPreviewFrame';
import PageFileActions from './PageFileActions';
import PagePrompts from './PagePrompts';
import { getHtmlPageRun } from '../../services/apiHtmlPages.js';
import { formatCount, formatDurationMs, timeAgo } from '../../utils/formatters';

// Enough to fill a wide screen twice; each frame is a live sandboxed page, so the rest wait for "Show more".
const PAGE_SIZE = 12;

/** A page's own finish time; pages stored before it was recorded fall back to their run's. */
const pageTime = (run, page) => page.finishedAt || run.finishedAt || run.startedAt || run.createdAt;

/** Every generated page across the stored runs, newest first. Summaries carry no HTML; a card loads its run's pages once it scrolls into view. */
export const galleryEntries = (runs) => (runs || [])
  .flatMap((run) => (run.pages || []).map((page, index) => ({ run, page, index, at: pageTime(run, page) })))
  .filter(({ page }) => page.bytes > 0)
  .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

const modelKey = (run) => `${run.backend}:${run.route?.providerId ?? ''}:${run.modelId}`;
const sourceLabel = (run) => (run.route ? [run.route.providerName, run.route.effort].filter(Boolean).join(' · ') : run.backend);

function GalleryCard({ entry, loadRun, inComparison, compareFull, onCompare }) {
  const { run, page, index, at } = entry;
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  // The page as its full run read has it: the HTML, and the prompts and plan behind it.
  const [full, setFull] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return undefined;
    const observer = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { rootMargin: '400px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    let active = true;
    loadRun(run).then((loaded) => {
      if (active) setFull({ run: loaded, page: loaded?.pages?.[index] ?? { html: '' } });
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [visible, loadRun, run, index]);

  const title = `${run.modelId} — page ${index + 1}`;
  return (
    <li ref={ref} className="flex min-w-0 flex-col gap-2 rounded-xl border border-port-border bg-port-card p-3">
      {full?.page.html
        ? <HtmlPreviewFrame html={full.page.html} title={title} />
        : (
          <div className="flex aspect-[16/10] items-center justify-center rounded-lg border border-dashed border-port-border bg-port-bg text-xs text-gray-500">
            {failed ? 'Could not load this page' : (full ? 'No HTML came back for this page' : 'Loading…')}
          </div>
        )}
      <div className="min-w-0">
        <p className="break-all font-mono text-sm text-white">{run.modelId}</p>
        <p className="text-[11px] text-gray-500">{sourceLabel(run)} · {timeAgo(at)}</p>
      </div>
      <dl className="grid grid-cols-3 gap-1 text-[11px]">
        <div><dt className="text-gray-500" title="Plan and page together">Time</dt><dd className="text-gray-200">{Number.isFinite(page.elapsedMs) ? formatDurationMs(page.elapsedMs + (page.planElapsedMs ?? 0)) : '—'}</dd></div>
        <div><dt className="text-gray-500">tok/s</dt><dd className="text-gray-200">{formatCount(page.tokensPerSecond, { maximumFractionDigits: 1 })}</dd></div>
        <div><dt className="text-gray-500">Tokens</dt><dd className="text-gray-200">{formatCount(page.completionTokens)}</dd></div>
      </dl>
      {full && <PagePrompts run={full.run} page={full.page} index={index} label={title} />}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <span className={`text-[11px] ${page.passed === page.total ? 'text-port-success' : 'text-port-warning'}`}>{page.passed}/{page.total} checks</span>
        <PageFileActions runId={run.id} index={index} label={title} />
        <button type="button" onClick={() => onCompare(run.id)} disabled={!inComparison && compareFull} aria-pressed={inComparison} aria-label={`${inComparison ? 'In comparison' : 'Compare'}: the ${run.modelId} run`} className={`min-h-[44px] rounded border px-3 text-xs ${inComparison ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-300 hover:border-port-accent'} disabled:opacity-40`}>
          {inComparison ? 'In comparison' : 'Compare run'}
        </button>
      </div>
    </li>
  );
}

/**
 * Every page the bench has stored, newest first, with the model, when it finished, how long it took, its tok/s and its token count, and the prompt and plan behind it to copy. Filter by model; open a page full size from its frame, download it or copy its file path, or add its run to the comparison.
 */
export default function HtmlPageGallery({ runs, compareIds, compareFull, onCompare }) {
  const [model, setModel] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  // One full-run read per run version, shared by that run's cards; a resumed run gets a new updatedAt and reloads.
  const cache = useRef(new Map());
  const loadRun = useMemo(() => (run) => {
    const key = `${run.id}:${run.updatedAt ?? ''}`;
    if (!cache.current.has(key)) {
      const pending = getHtmlPageRun(run.id, { silent: true });
      pending.catch(() => cache.current.delete(key));
      cache.current.set(key, pending);
    }
    return cache.current.get(key);
  }, []);

  const entries = useMemo(() => galleryEntries(runs), [runs]);
  const models = useMemo(() => {
    const seen = new Map();
    for (const { run } of entries) if (!seen.has(modelKey(run))) seen.set(modelKey(run), `${run.modelId} (${sourceLabel(run)})`);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);
  const filtered = model ? entries.filter(({ run }) => modelKey(run) === model) : entries;

  if (entries.length === 0) return <p className="text-xs text-gray-500">No pages yet. Finished pages from every run land here.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 sm:max-w-xs">
          <label htmlFor="html-pages-gallery-model" className="mb-1 block text-xs text-gray-500">Model</label>
          <select id="html-pages-gallery-model" value={model} onChange={(e) => { setModel(e.target.value); setShown(PAGE_SIZE); }} className="min-h-[36px] w-full rounded-lg border border-port-border bg-port-bg px-3 py-1.5 text-sm text-white">
            <option value="">All models</option>
            {models.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </div>
        <p className="text-xs text-gray-500">{formatCount(filtered.length)} page{filtered.length === 1 ? '' : 's'}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.slice(0, shown).map((entry) => (
          <GalleryCard key={`${entry.run.id}:${entry.index}`} entry={entry} loadRun={loadRun} inComparison={compareIds.includes(entry.run.id)} compareFull={compareFull} onCompare={onCompare} />
        ))}
      </ul>
      {filtered.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + PAGE_SIZE)} className="inline-flex min-h-[44px] w-full items-center justify-center rounded border border-port-border px-3 text-xs text-gray-300 hover:border-port-accent hover:text-white sm:w-auto">
          Show {formatCount(Math.min(PAGE_SIZE, filtered.length - shown))} more
        </button>
      )}
    </div>
  );
}
