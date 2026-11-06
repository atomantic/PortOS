import { useState } from 'react';
import { Link } from 'react-router';
import { useSocketResource } from '../../hooks/useSocketResource';
import useMounted from '../../hooks/useMounted';
import { listCatalogSheetJobs } from '../../services/apiCatalog';

const EVENTS = ['media-jobs:changed', 'reference-sheet:changed'];

// Failed renders keep their originals in the library. Merely visiting this
// panel never attaches one, rates it, selects a portrait, or queues a new render.
export default function CatalogSheetRecovery({ ingredientId, sheetMedia, onSheetFile, blockedReason }) {
  const mounted = useMounted();
  const [saving, setSaving] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const { data, error, refetch } = useSocketResource(async ({ signal }) => {
    const result = await listCatalogSheetJobs(ingredientId, { silent: true, signal });
    if (!Array.isArray(result?.jobs)) throw new Error('Invalid sheet recovery response');
    return result;
  }, { events: EVENTS, resourceKey: ingredientId });
  const jobs = (data?.jobs || []).filter((job) => !sheetMedia?.some((item) => item.mediaKey === job.savedFilename));
  const attach = async (job) => {
    if (saving || blockedReason || !onSheetFile) return;
    setSaving(job.jobId);
    setSaveError(null);
    const ok = await Promise.resolve(onSheetFile(job.savedFilename, job.role, 'Saved sheet attached for review'))
      .catch(() => false);
    if (!mounted.current) return;
    setSaving(null);
    if (ok === false) setSaveError('Could not attach the saved sheet. The original is still in the image library.');
    else refetch();
  };
  if (!jobs.length && !error) return null;
  return (
    <section aria-label="Sheet render recovery" className="rounded border border-port-warning/40 bg-port-card p-3 space-y-3">
      <h3 className="text-sm font-semibold">Sheet renders needing attention</h3>
      {error && <p role="status" className="text-xs text-port-warning">Could not load recent sheet render failures. <button type="button" onClick={refetch} className="rounded border border-port-border px-2 py-1">Reload status</button></p>}
      {saveError && <p role="alert" className="text-xs text-port-error">{saveError}</p>}
      {jobs.map((job) => (
        <div key={job.jobId} className="space-y-2 text-xs min-w-0">
          <p className="font-medium">{job.role.slice('sheet:'.length)} · {job.status === 'canceled' ? 'Canceled' : 'Not saved to Sheets'}</p>
          <p role="status" className="text-port-warning break-words">{job.error || 'The render did not finish.'}</p>
          {job.savedFilename ? <>
            <p>The original image was saved. Preview it before attaching it as an unreviewed reference. This does not generate another image or apply a film finish.</p>
            <div className="flex flex-wrap gap-2">
              <Link to={`/media/image?preview=${encodeURIComponent(`image:${job.savedFilename}`)}`} className="rounded border border-port-border px-2 py-1.5">Preview saved image</Link>
              {onSheetFile && <button type="button" onClick={() => attach(job)} disabled={!!saving || !!blockedReason} title={blockedReason || undefined}
                className="rounded border border-port-border px-2 py-1.5 disabled:opacity-40">{saving === job.jobId ? 'Attaching…' : 'Attach saved sheet'}</button>}
            </div>
          </> : <p>No saved image is available for this render. Use Generate sheet to start a new render.</p>}
        </div>
      ))}
      {data?.hasMore && <p className="text-xs text-port-text-muted">Showing the 20 most recent unresolved sheet renders.</p>}
    </section>
  );
}
