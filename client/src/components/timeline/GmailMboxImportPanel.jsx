import { useState, useRef } from 'react';
import { Mail, Loader2, CheckCircle2 } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import { dateRangeLabel } from './ActivityImportPanel';

// Bulk-backfill importer for a Google Takeout Gmail `.mbox` (#2160) →
// message.sent/message.received events. Unlike the other timeline importers this
// is PATH-BASED, not an upload: a Gmail mbox is routinely multiple GB and doesn't
// fit the 200MB upload flow, so the user names a local file/folder the server
// streams. Same two-step flow (preview → import) and idempotent server-side, so
// re-importing the same export never double-counts. Collapsed by default.
export default function GmailMboxImportPanel({ onImported }) {
  const [open, setOpen] = useState(false);
  const [mboxPath, setMboxPath] = useState('');
  const [yourEmail, setYourEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  // Monotonic request id — a response only applies if it's still the latest, so
  // editing the path mid-flight can't let a stale response land.
  const reqIdRef = useRef(0);

  const invalidate = () => { reqIdRef.current += 1; setPreview(null); setResult(null); };
  const onPathChange = (v) => { setMboxPath(v); invalidate(); };
  const onEmailChange = (v) => { setYourEmail(v); invalidate(); };
  const reset = () => { reqIdRef.current += 1; setPreview(null); setResult(null); };

  const canRun = mboxPath.trim() && !busy;

  const run = (dryRun) => {
    if (!canRun) return;
    const rid = ++reqIdRef.current;
    setBusy(true);
    if (dryRun) setResult(null);
    api.importGmailMbox({ path: mboxPath.trim(), preview: dryRun, yourEmail: yourEmail.trim(), silent: true })
      .then((res) => {
        if (rid !== reqIdRef.current) return;
        if (dryRun) {
          setPreview(res);
          if (!res.mapped) toast.error('No messages found at that path.');
        } else {
          setResult(res);
          toast.success(`Imported ${res.recorded} message(s) (${res.skipped} already present).`);
          if (res.recorded > 0) onImported?.();
        }
      })
      .catch((err) => { if (rid === reqIdRef.current) toast.error(`${dryRun ? 'Preview' : 'Import'} failed: ${err.message}`); })
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
        <Mail size={16} className="text-port-accent" />
        <span className="font-medium">Import Gmail history</span>
        <span className="ml-auto text-xs text-gray-500">{open ? 'Hide' : 'Backfill'}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-port-border p-3">
          <p className="text-xs text-gray-500">
            Request <span className="text-gray-300">Mail</span> from Google Takeout
            (takeout.google.com) and extract it on this machine. Because a Gmail
            <span className="font-mono"> .mbox</span> is often several GB, this reads it
            from a local <span className="text-gray-300">path</span> instead of an upload —
            point it at the <span className="font-mono">.mbox</span> file (or the extracted
            <span className="font-mono"> Takeout/Mail/</span> folder). Only headers are read
            (subject, sender, recipients, date) — never message bodies. Re-imports are safe.
          </p>

          <div className="flex flex-col gap-2">
            <label htmlFor="gmail-mbox-path" className="text-xs font-medium text-gray-400">
              Path to .mbox file or Mail folder
            </label>
            <input
              id="gmail-mbox-path"
              type="text"
              value={mboxPath}
              onChange={(e) => onPathChange(e.target.value)}
              disabled={busy}
              placeholder="~/Downloads/Takeout/Mail/All mail Including Spam and Trash.mbox"
              className="rounded border border-port-border bg-port-bg px-2 py-1.5 font-mono text-xs text-gray-100 disabled:opacity-40"
            />
            <label htmlFor="gmail-mbox-email" className="mt-1 text-xs font-medium text-gray-400">
              Your email <span className="font-normal text-gray-500">(optional — refines sent vs received)</span>
            </label>
            <input
              id="gmail-mbox-email"
              type="email"
              value={yourEmail}
              onChange={(e) => onEmailChange(e.target.value)}
              disabled={busy}
              placeholder="you@gmail.com"
              className="rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs text-gray-100 disabled:opacity-40"
            />
          </div>

          {!result && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => run(true)}
                disabled={!canRun}
                className="inline-flex items-center gap-2 rounded border border-port-border bg-port-bg px-3 py-1.5 text-sm hover:border-port-accent disabled:opacity-40"
              >
                {busy && !preview ? <Loader2 size={14} className="animate-spin" /> : null}
                Preview
              </button>
              {preview && preview.mapped > 0 && (
                <button
                  type="button"
                  onClick={() => run(false)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded bg-port-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {busy && preview ? <Loader2 size={14} className="animate-spin" /> : null}
                  Import {preview.mapped} message{preview.mapped === 1 ? '' : 's'}
                </button>
              )}
            </div>
          )}

          {preview && !result && (
            <div className="rounded border border-port-border bg-port-bg p-3 text-xs text-gray-400">
              <div className="mb-1 font-medium text-gray-300">Preview</div>
              <div>{preview.summary.messages} message(s): {preview.summary.sent} sent, {preview.summary.received} received</div>
              <div>{preview.summary.uniqueCorrespondents} unique correspondent(s)</div>
              {dateRangeLabel(preview.summary.from, preview.summary.to) && (
                <div>Range: {dateRangeLabel(preview.summary.from, preview.summary.to)}</div>
              )}
              {preview.summary.topCorrespondents?.length > 0 && (
                <div className="mt-1 truncate">
                  Top: {preview.summary.topCorrespondents.slice(0, 5).map((c) => c.email).join(', ')}
                </div>
              )}
            </div>
          )}

          {result && (
            <div className="rounded border border-port-success/40 bg-port-bg p-3 text-xs text-gray-300">
              <div className="mb-1 flex items-center gap-2 font-medium text-port-success">
                <CheckCircle2 size={14} /> Import complete
              </div>
              <div>{result.recorded} new message(s) recorded, {result.skipped} already present.</div>
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
