import { useState, useRef } from 'react';
import { Upload, Loader2, CheckCircle2 } from 'lucide-react';
import toast from '../ui/Toast';

// Shared bulk-backfill importer panel for the timeline (#2160). Two-step flow:
// pick a file → preview (parse-only, no write) → confirm import. The import is
// idempotent server-side, so re-importing the same or overlapping export never
// double-counts. Collapsed by default so it stays out of the way of the day
// timeline; `onImported` lets the page refresh once new events land.
//
// Source-specific bits are props so each source (Spotify, Takeout location, …)
// is a thin wrapper around this one seam:
//   icon         — lucide icon component for the toggle header
//   title        — header label ("Import Spotify history")
//   noun         — the record noun, singular ("play", "visit") for button/toasts
//   help         — JSX help text (where to get the export)
//   importFn     — (file, { preview, silent }) => Promise<result>
//   renderPreview— (summary) => JSX for the preview details block
export default function ActivityImportPanel({ icon: Icon, title, noun, help, importFn, renderPreview, onImported }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  // Monotonic request id — a response only applies if it's still the latest
  // request, so swapping the file mid-flight can't let a stale response land on
  // the new selection.
  const reqIdRef = useRef(0);

  const reset = () => { reqIdRef.current += 1; setFile(null); setPreview(null); setResult(null); };

  const pickFile = (e) => {
    const next = e.target.files?.[0] || null;
    reqIdRef.current += 1; // invalidate any in-flight response for the old file
    setFile(next);
    setPreview(null);
    setResult(null);
  };

  const runPreview = () => {
    if (!file || busy) return;
    const rid = ++reqIdRef.current;
    setBusy(true);
    setResult(null);
    importFn(file, { preview: true, silent: true })
      .then((res) => {
        if (rid !== reqIdRef.current) return;
        setPreview(res);
        if (!res.mapped) toast.error(`No ${noun} records found in that file.`);
      })
      .catch((err) => { if (rid === reqIdRef.current) toast.error(`Preview failed: ${err.message}`); })
      .finally(() => { if (rid === reqIdRef.current) setBusy(false); });
  };

  const runImport = () => {
    if (!file || busy) return;
    const rid = ++reqIdRef.current;
    setBusy(true);
    importFn(file, { preview: false, silent: true })
      .then((res) => {
        if (rid !== reqIdRef.current) return;
        setResult(res);
        toast.success(`Imported ${res.recorded} ${noun}(s) (${res.skipped} already present).`);
        if (res.recorded > 0) onImported?.();
      })
      .catch((err) => { if (rid === reqIdRef.current) toast.error(`Import failed: ${err.message}`); })
      .finally(() => { if (rid === reqIdRef.current) setBusy(false); });
  };

  return (
    <div className="rounded border border-port-border bg-port-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-300 hover:text-gray-100"
        aria-expanded={open}
      >
        <Icon size={16} className="text-port-accent" />
        <span className="font-medium">{title}</span>
        <span className="ml-auto text-xs text-gray-500">{open ? 'Hide' : 'Backfill'}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-port-border p-3">
          <p className="text-xs text-gray-500">{help}</p>

          <div className="flex flex-wrap items-center gap-2">
            <label className={`inline-flex items-center gap-2 rounded border border-port-border bg-port-bg px-3 py-1.5 text-sm text-gray-200 ${busy ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:border-port-accent'}`}>
              <Upload size={14} />
              <span>{file ? 'Change file' : 'Choose file'}</span>
              <input type="file" accept=".zip,.json,application/zip,application/json" onChange={pickFile} disabled={busy} className="hidden" />
            </label>
            {file && <span className="truncate text-xs text-gray-400">{file.name}</span>}
          </div>

          {file && !result && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={runPreview}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded border border-port-border bg-port-bg px-3 py-1.5 text-sm hover:border-port-accent disabled:opacity-40"
              >
                {busy && !preview ? <Loader2 size={14} className="animate-spin" /> : null}
                Preview
              </button>
              {preview && preview.mapped > 0 && (
                <button
                  type="button"
                  onClick={runImport}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded bg-port-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {busy && preview ? <Loader2 size={14} className="animate-spin" /> : null}
                  Import {preview.mapped} {noun}{preview.mapped === 1 ? '' : 's'}
                </button>
              )}
            </div>
          )}

          {preview && !result && (
            <div className="rounded border border-port-border bg-port-bg p-3 text-xs text-gray-400">
              <div className="mb-1 font-medium text-gray-300">Preview</div>
              {renderPreview(preview.summary)}
            </div>
          )}

          {result && (
            <div className="rounded border border-port-success/40 bg-port-bg p-3 text-xs text-gray-300">
              <div className="mb-1 flex items-center gap-2 font-medium text-port-success">
                <CheckCircle2 size={14} /> Import complete
              </div>
              <div>{result.recorded} new {noun}(s) recorded, {result.skipped} already present.</div>
              <button
                type="button"
                onClick={reset}
                className="mt-2 rounded border border-port-border px-2 py-1 text-gray-300 hover:border-port-accent"
              >
                Import another
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Shared preview helper: render a date range like "1/2/2023 — 4/5/2024" (or a
// single date when from === to), or null when either bound is missing.
export function dateRangeLabel(from, to) {
  if (!from || !to) return null;
  const f = new Date(from).toLocaleDateString();
  const t = new Date(to).toLocaleDateString();
  return f === t ? f : `${f} — ${t}`;
}
