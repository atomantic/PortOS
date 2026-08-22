import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, HardDrive, RefreshCw, Search, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import ProgressBar from '../ui/ProgressBar';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import { formatAgeDays, formatBytes, formatDateNumeric } from '../../utils/formatters';

/**
 * MTPLX checkpoint manager — search, download, and remove MTP model weights.
 *
 * This replaces the card's old answer to an empty cache, which was to print
 * `mtplx pull` and tell the user to go run it in a terminal. PortOS installs the
 * runtime, starts it, stops it, logs it, and persists it across a reboot; making
 * the one step in the middle a shell command the user has to leave the app for
 * was the odd one out (PRD NR-9).
 *
 * A download is still never implicit: it moves tens of gigabytes and only runs
 * from a button pressed here that names what it will fetch.
 *
 * The search source is `mtplx forge discover`, upstream's index of MTPLX-branded
 * checkpoints — deliberately not a raw Hugging Face search, which would mostly
 * offer models that download for an hour and then fail MTPLX's file check.
 */

const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50';
const accentBtn = `${btn} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`;
const neutralBtn = `${btn} bg-port-border hover:bg-port-border/70 text-white`;
const dangerBtn = `${btn} bg-port-error/10 hover:bg-port-error/20 text-port-error`;

/**
 * A pull frame carries byte counters only once the transfer starts — until then
 * (`resolving`, `verifying`) there is no total, which is exactly the shared
 * bar's `percent={null}` indeterminate case rather than a misleading 0%.
 */
function DownloadProgress({ download }) {
  const { received = 0, total = 0, message } = download;
  const pct = total > 0 ? (received / total) * 100 : null;
  return (
    <div className="space-y-1">
      <ProgressBar percent={pct} track="border" label={`Downloading ${download.model || 'MTPLX default checkpoint'}`} />
      <p className="text-[11px] text-gray-500">
        {pct === null
          ? (message || 'Downloading…')
          : `${formatBytes(received)} of ${formatBytes(total)} (${Math.round(pct)}%)`}
      </p>
    </div>
  );
}

