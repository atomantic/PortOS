const fieldClass = 'mt-1 w-full rounded border border-port-border bg-port-bg p-2 text-sm';
const buttonClass = 'min-h-[44px] rounded border border-port-border px-3 py-2 text-sm disabled:opacity-50';
const timeFieldClass = 'mt-1 block w-24 rounded border border-port-border bg-port-bg p-2 text-sm';

export function ProofRenderControls({ proof, fieldId, review, ready, blocked }) {
  const { needsRender: proofNeedsRender, range: { startSec, endSec }, setRange } = proof;
  return <div id="mv-review-render" tabIndex={-1} style={{ scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' }} className="flex flex-wrap items-end gap-2">
    <label htmlFor={fieldId('proof-start')} className="text-sm">Chorus start (s)<input id={fieldId('proof-start')} type="number" min="0" step="0.01" value={startSec} onChange={e => setRange({ startSec: Number(e.target.value) })} className={timeFieldClass} /></label>
    <label htmlFor={fieldId('proof-end')} className="text-sm">End (s)<input id={fieldId('proof-end')} type="number" min="0" step="0.01" value={endSec} onChange={e => setRange({ endSec: Number(e.target.value) })} className={timeFieldClass} /></label>
    <button type="button" className={buttonClass} disabled={blocked || !ready?.storyboard.approved || review.proof.occupied || review.proof.active} onClick={() => review.renderProof({ startSec, endSec })}>{proofNeedsRender ? 'Render animated proof' : 'Render a new proof'}</button>
  </div>;
}

export default function ProofReviewContent({ proof, fieldId, jump, saved, review, project, ready, blocked }) {
  const { excerpt, proofIdentity, needsRender: proofNeedsRender, proofMedia, setProofMedia, matchingRecordedReview,
    playbackBlocked, playback, setPlayback, machineReview } = proof;
  const renderControls = <ProofRenderControls proof={proof} fieldId={fieldId} review={review} ready={ready} blocked={blocked} />;
  return <>
    {!excerpt && <div className="space-y-1 text-sm" aria-label="Proof approval prerequisites">
      {!ready?.art.approved && <p><a href="#mv-review-art" onClick={jump('cast-sets', 'mv-review-art')} className="text-port-accent underline">Approve the art direction</a> first.</p>}
      {ready?.art.approved && !ready?.storyboard.approved && <p><a href="#mv-review-storyboard" onClick={jump('produce', 'mv-review-storyboard')} className="text-port-accent underline">Review the storyboard</a> first.</p>}
    </div>}
    {excerpt && <p className="text-xs text-port-text-muted break-words">{excerpt.filename || excerpt.status} · {project.productionReview?.proof?.basis === ready?.basis.proof ? 'Current source revision' : 'Source changed — render a new proof'}</p>}
    {excerpt?.status === 'error' && excerpt.error && <p role="alert" className="text-sm text-port-error break-words">{excerpt.error}</p>}

      <details aria-label="Saved choreography for proof comparison" className="rounded border border-port-border bg-port-bg p-3">
        <summary className="min-h-[44px] cursor-pointer text-sm font-medium">Saved energy target and timed choreography</summary>
        <p className="mt-1 whitespace-pre-wrap text-sm">{saved.motionLanguage || 'Save an energy target and timed choreography in the planning editor before judging the proof.'}</p>
        <p className="mt-2 text-xs text-port-text-muted">Compare playback with this saved plan. If the chosen energy or actions are missing, record revision feedback with a time range before approving.</p>
      </details>
      {!proofNeedsRender && renderControls}
      {review.proof.occupied && !review.proof.active && <p role="status">Review evidence is rendering in another project. Wait for it to finish before starting another.</p>}
      {review.proof.active && <p role="status">{review.proof.connected === false ? 'Connecting to review render…' : `Rendering review evidence — ${review.proof.percent ?? 0}%.`} Production approvals are separate.</p>}
      {excerpt?.status === 'complete'  && excerpt.filename && <video key={proofIdentity} controls className="mt-2 w-full rounded" aria-label="Animated proof with master audio" src={`/data/videos/${encodeURIComponent(excerpt.filename)}`}
        onLoadedData={() => setProofMedia({ identity: proofIdentity, ready: true })}
        onError={() => setProofMedia({ identity: proofIdentity, ready: false, error: true })} />}
      {excerpt?.status === 'complete' && (proofMedia?.identity !== proofIdentity || !proofMedia.ready) && <p role={proofMedia?.identity === proofIdentity && proofMedia.error ? 'alert' : 'status'} className="text-sm">
        {proofMedia?.identity === proofIdentity && proofMedia.error ? 'This proof could not be played. Restore the exact file or render a new proof before approving.' : 'Load and play this exact proof with sound before recording your review.'}
      </p>}
      {matchingRecordedReview && <section aria-label="Recorded proof review" className="rounded border border-port-border p-3">
        <h4 className="text-sm font-medium">Recorded proof review</h4>
        <p className="text-xs text-port-text-muted">{matchingRecordedReview.method === 'machine' ? 'Machine review — no human playback claimed' : 'Playback review'}</p>
        {matchingRecordedReview.machineEvidence && <dl className="text-sm space-y-2">
          <dt>Visual review</dt><dd>{matchingRecordedReview.machineEvidence.visualReview}</dd>
          <dt>Audio review</dt><dd>{matchingRecordedReview.machineEvidence.audioReview}</dd>
          <dt>Review limitations</dt><dd>{matchingRecordedReview.machineEvidence.limitations}</dd>
        </dl>}
        {matchingRecordedReview.energyComparison && <p className="mt-1 whitespace-pre-wrap text-sm">{matchingRecordedReview.energyComparison}</p>}
        {matchingRecordedReview.timecodedNotes && <p className="mt-2 whitespace-pre-wrap text-sm">{matchingRecordedReview.timecodedNotes}</p>}
      </section>}
      {/* The review notes belong to a proof; with none to watch they would only be disabled clutter. */}
      {!proofNeedsRender && <>
      <label htmlFor={fieldId('review-method')} className="block text-sm">Review method
        <select id={fieldId('review-method')} disabled={playbackBlocked} value={playback.method}
          onChange={e => setPlayback({ method: e.target.value })} className={fieldClass}>
          <option value="playback">Playback with audio</option>
          <option value="machine">Machine review with visual and audio evidence</option>
        </select>
      </label>
      {machineReview && <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Machine review evidence</legend>
        {[
          ['visualReview', 'Visual and motion observations', 8000],
          ['audioReview', 'Audio and alignment observations', 8000],
          ['limitations', 'Review limitations', 4000],
        ].map(([key, label, maxLength]) => <label key={key} htmlFor={fieldId(key)} className="block text-sm">{label}
          <textarea id={fieldId(key)} rows={3} maxLength={maxLength} disabled={playbackBlocked} value={playback[key]}
            onChange={e => setPlayback({ [key]: e.target.value })} className={fieldClass} />
        </label>)}
      </fieldset>}
      <label htmlFor={fieldId('playback-notes')} className="block text-sm">Notes (optional)
        <textarea id={fieldId('playback-notes')} rows={2} maxLength={4000} disabled={playbackBlocked} value={playback.timecodedNotes} onChange={e => setPlayback({ timecodedNotes: e.target.value })} className={fieldClass}
          placeholder="0:04 — turn lands on the downbeat" />
      </label>
      </>}
  </>;
}
