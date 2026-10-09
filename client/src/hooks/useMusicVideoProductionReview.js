import { useEffect, useRef, useState } from 'react';
import { checkMusicVideoOverlayText, reverifyMusicVideoAlignment, importMusicVideoDocumentShots, getMusicVideoProductionReview, saveMusicVideoProductionDraft, prepareMusicVideoProductionReview,
  approveMusicVideoProductionReview, renderMusicVideoProductionProof, musicVideoExcerptRenderEventsUrl,
  cancelMusicVideoExcerptRender, importMusicVideoProductionPlanning, bindMusicVideoProductionShot, addMusicVideoProductionFeedback, resolveMusicVideoProductionFeedback, reviseMusicVideoProductionFromFeedback, revertMusicVideoProductionInput } from '../services/apiMusicVideo.js';
import useSseJobSlot from './useSseJobSlot.js';

/**
 * Server-authoritative approvals. A read response carries `productionReadiness`; a mutation response
 * does not, so the last readiness for the same project stays in place (never a flash of "not done"; `current` says whether it is for this exact revision)
 * while one review fetch refreshes it. Approvals still bind to the server-issued basis, so a stale
 * basis is refused rather than honoured.
 */
export default function useMusicVideoProductionReview({ project, replaceProject }) {
  const latest = useRef(project);
  latest.current = project;
  const seenProofJobs = useRef(new Set());
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [readinessError, setReadinessError] = useState(null);
  useEffect(() => {
    let active = true;
    if (project?.productionReadiness) setState({ id: project.id, owner: project, readiness: project.productionReadiness });
    else if (project?.id) getMusicVideoProductionReview(project.id, { silent: true })
      .then(result => { if (active) { setState({ id: project.id, owner: project, readiness: result.readiness }); setReadinessError(null); } })
      .catch(err => { if (active) setReadinessError(err.message); });
    return () => { active = false; };
  }, [project]);
  const refresh = async id => {
    const owner = latest.current;
    if (owner?.id !== id) return;
    const result = await getMusicVideoProductionReview(id, { silent: true });
    if (latest.current === owner) replaceProject(result.project);
  };
  const proof = useSseJobSlot({
    startRequest: ({ id, window }) => renderMusicVideoProductionProof(id, window, { silent: true }),
    eventsUrl: musicVideoExcerptRenderEventsUrl, cancelRequest: cancelMusicVideoExcerptRender,
    readPercent: frame => Number.isFinite(frame.progress) ? frame.progress * 100 : undefined,
    onKickoffSuccess: (job, { id }) => { seenProofJobs.current.add(job); refresh(id).catch(err => setError(err.message)); },
    onSettled: (_reason, id) => { refresh(id).catch(err => setError(err.message)); },
    errorFallback: 'The proof render failed',
  });
  useEffect(() => {
    const refs = [project?.productionReview?.proof?.excerptId, project?.productionReview?.prototype?.excerptId];
    const excerpt = project?.excerpts?.find(e => refs.includes(e.id) && e.status === 'rendering' && e.jobId);
    if (excerpt && !seenProofJobs.current.has(excerpt.jobId) && proof.attach(excerpt.jobId, project.id)) seenProofJobs.current.add(excerpt.jobId);
  }, [project, proof.active]);
  const call = async operation => {
    if (!project || busy) return null;
    const owner = project;
    setBusy(true); setError(null);
    try {
      const result = await operation();
      if (latest.current === owner) replaceProject(result.project);
      return result;
    } catch (err) { if (latest.current === owner) setError(err.message); return null; }
    finally { setBusy(false); }
  };
  const readiness = project?.productionReadiness || (state && state.id === project?.id ? state.readiness : null);
  // `current`: readiness belongs to this exact project revision. Stage marks may use a stale value;
  // approval controls must wait for a current one.
  const current = !!project?.productionReadiness || state?.owner === project;
  return { readiness, current, readinessError: readiness ? null : readinessError, busy, error, proof: { ...proof, occupied: proof.active, active: proof.active && proof.context === project?.id },
    feedback: body => call(() => addMusicVideoProductionFeedback(project.id, { ...body, basis: readiness?.basis[body.stage] }, { silent: true })),
    resolveFeedback: (feedbackId, resolution) => call(() => resolveMusicVideoProductionFeedback(project.id, { feedbackId, resolution }, { silent: true })),
    revise: stage => call(() => reviseMusicVideoProductionFromFeedback(project.id, { stage }, { silent: true })),
    revert: (stage, field) => call(() => revertMusicVideoProductionInput(project.id, { stage, field }, { silent: true })),
    importDocumentShots: body => call(() => importMusicVideoDocumentShots(project.id, body, { silent: true })),
    importPlanning: source => call(() => importMusicVideoProductionPlanning(project.id, source, { silent: true })),
    bindShot: shotId => call(() => bindMusicVideoProductionShot(project.id, shotId, { silent: true })),
    // Starts the overlay text check; its result arrives on the project push when it finishes.
    checkOverlayText: () => call(() => checkMusicVideoOverlayText(project.id, { silent: true })),
    reverifyAlignment: notes => call(() => reverifyMusicVideoAlignment(project.id, { basis: readiness?.alignment.basis, notes }, { silent: true })),
    save: draft => call(() => saveMusicVideoProductionDraft(project.id, draft, { silent: true })),
    prepare: () => call(() => prepareMusicVideoProductionReview(project.id, {}, { silent: true })),
    approve: (stage, proofReview) => call(() => approveMusicVideoProductionReview(project.id,
      { stage, basis: readiness?.basis[stage], ...(stage === 'proof' ? { proofReview } : {}) }, { silent: true })),
    renderProof: window => proof.start({ id: project.id, window }, project.id),
  };
}
