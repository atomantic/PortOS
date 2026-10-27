import { useCallback, useId, useRef, useState } from 'react';
import { refineCatalogMedia } from '../../services/apiCatalog';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import useMounted from '../../hooks/useMounted';
import ModelInputPreview from '../media/ModelInputPreview';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import { REFERENCE_REVIEW_WRITE_STATUSES, referenceReviewStatus } from '../../../../server/lib/catalogMediaLibrary.js';

export default function CatalogReferenceReview({ ingredientId, media, readOnly, saving, onSave, onChanged, revision, blockedReason }) {
  const id = useId();
  const mounted = useMounted();
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const review = media.library?.review || {};
  const savedStatus = referenceReviewStatus(media);
  const status = draft?.status ?? savedStatus;
  const feedback = draft?.feedback ?? review.feedback ?? '';
  const dirty = status !== savedStatus || feedback !== (review.feedback || '');
  const body = { mediaKey: media.mediaKey, kind: media.kind, feedback };
  const fetchPreview = useCallback((input, options) => refineCatalogMedia(ingredientId, input, { ...options, preview: true }), [ingredientId]);
  const preview = useModelInputPreview(fetchPreview, body, { enabled: open && !readOnly && !blockedReason && feedback.trim().length > 0, revision });
  const complete = useCallback(() => { setJobId(null); onChanged?.(); }, [onChanged]);
  const terminal = useCallback(value => {
    if (value === 'failed' || value === 'canceled') {
      setJobId(null);
      setError(value === 'failed' ? 'Refinement failed. Your original reference and feedback are preserved.' : 'Refinement canceled.');
    }
  }, []);
  const render = async () => {
    if (inFlight.current || dirty || saving || jobId || blockedReason) return;
    inFlight.current = true;
    setStarting(true); setError('');
    try {
      const result = await refineCatalogMedia(ingredientId, body, { silent: true });
      if (!result?.jobId) throw new Error('Refinement returned no media job');
      if (mounted.current) setJobId(result.jobId);
    } catch (err) {
      if (mounted.current) setError(err.message || 'Could not start refinement');
    } finally {
      inFlight.current = false;
      if (mounted.current) setStarting(false);
    }
  };
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="min-w-0 text-xs">
    <summary className="min-h-11 cursor-pointer content-center text-port-accent">Review &amp; refine · {savedStatus}</summary>
    {readOnly ? <p className="whitespace-pre-wrap text-gray-400">{review.feedback || 'No editing guidance saved.'}</p> : <div className="space-y-2">
      <label htmlFor={`${id}-status`} className="block text-gray-400">Reference rating</label>
      <select id={`${id}-status`} value={status} onChange={event => setDraft({ status: event.target.value, feedback })} disabled={saving || starting || !!jobId}
        className="min-h-11 w-full rounded border border-port-border bg-port-bg px-2">
        {REFERENCE_REVIEW_WRITE_STATUSES.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <label htmlFor={`${id}-feedback`} className="block text-gray-400">Editing guidance</label>
      <textarea id={`${id}-feedback`} value={feedback} maxLength={2000} rows={3} disabled={saving || starting || !!jobId}
        onChange={event => setDraft({ status, feedback: event.target.value })} placeholder="Describe what to correct and what to preserve…"
        className="w-full rounded border border-port-border bg-port-bg p-2" />
      <p className="text-gray-500">Bad images stay here for comparison and out of render guides. Refining creates a new, unreviewed reference.</p>
      <button type="button" disabled={!dirty || saving || starting || !!jobId} onClick={async () => {
        if (await onSave({ review: { status, feedback } })) setDraft(null);
      }}
        className="min-h-11 rounded border border-port-border px-3 text-port-accent disabled:opacity-40">Save review</button>
      {open && <ModelInputPreview preview={preview} prompt={feedback} />}
      <button type="button" onClick={render} disabled={!!blockedReason || dirty || saving || starting || !!jobId || !feedback.trim() || !preview.preview || !!preview.error}
        className="min-h-11 w-full rounded border border-port-border px-3 text-port-accent disabled:opacity-40">{starting || jobId ? 'Refining…' : 'Refine as new version'}</button>
      {dirty && <p className="text-port-warning">Save the review before refining.</p>}
      {blockedReason && <p role="status" className="text-port-warning">{blockedReason}</p>}
    </div>}
    {media.library?.derivedFrom && <p className="mt-2 break-all text-gray-500">Refined from {media.library.derivedFrom.mediaKey}</p>}
    {jobId && <MediaJobThumb jobId={jobId} label="Refined reference" size="xs" onFilename={complete} onStatus={terminal} />}
    {error && <p role="alert" className="text-port-error">{error}</p>}
  </details>;
}