export default function MtplxCheckpoints({
  cached,
  cacheError,
  download,
  busy,
  actionInProgress,
  onSearch,
  onPull,
  onRemove,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [searching, setSearching] = useState(false);
  // Shared single-at-a-time arm/confirm state — arming a second row disarms the
  // first, and nothing reaches `window.confirm`.
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const cachedRepos = new Set(cached.map((row) => row.repo));

  const runSearch = useCallback((text) => {
    setSearching(true);
    setSearchError(null);
    return onSearch({ query: text })
      .then((res) => {
        // `error` is MTPLX's own reason (offline, rate-limited) — surface it
        // rather than rendering an empty list that reads as "nothing exists".
        setSearchError(res?.error || null);
        setResults(res?.models || []);
      })
      .finally(() => setSearching(false));
  }, [onSearch]);

  // Load upstream's default listing once, so an empty cache lands on something
  // to click instead of an empty box with a search field. One HTTP call to
  // Hugging Face — no weights, no model load.
  //
  // Guarded by a ref rather than by `runSearch`'s identity: the parent re-renders
  // on every status poll, and a dep-driven effect would re-hit Hugging Face on
  // each one.
  const didInitialSearch = useRef(false);
  useEffect(() => {
    if (didInitialSearch.current) return;
    didInitialSearch.current = true;
    runSearch('');
  }, [runSearch]);

  const pulling = Boolean(download);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-gray-300 flex items-center gap-1.5">
            <HardDrive size={12} className="text-port-accent" />
            Cached checkpoints
          </h3>
          {cached.length > 0 && (
            <span className="text-[11px] text-gray-500">
              {formatBytes(cached.reduce((sum, row) => sum + (row.sizeBytes || 0), 0))} on disk
            </span>
          )}
        </div>

        {cacheError ? (
          <p className="text-xs text-gray-500">Couldn't read MTPLX's model cache ({cacheError}).</p>
        ) : cached.length === 0 ? (
          <div className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-3 space-y-2">
            <p className="text-xs text-port-warning">
              MTPLX has no checkpoints yet, so its server exits before it binds a port. Download one below — MTPLX's own verified default is the safe pick.
            </p>
            <button onClick={() => onPull(null)} disabled={busy || pulling} className={accentBtn}>
              {actionInProgress === 'mtplx-pull' ? <BrailleSpinner /> : <Download size={13} />}
              Download default checkpoint
            </button>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {cached.map((row) => (
              <li key={row.repo} className="flex flex-col sm:flex-row sm:items-center gap-2 bg-port-bg border border-port-border rounded-lg px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-white truncate">{row.repo}</p>
                  <p className="text-[11px] text-gray-500 flex items-center gap-1.5 flex-wrap">
                    {row.sizeBytes ? <span>{formatBytes(row.sizeBytes)}</span> : null}
                    {row.valid === false ? (
                      <span className="text-port-warning flex items-center gap-1">
                        <AlertTriangle size={10} /> incomplete — remove and download again
                      </span>
                    ) : row.hasRuntimeContract ? (
                      <span className="text-port-success flex items-center gap-1">
                        <CheckCircle2 size={10} /> verified MTP contract
                      </span>
                    ) : null}
                  </p>
                </div>
                {isConfirming(row.repo) ? (
                  <ConfirmButtonPair
                    className="shrink-0"
                    prompt="Delete these weights?"
                    confirmIcon={Trash2}
                    busy={actionInProgress === `mtplx-remove-${row.repo}`}
                    busyText="Deleting"
                    onConfirm={() => confirmDelete(() => onRemove(row.repo))}
                    onCancel={cancelDelete}
                    ariaLabel={`Confirm removing ${row.repo}`}
                  />
                ) : (
                  <button
                    onClick={() => requestDelete(row.repo)}
                    disabled={busy}
                    className={`${dangerBtn} shrink-0`}
                    title={`Delete ${row.repo} from MTPLX's cache`}
                  >
                    <Trash2 size={12} />
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {download && (
        <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
          <p className="text-xs text-gray-300 truncate">
            Downloading <code className="text-port-accent">{download.model || 'MTPLX default checkpoint'}</code>
          </p>
          <DownloadProgress download={download} />
          <p className="text-[11px] text-gray-500">This runs in the background — leaving this page won't cancel it.</p>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-gray-300 flex items-center gap-1.5">
          <Search size={12} className="text-port-accent" />
          Find a checkpoint
        </h3>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); runSearch(query); }}
        >
          <label htmlFor="mtplx-model-search" className="sr-only">Search MTPLX checkpoints</label>
          <input
            id="mtplx-model-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search MTPLX-branded models on Hugging Face…"
            className="flex-1 min-w-0 bg-port-card border border-port-border rounded px-2 py-1.5 text-xs text-white"
          />
          <button type="submit" disabled={searching} className={neutralBtn}>
            {searching ? <BrailleSpinner /> : <RefreshCw size={12} />}
            Search
          </button>
        </form>

        {searchError && <p className="text-xs text-port-warning">{searchError}</p>}

        {results !== null && results.length === 0 && !searchError && (
          <p className="text-xs text-gray-500">No MTPLX-branded checkpoints matched that search.</p>
        )}

        {results !== null && results.length > 0 && (
          <ul className="space-y-1.5 max-h-72 overflow-y-auto">
            {results.map((row) => {
              const installed = cachedRepos.has(row.repo);
              const age = formatAgeDays(row.publishedAt);
              return (
                <li key={row.repo} className="flex flex-col sm:flex-row sm:items-center gap-2 bg-port-bg border border-port-border rounded-lg px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-white truncate">{row.name}</p>
                    <p className="text-[11px] text-gray-500 truncate">
                      {row.repo}
                      {Number.isFinite(row.downloads) ? ` · ${row.downloads.toLocaleString()} downloads` : ''}
                      {/* Age in days, not a "3mo ago" bucket: a checkpoint's release
                          date is what says whether it is worth a multi-gigabyte pull. */}
                      {age && <span title={`Published ${formatDateNumeric(row.publishedAt)}`}>{` · published ${age}`}</span>}
                      {row.license ? ` · ${row.license}` : ''}
                    </p>
                  </div>
                  {installed ? (
                    <span className="text-[11px] text-port-success shrink-0 flex items-center gap-1">
                      <CheckCircle2 size={11} /> Cached
                    </span>
                  ) : (
                    <button
                      onClick={() => onPull(row.repo)}
                      disabled={busy || pulling}
                      className={`${accentBtn} shrink-0`}
                      title={`Download ${row.repo} into MTPLX's cache — a multi-gigabyte transfer`}
                    >
                      {actionInProgress === `mtplx-pull-${row.repo}` ? <BrailleSpinner /> : <Download size={12} />}
                      Download
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
