import { useEffect, useState } from 'react';
import ProductionReviewContext from './ProductionReviewContext.jsx';
import { formatTimecode } from '../../utils/formatters.js';

const EMPTY = { cast: '', environments: '', visualLanguage: '', motionLanguage: '', guideArtifactId: null,
  lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] };
const fieldClass = 'mt-1 w-full rounded border border-port-border bg-port-bg p-2 text-sm';
const buttonClass = 'min-h-[44px] rounded border border-port-border px-3 py-2 text-sm disabled:opacity-50';
const labels = { art: 'Art direction', storyboard: 'Lyric-timed storyboard', proof: 'Animated proof' };
// Each approval lives on the tab that owns its work (#10151); the page passes `stage` to render only that one.
const STAGE_TABS = { art: 'cast-sets', storyboard: 'board', proof: 'produce' };
const EMPTY_PLAYBACK = { method: 'playback', energyComparison: '', timecodedNotes: '', visualReview: '', audioReview: '', limitations: '' };

const FOLD_STYLE = { scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' };
/**
 * One approval. On a step (`single`) it is the open box that closes the step —
 * heading, then its content and Approve / Request changes — highlighted until
 * approved; with every approval listed it folds like before.
 */
function ApprovalFold({ single, open, id, label, approved, children }) {
  if (single) return <section id={id} tabIndex={-1} aria-label={`Approve: ${label}`} style={FOLD_STYLE}
    className={`rounded-lg border p-3 focus:outline focus:outline-2 focus:outline-port-accent ${approved ? 'border-port-border' : 'border-port-accent bg-port-accent/5'}`}>
    <h4 className="text-sm font-semibold">{approved ? `${label} approved` : `Approve the ${label.toLowerCase()}`}</h4>
    {children}
  </section>;
  return <details open={open} id={id} tabIndex={-1} style={FOLD_STYLE} className="rounded border border-port-border p-2 focus:outline focus:outline-2 focus:outline-port-accent">
    <summary className="cursor-pointer min-h-[44px] py-2 text-sm font-medium">{label}</summary>
    {children}
  </details>;
}

/** Editable planning content and explicit operator decisions for every render mode. */
// `framed={false}` drops the card chrome and heading for a host that supplies them.
// `stage` ('art' | 'storyboard' | 'proof') renders just that stage's approval, feedback and planning fields; omitted, all three render.
// `planning` is an optional `[draft, setDraft]` pair owned by the page so unsaved edits survive a tab switch; `onNavigate(tab, anchor)` jumps tabs.
export default function ProductionReviewPanel({ project, review, onOpenArtifact, framed = true, stage = null, planning = null, onNavigate = null }) {
  const showArt = !stage || stage === 'art';
  const showBoard = !stage || stage === 'storyboard';
  const fieldId = key => `mv-review-${project.id}-${key}`;
  const saved = project.productionReview?.draft || EMPTY;
  const [visibleArt, setVisibleArt] = useState(null);
  const [proofMedia, setProofMedia] = useState(null);
  const artIdentity = JSON.stringify([project.id, saved.guideArtifactId, project.devArtifacts?.find(a => a.id === saved.guideArtifactId)?.version]);
  const [ownLocal, setOwnLocal] = useState(null);
  const [local, setLocal] = planning || [ownLocal, setOwnLocal];
  const draft = local || saved;
  const dirty = !!local && JSON.stringify(local) !== JSON.stringify(saved);
  const [feedback, setFeedback] = useState({ stage: stage || 'art', target: '', text: '', decision: 'request-changes' });
  const [resolutions, setResolutions] = useState({});
  const [importError, setImportError] = useState(null);
  const [revisionNotice, setRevisionNotice] = useState(null);
  const [savedRequestStage, setSavedRequestStage] = useState(null);
  const [playbackReview, setPlaybackReview] = useState({ ...EMPTY_PLAYBACK, identity: null });
  const [startSec, setStartSec] = useState(project.productionReview?.proof?.startSec || 0);
  const [endSec, setEndSec] = useState(project.productionReview?.proof?.endSec || Math.min(20, project.audioAnalysis?.durationSec || 20));
  const ready = review.current === false ? null : review.readiness; // approvals never act on a stale revision
  const set = (key, value) => setLocal({ ...draft, [key]: value });
  const documentShots = draft.storyboardSource === 'document';
  const shots = documentShots ? draft.storyboard : [...draft.storyboard, ...(project.scenes || []).filter(scene => !draft.storyboard.some(s => s.sceneId === scene.sceneId)).map(scene => ({
    id: scene.sceneId, sceneId: scene.sceneId, lyricCueIds: [], action: '', staging: '', camera: '', transition: '',
  }))];
  const shotKey = shot => shot.id || shot.sceneId;
  const setShot = (shot, key, value) => set('storyboard', shots.map(s => shotKey(s) === shotKey(shot) ? { ...s, [key]: value } : s));
  const blocked = dirty || review.busy || !ready;
  const prototype = project.excerpts?.find(e => e.id === project.productionReview?.prototype?.excerptId);
  const excerpt = project.excerpts?.find(e => e.id === project.productionReview?.proof?.excerptId);
  const proofIdentity = JSON.stringify([project.id, ready?.basis.proof ?? project.productionReview?.proof?.basis ?? null, excerpt?.id, excerpt?.filename]);
  const recordedProofReview = project.productionReview?.approvals?.proof?.proofReview;
  const matchingRecordedReview = ready?.proof.approved && recordedProofReview?.excerptId === excerpt?.id
    && recordedProofReview?.filename === excerpt?.filename ? recordedProofReview : null;
  useEffect(() => { setPlaybackReview(current => current.identity === proofIdentity ? current
    : { ...EMPTY_PLAYBACK, identity: proofIdentity }); }, [proofIdentity]);
  const playback = playbackReview.identity === proofIdentity ? playbackReview : EMPTY_PLAYBACK;
  const setPlayback = patch => setPlaybackReview({ ...playback, identity: proofIdentity, ...patch });
  const playbackBlocked = proofMedia?.identity !== proofIdentity || !proofMedia?.ready || blocked || review.proof.active || !!ready?.proof.problems.length || excerpt?.status !== 'complete' || !excerpt.filename;
  const machineReview = playback.method === 'machine';
  const evidenceComplete = machineReview
    ? playback.visualReview.trim().length >= 40 && playback.audioReview.trim().length >= 40 && !!playback.limitations.trim()
    : true;
  const hasTimecodedNotes = /(?:\b\d{1,2}:\d{2}(?:\.\d+)?\b|\b\d+(?:\.\d+)?s\b)/.test(playback.timecodedNotes);
  const playbackComplete = evidenceComplete && !!playback.energyComparison.trim() && hasTimecodedNotes;
  const approve = stage => {
    return review.approve(stage, stage === 'proof' ? { watchedWithAudio: !machineReview,
      ...(machineReview ? { method: 'machine', machineEvidence: {
        visualReview: playback.visualReview.trim(), audioReview: playback.audioReview.trim(), limitations: playback.limitations.trim(),
      } } : {}),
      energyComparison: playback.energyComparison.trim(), timecodedNotes: playback.timecodedNotes.trim(),
      excerptId: excerpt.id, filename: excerpt.filename } : undefined);
  };

  const approvalHelp = stage => {
    if (!ready) return 'Loading review prerequisites…';
    if (dirty) return 'Save your planning edits before approving this revision.';
    if (review.busy) return 'Wait for the current review action to finish.';
    if (ready[stage].approved) return 'Already approved for this revision.';
    if (ready[stage].problems.length) return 'Complete the prerequisites listed above before approving.';
    if (stage === 'art' && visibleArt !== artIdentity) return 'Load and inspect the selected visual guide before approving art direction.';
    if (stage !== 'proof') return null;
    if (review.proof.active) return 'Wait for the evidence render to finish, then review the completed proof.';
    if (playbackBlocked) return 'Load the completed animated proof before recording your review. If playback fails, restore its exact file or render a new proof.';
    if (!playback.energyComparison.trim()) return 'Describe how the playback energy compares with the saved plan.';
    if (!hasTimecodedNotes) return 'Add playback notes with a timestamp such as 0:04 or 4.5s.';
    if (!evidenceComplete) return 'Complete the visual and audio observations (at least 40 characters each) and state the review limitations.';
    return null;
  };
  // A link to another stage's section crosses tabs through the page; within a tab it just unfolds the target.
  const jump = (tab, anchor) => event => {
    if (onNavigate && stage && tab !== STAGE_TABS[stage]) { event.preventDefault(); onNavigate(tab, anchor); return; }
    openReviewSection(event);
  };
  const openReviewSection = event => {
    const target = document.getElementById(event.currentTarget.hash.slice(1));
    if (target) { target.open = true; target.focus({ preventScroll: true }); }
  };
  const nextStage = ['art', 'storyboard', 'proof'].find(stage => !ready?.[stage].approved) || 'proof';
  const openRequests = stage => (project.productionReview?.feedback || []).filter(f => f.stage === stage && f.decision === 'request-changes' && !f.resolvedAt);
  // Mirrors the server's revise routing so an unsupported stage explains itself instead of failing on click.
  const revisionScope = stage => {
    if (stage === 'art') return project.castAndSets?.direction
      ? { action: 'Regenerates the Cast & Sets direction and sheet with these requests. Review the new sheet before approving.' }
      : { unavailable: 'This art direction has no Cast & Sets direction to regenerate. Edit the guide, then resolve each request.' };
    if (stage === 'storyboard') {
      if (documentShots) return { unavailable: 'Document shots come from the authored source. Revise it, reimport its shot manifest, then resolve each request.' };
      return project.scenes?.length
        ? { action: 'Re-plans the shots these requests name (every shot when a request names none) in place, keeping their takes and selected media.' }
        : { unavailable: 'Plan timed Board shots before revising them from feedback.' };
    }
    const mode = project.composition?.mode;
    if (mode === 'code') return { action: 'Regenerates the code composition with these requests. Render a new proof afterwards.' };
    if (mode === 'document') return ['generated', 'template', undefined].includes(project.composition?.document?.source?.kind)
      ? { action: 'Authors a revised composition candidate with these requests. Accept it in Make, then render a new proof.' }
      : { unavailable: 'This composition was imported from its own source. Revise that source and reimport it, then resolve each request.' };
    return { unavailable: 'This proof is assembled from Board footage. Revise the affected storyboard shots or takes, then render a new proof.' };
  };
  const revise = async stage => {
    const result = await review.revise(stage);
    if (!result) return;
    const count = result.revision?.sceneIds?.length;
    setRevisionNotice({ stage, text: stage === 'art' ? 'Cast & Sets is regenerating with these requests. Review the new sheet, then resolve each request.'
      : stage === 'storyboard' ? `Revised ${count} shot${count === 1 ? '' : 's'}. Review them, then resolve each request.`
        : 'A revised composition is ready. Render and review a new proof, then resolve each request.' });
  };
  const proofContent = <>
    <p className="text-xs text-port-text-muted break-words">Project v{project.version || 1} · proof revision {ready?.basis.proof?.slice(0, 12) || 'Loading…'} · {excerpt ? `Excerpt ${excerpt.id}` : 'No registered proof'}</p>
    {!excerpt && <div className="rounded border border-port-border p-3 space-y-2" aria-label="Proof approval prerequisites">
      <p className="text-sm">{prototype ? 'The video below is a feasibility prototype, not a registered production proof. Watching it does not enable proof approval.' : 'No production proof is registered for this project.'}</p>
      <ol className="list-decimal pl-5 text-sm space-y-2">
        {!ready?.art.approved && <li><a href="#mv-review-art" onClick={jump('cast-sets', 'mv-review-art')} className="text-port-accent underline">Review and approve art direction</a> for the current revision.</li>}
        {!ready?.storyboard.approved && <li><a href="#mv-review-storyboard" onClick={jump('board', 'mv-review-storyboard')} className="text-port-accent underline">Resolve storyboard prerequisites and approve it</a>.
          <ul className="list-disc pl-5">{(ready?.storyboard.problems || []).map(problem => <li key={problem}>{problem}</li>)}</ul>
          <a href="#mv-review-planning" onClick={jump('board', 'mv-review-planning')} className="text-port-accent underline">Open planning edits for alignment and document shot manifests</a>.
        </li>}
        <li>Choose a 10–45 second chorus window and use “Render animated proof” below. The feasibility prototype button creates a separate, unapproved preview.</li>
        <li>Review the proof with audio, add an energy comparison and timecoded notes, then approve using the playback attestation.</li>
      </ol>
    </div>}
    {excerpt && <p className="text-xs text-port-text-muted break-words">{excerpt.filename || excerpt.status} · {project.productionReview?.proof?.basis === ready?.basis.proof ? 'Current source revision' : 'Source changed — render a new proof'}</p>}
    {excerpt?.status === 'error' && excerpt.error && <p role="alert" className="text-sm text-port-error break-words">{excerpt.error}</p>}

      <p className="text-sm">Finish the composition above (typography, grade, render style), then render a 10–45 second chorus with its entry and exit. Watch with sound at normal speed and compare the chosen energy target and timed choreography below against the actual subject, props, camera, typography and transitions. Check accents against beat and lyric anchors, readable holds and repeated-chorus escalation. A strong static frame does not prove the motion works.</p>
      <section aria-label="Saved choreography for proof comparison" className="rounded border border-port-border bg-port-bg p-3">
        <h4 className="text-sm font-medium">Saved energy target and timed choreography</h4>
        <p className="mt-1 whitespace-pre-wrap text-sm">{saved.motionLanguage || 'Save an energy target and timed choreography in the planning editor before judging the proof.'}</p>
        <p className="mt-2 text-xs text-port-text-muted">Compare playback with this saved plan. If the chosen energy or actions are missing, record revision feedback with a time range before approving.</p>
      </section>
      <div id="mv-review-render" tabIndex={-1} style={{ scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' }} className="flex flex-wrap items-end gap-2">
        <label htmlFor={fieldId('proof-start')} className="text-sm">Proof start (seconds)<input id={fieldId('proof-start')} type="number" min="0" step="0.01" value={startSec} onChange={e => setStartSec(Number(e.target.value))} className={fieldClass} /></label>
        <label htmlFor={fieldId('proof-end')} className="text-sm">Proof end (seconds)<input id={fieldId('proof-end')} type="number" min="0" step="0.01" value={endSec} onChange={e => setEndSec(Number(e.target.value))} className={fieldClass} /></label>
        <button type="button" className={buttonClass} disabled={blocked || review.proof.occupied || review.proof.active} onClick={() => review.renderProof({ startSec, endSec, kind: 'prototype' })}>Render feasibility prototype — unapproved</button>
        <button type="button" className={buttonClass} disabled={blocked || !ready?.storyboard.approved || review.proof.occupied || review.proof.active} onClick={() => review.renderProof({ startSec, endSec })}>Render animated proof</button>
      </div>
      {review.proof.occupied && !review.proof.active && <p role="status">Review evidence is rendering in another project. Wait for it to finish before starting another.</p>}
      {review.proof.active && <p role="status">{review.proof.connected === false ? 'Connecting to review render…' : `Rendering review evidence — ${review.proof.percent ?? 0}%.`} Production approvals are separate.</p>}
      <p className="text-xs text-port-text-muted">A feasibility prototype uses the current authored composition and master audio without approving the look or authorizing production. It can be made before art approval; it never becomes approved proof automatically.</p>
      {prototype?.status === 'complete' && prototype.filename && <figure><video controls className="mt-2 w-full rounded" aria-label="Unapproved feasibility prototype" src={`/data/videos/${encodeURIComponent(prototype.filename)}`} /><figcaption className="text-sm">Unapproved feasibility prototype — separate from production proof</figcaption></figure>}
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
        <p className="mt-1 whitespace-pre-wrap text-sm">{matchingRecordedReview.energyComparison}</p>
        <p className="mt-2 whitespace-pre-wrap text-sm">{matchingRecordedReview.timecodedNotes}</p>
      </section>}
      <label htmlFor={fieldId('review-method')} className="block text-sm">Review method
        <select id={fieldId('review-method')} disabled={playbackBlocked} value={playback.method}
          onChange={e => setPlayback({ method: e.target.value })} className={fieldClass}>
          <option value="playback">Playback with audio</option>
          <option value="machine">Machine review with visual and audio evidence</option>
        </select>
      </label>
      {machineReview && <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Machine review evidence</legend>
        <p className="text-xs text-port-text-muted">Record the actual inspection method and observations for this exact proof. Frame checks alone cannot establish motion or audio alignment. No human playback is claimed.</p>
        {[
          ['visualReview', 'Visual and motion observations', 8000],
          ['audioReview', 'Audio and alignment observations', 8000],
          ['limitations', 'Review limitations', 4000],
        ].map(([key, label, maxLength]) => <label key={key} htmlFor={fieldId(key)} className="block text-sm">{label}
          <textarea id={fieldId(key)} rows={3} maxLength={maxLength} disabled={playbackBlocked} value={playback[key]}
            onChange={e => setPlayback({ [key]: e.target.value })} className={fieldClass} />
        </label>)}
        <p className="text-xs text-port-text-muted">Visual and audio observations each need at least 40 characters; describe limitations explicitly.</p>
      </fieldset>}
      <label htmlFor={fieldId('energy-comparison')} className="block text-sm">Playback energy compared with the saved plan
        <textarea id={fieldId('energy-comparison')} rows={3} maxLength={4000} disabled={playbackBlocked} value={playback.energyComparison} onChange={e => setPlayback({ energyComparison: e.target.value })} className={fieldClass}
          placeholder="Chosen energy target; observed subject, prop and camera activity; where playback matches or misses the intended arc." />
      </label>
      <label htmlFor={fieldId('playback-notes')} className="block text-sm">Timecoded playback notes
        <textarea id={fieldId('playback-notes')} rows={3} maxLength={4000} disabled={playbackBlocked} value={playback.timecodedNotes} onChange={e => setPlayback({ timecodedNotes: e.target.value })} className={fieldClass}
          placeholder="0:04 — subject turns on the downbeat; prop opens through 0:06; camera and type clear the lyric. Name any mismatch to revise." />
      </label>
      <p className="text-xs text-port-text-muted">Include at least one playback timestamp such as 0:04 or 4.5s. These notes are saved with this exact proof. A replacement proof requires a new comparison and acknowledgement.</p>
      {!machineReview && <p id={fieldId('playback-attestation')} className="text-sm">By approving, I confirm that I watched this exact proof with audio at normal speed and compared its energy, timed choreography and lyric timing with the saved plan.</p>}
  </>;
  return <section id="mv-production-review" aria-label="Production review" className={framed ? 'rounded-lg border border-port-border bg-port-card p-3 space-y-3' : 'space-y-3'}>
    {framed && <h3 className="font-medium">Production review</h3>}
    {review.error && <p role="alert" className="text-port-error">{review.error}</p>}
    <ol className="space-y-3">
      {Object.entries(labels).filter(([key]) => !stage || key === stage).map(([key, label]) => <li key={key}><ApprovalFold single={!!stage} open={window.location.hash === `#mv-review-${key}` || (!stage && key === nextStage)} id={`mv-review-${key}`} label={label} approved={!!ready?.[key].approved}>
        {!stage && <p role="status" className="text-xs">{ready?.[key].approved ? 'Approved for this revision' : 'Review required'}</p>}
        <div id={fieldId(`${key}-prerequisites`)}>{(ready?.[key].problems || []).map(problem => <p key={problem} className="mt-1 text-xs text-port-text-muted">{problem}</p>)}</div>
        {key === 'proof' ? proofContent : <ProductionReviewContext stage={key} project={project} basis={ready?.basis[key]} approved={ready?.[key].approved} onOpenArtifact={onOpenArtifact} onArtReady={available => setVisibleArt(available ? artIdentity : null)} />}
        <p id={fieldId(`${key}-approval-help`)} role="status" className="mt-2 text-sm text-port-text-muted">{approvalHelp(key)}</p>
        <button type="button" className={`${buttonClass} mt-2`} onClick={() => approve(key)}
          aria-describedby={`${fieldId(`${key}-prerequisites`)} ${fieldId(`${key}-approval-help`)}${key === 'proof' && !machineReview ? ` ${fieldId('playback-attestation')}` : ''}`}
          disabled={blocked || (key === 'art' && visibleArt !== artIdentity) || ready?.[key].approved || !!ready?.[key].problems.length
            || (key === 'proof' && (playbackBlocked || !playbackComplete))}>
          {key === 'proof' ? machineReview ? 'Approve animated proof with machine evidence' : 'Approve — I reviewed this proof with audio' : `Approve ${label.toLowerCase()}`}
        </button>

        <button type="button" className={`${buttonClass} mt-2 ml-2`} onClick={() => {
          setFeedback({ ...feedback, stage: key, decision: 'request-changes' });
          const input = document.getElementById(fieldId('feedback-text'));
          const fold = input?.closest('details'); if (fold) fold.open = true;
          input?.scrollIntoView({ block: 'center' }); input?.focus({ preventScroll: true });
        }}>Request changes</button>
        {openRequests(key).length > 0 && <div role="group" aria-label={`${label} change requests`} className="mt-2 space-y-2 rounded border border-port-warning p-2">
          <p className="text-sm">Approval stays blocked until these are resolved. Revise from feedback, or edit and resolve manually.</p>
          <ul className="list-disc pl-5 text-sm">{openRequests(key).map(item => <li key={item.id} className="break-words"><strong>{item.target}</strong>: {item.text}</li>)}</ul>
          {revisionScope(key).unavailable ? <p className="text-xs text-port-text-muted">{revisionScope(key).unavailable}</p> : <>
            <button type="button" className={buttonClass} disabled={blocked} aria-describedby={fieldId(`${key}-revision-help`)} onClick={() => revise(key)}>Revise from feedback</button>
            <p id={fieldId(`${key}-revision-help`)} className="text-xs text-port-text-muted">{revisionScope(key).action}</p>
          </>}
          {revisionNotice?.stage === key && <p role="status" className="text-sm">{revisionNotice.text}</p>}
        </div>}
      </ApprovalFold></li>)}
    </ol>
    {dirty && <p role="status" className="text-sm">Save your planning edits before approving this revision.</p>}
    <details>
      <summary className="cursor-pointer min-h-[44px] py-2 text-sm">Review feedback and revision history</summary>
      <p className="text-sm">Name a cast member, environment, shot, artifact or frame time. Structure acceptance records agreement on organization only; it never approves the art or authorizes production.</p>
      {!stage && <label htmlFor={fieldId('feedback-stage')} className="block text-sm">Feedback stage<select id={fieldId('feedback-stage')} className={fieldClass} value={feedback.stage} onChange={e => setFeedback({ ...feedback, stage: e.target.value })}>
        {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>}
      <label htmlFor={fieldId('feedback-target')} className="block text-sm">Feedback target<input id={fieldId('feedback-target')} className={fieldClass} value={feedback.target} placeholder="Cast: operator; shot: chorus; frame: 12.5s" onChange={e => setFeedback({ ...feedback, target: e.target.value })} /></label>
      <label htmlFor={fieldId('feedback-text')} className="block text-sm">Requested change<textarea id={fieldId('feedback-text')} className={fieldClass} rows={3} value={feedback.text} onChange={e => setFeedback({ ...feedback, text: e.target.value })} /></label>
      <label htmlFor={fieldId('feedback-decision')} className="block text-sm">Review decision<select id={fieldId('feedback-decision')} className={fieldClass} value={feedback.decision} onChange={e => setFeedback({ ...feedback, decision: e.target.value })}>
        <option value="request-changes">Request changes — blocks affected approvals</option><option value="comment">Comment</option><option value="structure-accepted">Accept structure only — art remains unapproved</option>
      </select></label>
      <button type="button" className={buttonClass} disabled={blocked || !feedback.target.trim() || !feedback.text.trim()} onClick={async () => {
        if (await review.feedback(feedback)) {
          setFeedback({ ...feedback, text: '' });
          setSavedRequestStage(feedback.decision === 'request-changes' ? feedback.stage : null);
        }
      }}>Save revision feedback</button>
      {savedRequestStage && openRequests(savedRequestStage).length > 0 && <p role="status" className="text-sm">
        Approval stays blocked until these are resolved. <a href={`#mv-review-${savedRequestStage}`} onClick={openReviewSection} className="text-port-accent underline">Revise from feedback</a>, or edit and resolve manually.
      </p>}
      <ul className="mt-3 space-y-3">{(project.productionReview?.feedback || []).filter(item => !stage || item.stage === stage).map(item => <li key={item.id} className="rounded border border-port-border p-2">
        <p className="text-sm"><strong>{item.target}</strong> · {item.decision} · {item.resolvedAt ? 'Resolved' : 'Open'}</p>
        <p className="text-sm whitespace-pre-wrap">{item.text}</p>
        <p className="text-xs text-port-text-muted">Reviewed revision {item.basis.slice(0, 12)}{ready?.basis[item.stage] !== item.basis ? ' · content has changed since review' : ' · current revision'}</p>
        <details><summary className="cursor-pointer py-2 text-sm">Original reviewed content</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(project.productionReview.reviewedRevisions?.[item.basis]?.draft, null, 2)}</pre></details>
        {item.resolvedAt ? <p className="text-sm">Resolution: {item.resolution}</p> : <>
          <label htmlFor={fieldId(`resolution-${item.id}`)} className="block text-sm">Resolution for {item.target}<textarea id={fieldId(`resolution-${item.id}`)} className={fieldClass} value={resolutions[item.id] || ''} onChange={e => setResolutions({ ...resolutions, [item.id]: e.target.value })} /></label>
          <button type="button" className={buttonClass} disabled={blocked || !resolutions[item.id]?.trim()} onClick={async () => {
            await review.resolveFeedback(item.id, resolutions[item.id]);
          }}>Resolve feedback after review</button>
        </>}
      </li>)}</ul>
    </details>
    {stage !== 'proof' && <details id="mv-review-planning" tabIndex={-1} open={window.location.hash === '#mv-review-planning'} style={{ scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' }}>
      <summary className="cursor-pointer min-h-[44px] py-2 text-sm">{!stage ? 'Edit visual guide and storyboard' : showArt ? 'Edit art direction and visual guide' : 'Edit alignment and storyboard shots'}</summary>
      <div className="space-y-3">
        {importError && <p role="alert">{importError}</p>}
        {showArt && <label htmlFor={fieldId('import')} className="block text-sm">Import planning JSON as an unapproved draft
          <input id={fieldId('import')} type="file" accept=".json,application/json" disabled={dirty || review.busy} className={fieldClass}
            onChange={async e => {
              const file = e.target.files?.[0]; e.target.value = ''; setImportError(null);
              if (!file) return;
              try { if (await review.importPlanning(await file.text())) setLocal(null); }
              catch (error) { setImportError(error.message); }
            }} />
        </label>}
        {showBoard && project.composition?.mode === 'document' && <div className="space-y-2 rounded border border-port-border p-2">
          <p className="text-sm">Document shot manifest</p>
          <p className="text-xs text-port-text-muted">Export the composition in Make. Have its author extract the actual shot IDs, timings and choreography from the source (for example timeline.js) into the JSON format below, keeping its documentDirectory and audioBasis from when that source was authored. A generic document section or Board row is not a shot list. Reauthor and reimport the composition after changing lyrics or timing, then import its matching manifest here.</p>
          <label htmlFor={fieldId('document-shots')} className="block text-sm">Import document shot manifest
            <input id={fieldId('document-shots')} type="file" accept=".json,application/json" disabled={dirty || review.busy || !project.productionReview?.draft || !project.composition.document} className={fieldClass}
              onChange={async e => {
                const file = e.target.files?.[0]; e.target.value = ''; setImportError(null);
                if (!file) return;
                try {
                  const input = JSON.parse(await file.text());
                  if (await review.importDocumentShots(input)) setLocal(null);
                } catch (error) { setImportError(error.message); }
              }} />
          </label>
          <details><summary className="cursor-pointer py-2 text-sm">Shot manifest format</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ ...ready?.documentShotImport, sourceFile: 'timeline.js', shots: [{ id: 'source-shot-id', sceneId: null, startSec: 0, endSec: 10, lyricCueIds: [], action: 'Source action', staging: 'Source staging', camera: 'Source camera', transition: 'Source transition' }] }, null, 2)}</pre></details>
          <p className="text-xs">{project.productionReview?.documentStoryboard ? `Bound source: ${project.productionReview.documentStoryboard.sourceFile}. Reimporting a document, changing audio or editing these shots requires a new matching manifest.` : 'No document shot manifest bound. Board scenes do not stand in for source shots.'}</p>
        </div>}
        {showArt && <>
        {draft.sourceArtifactId && <button type="button" className={buttonClass} onClick={() => onOpenArtifact(draft.sourceArtifactId)}>Read preserved original planning draft</button>}
        <button type="button" className={buttonClass} disabled={dirty || review.busy || documentShots} onClick={review.prepare}>Draft art direction and shots</button>
        <p className="text-xs text-port-text-muted">Uses the saved authoring provider and allowed tools. Builds Cast & Sets first, then pauses for art approval before planning shots. Existing edits are retained.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries({ cast: 'Cast guide', environments: 'Environment guide', visualLanguage: 'Visual language and mood board' }).map(([key, label]) =>
            <label key={key} htmlFor={fieldId(key)} className="text-sm">{label}<textarea id={fieldId(key)} rows={4} value={draft[key]} onChange={e => set(key, e.target.value)} className={fieldClass} /></label>)}
        </div>
        <label htmlFor={fieldId('motionLanguage')} className="block text-sm">Timed choreography and energy plan
          <textarea id={fieldId('motionLanguage')} rows={7} value={draft.motionLanguage || ''} onChange={e => set('motionLanguage', e.target.value)} className={fieldClass}
            aria-label="Timed choreography and energy plan" aria-describedby={fieldId('motion-help')}
            placeholder={'Energy target: restrained, driving, explosive, or a described arc.\n0:00–0:08 / first downbeat: subject reaches, prop unfolds; camera pushes in; title lands on the vocal.\n0:08–0:16 / chorus hit: full-body turn and prop release; camera arcs; type expands then clears.\nRepeated chorus: preserve the motif, escalate pose range, travel, camera depth or transition scale.'} />
        </label>
        <p id={fieldId('motion-help')} className="text-xs text-port-text-muted">Choose the intended energy explicitly. For each time range and beat, word or section anchor, describe subject and prop actions, pose or travel changes, camera movement, typography and the transition. Name intentional holds and how each repeated chorus develops. The saved plan guides UI authoring and autopilot.</p>
        <label htmlFor={fieldId('implementation')} className="block text-sm">Implementation and feasibility for {project.composition?.mode || 'composed'} rendering
          <textarea id={fieldId('implementation')} rows={5} value={draft.implementationPlan || ''} onChange={e => set('implementationPlan', e.target.value)} className={fieldClass}
            placeholder="Map each timed action to scene graph layers, vector/mesh construction, rig joints, pose limits and prop mechanics; specify camera paths and typography timing, transitions, frame rate, geometry and draw-call budgets." />
        </label>
        <p className="text-xs text-port-text-muted">Concept references establish intent. Document how this renderer can build and animate the look; a raster reference is not code-rendered evidence. Changing the plan invalidates prior art approval.</p>
        <label htmlFor={fieldId('guide')} className="block text-sm">Visual cast and environment sheet
          <select id={fieldId('guide')} value={draft.guideArtifactId || ''} onChange={e => set('guideArtifactId', e.target.value || null)} className={fieldClass}>
            <option value="">Choose a Development artifact</option>
            {(project.devArtifacts || []).filter(a => !a.deleted).map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </label>
        {draft.guideArtifactId && <button type="button" className={buttonClass} onClick={() => onOpenArtifact(draft.guideArtifactId)}>Review visual sheet</button>}
        </>}
        {showBoard && <>
        {/* Song content and lyric-timing verification live on the Song step (LyricTimingCheck). */}
        <label htmlFor={fieldId('storyboard-source')} className="block text-sm">Storyboard source
          <select id={fieldId('storyboard-source')} value={draft.storyboardSource || 'board'} onChange={e => set('storyboardSource', e.target.value)} className={fieldClass}>
            <option value="board">Board scenes</option><option value="document">Authored document shot manifest</option>
          </select>
        </label>
        {shots.map(shot => {
          const scene = documentShots ? shot : project.scenes?.find(s => s.sceneId === shot.sceneId);
          return <details key={shotKey(shot)} className="rounded border border-port-border p-2">
            <summary className="cursor-pointer min-h-[44px] text-sm">{scene?.label || shot.id || 'Unbound shot'} — {documentShots ? 'document source shot' : scene ? 'edit choreography' : 'bind to a Board scene'}</summary>
            {!documentShots && <label htmlFor={fieldId(`scene-${shotKey(shot)}`)} className="block text-sm">Board scene
              <select id={fieldId(`scene-${shotKey(shot)}`)} value={shot.sceneId || ''} onChange={e => setShot(shot, 'sceneId', e.target.value || null)} className={fieldClass}>
                <option value="">Unbound draft — no scene selected</option>
                {(project.scenes || []).map(s => <option key={s.sceneId} value={s.sceneId}>{s.label || s.sceneId}</option>)}
              </select>
            </label>}
            {!documentShots && !scene && <button type="button" className={buttonClass} disabled={dirty || review.busy || !shot.id} onClick={() => review.bindShot(shot.id)}>Create Board scene from this draft shot</button>}
            {documentShots ? <div className="flex flex-wrap gap-2">
              {['startSec', 'endSec'].map(key => <label key={key} htmlFor={fieldId(`${shotKey(shot)}-${key}`)} className="text-sm">{key === 'startSec' ? 'Shot start (seconds)' : 'Shot end (seconds)'}<input id={fieldId(`${shotKey(shot)}-${key}`)} type="number" min="0" step="0.01" value={shot[key] ?? ''} onChange={e => setShot(shot, key, e.target.value === '' ? null : Number(e.target.value))} className={fieldClass} /></label>)}
              <p className="text-xs text-port-text-muted">Planning edits do not rewrite source code. Reauthor or reimport in Make, then import its matching shot manifest before approval.</p>
            </div> : <p className="text-xs text-port-text-muted">{scene && Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) ? `Shot window ${formatTimecode(scene.startSec)}–${formatTimecode(scene.endSec)}. ` : ''}Review exact start/end in Board. Imported timings remain provisional.</p>}
            {['action', 'staging', 'camera', 'transition'].map(key => <label key={key} htmlFor={fieldId(`${shotKey(shot)}-${key}`)} className="block text-sm capitalize">{key}
              <textarea id={fieldId(`${shotKey(shot)}-${key}`)} rows={2} value={shot[key]} placeholder={({ action: 'At a beat or word: subject and prop action; pose, travel and energy change.', staging: 'Depth, blocking, prop trajectory and typography placement through the shot.', camera: 'Timed camera path, framing changes and motivated holds.', transition: 'Exact entry/exit anchor, visual handoff and escalation into the next section.' })[key]} onChange={e => setShot(shot, key, e.target.value)} className={fieldClass} />
            </label>)}
            <fieldset><legend className="text-sm">Lyric anchors</legend>
              {(project.lyricCues || []).filter(c => c.startSec < scene?.endSec && c.endSec > scene?.startSec).map(cue =>
                <label key={cue.id} htmlFor={fieldId(`${shotKey(shot)}-${cue.id}`)} className="flex gap-2 py-2 text-sm"><input id={fieldId(`${shotKey(shot)}-${cue.id}`)} type="checkbox" checked={shot.lyricCueIds.includes(cue.id)}
                  onChange={e => setShot(shot, 'lyricCueIds', e.target.checked ? [...shot.lyricCueIds, cue.id] : shot.lyricCueIds.filter(id => id !== cue.id))} />{cue.text}</label>)}
            </fieldset>
          </details>;
        })}
        </>}
        <button type="button" className={buttonClass} disabled={!dirty || review.busy} onClick={async () => { if (await review.save(draft)) setLocal(null); }}>Save planning edits</button>
        {dirty && <p role="status" className="text-sm">Save edits before preparing, approving or rendering.</p>}
      </div>
    </details>}
  </section>;
}
