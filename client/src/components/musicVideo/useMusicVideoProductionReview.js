/**
 * Server-authoritative art/storyboard/proof approvals and SSE proof rendering, with stale-readiness
 * suppression.
 *
 * Use when: Music Video production review.
 */

import { useEffect, useRef, useState } from 'react';
import { checkMusicVideoOverlayText, reverifyMusicVideoAlignment, importMusicVideoDocumentShots, getMusicVideoProductionReview, getMusicVideoProductionReadiness, saveMusicVideoProductionDraft, prepareMusicVideoProductionReview,
  approveMusicVideoProductionReview, renderMusicVideoProductionProof, musicVideoExcerptRenderEventsUrl,
  cancelMusicVideoExcerptRender, importMusicVideoProductionPlanning, bindMusicVideoProductionShot, addMusicVideoProductionFeedback, resolveMusicVideoProductionFeedback, syncMusicVideoLyricAnchors, removeMusicVideoStaleStoryboardRows, reviseMusicVideoProductionFromFeedback, revertMusicVideoProductionInput } from '../../services/apiMusicVideo.js';
import useSseJobSlot from '../../hooks/useSseJobSlot.js';
import { ownWrite } from '../../services/socketWriteOrigin.js';
import { applyMusicVideoEdit } from '../../lib/musicVideoEditResult.js';

const WHOLE = Object.freeze({ whole: true });

/**
 * Server-authoritative approvals. A read response carries `productionReadiness`; a record pushed
 * without it keeps the last readiness for the same project in place (never a flash of "not done";
 * `current` says whether it is for this exact revision) while one readiness fetch refreshes it.
 * Approvals still bind to the server-issued basis, so a stale basis is refused rather than honoured.
 *
 * Single-write review actions answer with the board edit result, not the project (#16210): it is
 * patched in through the page's `applyEdit` (readiness included) unless a take decision started
 * meanwhile (`takesRef`), which reloads instead. Without `applyEdit` (a bare harness) the same
 * reducer folds it into the held project.
 */
export default function useMusicVideoProductionReview({ project, replaceProject, applyEdit = null, reloadOpenProject = null, takesRef = null }) {
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
    else if (project?.id) getMusicVideoProductionReadiness(project.id, { silent: true })
      .then(result => { if (active) { setState({ id: project.id, owner: project, readiness: result.readiness }); setReadinessError(null); } })
      .catch(err => { if (active) setReadinessError(err.message); });
    return () => { active = false; };
  }, [project]);
  const refresh = async id => {
    const owner = latest.current;
    if (owner?.id !== id) return;
    if (reloadOpenProject) { await reloadOpenProject(id); return; }
    const result = await getMusicVideoProductionReview(id, { silent: true });
    if (latest.current === owner) replaceProject({ ...result.project, productionReadiness: result.readiness });
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
  // An edit result is diffed against a base revision the reducer checks, so it applies to whatever the
  // board now holds of the same project; a whole-project reply only replaces the record it was asked from.
  const settle = (owner, result, mark) => {
    if (!result.edit) {
      if (latest.current === owner) replaceProject(result.readiness ? { ...result.project, productionReadiness: result.readiness } : result.project);
      return;
    }
    if (latest.current?.id !== owner.id) return;
    if (!applyEdit) {
      const next = applyMusicVideoEdit(latest.current, result.edit);
      if (next) replaceProject(next); else refresh(owner.id).catch(err => setError(err.message));
    } else if (!takesRef?.current || takesRef.current.settledSince(mark)) applyEdit(owner.id, result.edit);
    else void reloadOpenProject?.(owner.id);
  };
  // `send(options)`. An edit-result action is this tab's own write when the page applies its reply.
  // Prepare, revise, the text check and a plan import (`WHOLE`) answer with the whole project and are not own writes:
  // their change broadcast reloads the presented record.
  const call = async (send, { whole = false } = {}) => {
    if (!project || busy) return null;
    const owner = project;
    const mark = takesRef?.current?.writeMark();
    setBusy(true); setError(null);
    try {
      const result = await send(applyEdit && !whole ? ownWrite() : { silent: true });
      settle(owner, result, mark);
      return result;
    } catch (err) { if (latest.current === owner) setError(err.message); return null; }
    finally { setBusy(false); }
  };

  const readiness = project?.productionReadiness || (state && state.id === project?.id ? state.readiness : null);
  // `current`: readiness belongs to this exact project revision. Stage marks may use a stale value;
  // approval controls must wait for a current one.
  const current = !!project?.productionReadiness || state?.owner === project;
  return { readiness, current, readinessError: readiness ? null : readinessError, busy, error, proof: { ...proof, occupied: proof.active, active: proof.active && proof.context === project?.id },
    feedback: body => call(options => addMusicVideoProductionFeedback(project.id, { ...body, basis: readiness?.basis[body.stage] }, options)),
    resolveFeedback: (feedbackId, resolution) => call(options => resolveMusicVideoProductionFeedback(project.id, { feedbackId, resolution }, options)),
    // Anchor the flagged shots (or `sceneIds`) to the lyric lines sung over them.
    syncLyricAnchors: sceneIds => call(options => syncMusicVideoLyricAnchors(project.id, sceneIds ? { sceneIds } : {}, options)),
    // Drop the storyboard rows left from deleted shots.
    removeStaleRows: () => call(options => removeMusicVideoStaleStoryboardRows(project.id, options)),
    revise: stage => call(options => reviseMusicVideoProductionFromFeedback(project.id, { stage }, options), WHOLE),
    revert: (stage, field) => call(options => revertMusicVideoProductionInput(project.id, { stage, field }, options)),
    importDocumentShots: body => call(options => importMusicVideoDocumentShots(project.id, body, options)),
    importPlanning: source => call(options => importMusicVideoProductionPlanning(project.id, source, options), WHOLE),
    bindShot: shotId => call(options => bindMusicVideoProductionShot(project.id, shotId, options)),
    // Starts the overlay text check; its result arrives on the project push when it finishes.
    checkOverlayText: () => call(options => checkMusicVideoOverlayText(project.id, options), WHOLE),
    reverifyAlignment: notes => call(options => reverifyMusicVideoAlignment(project.id, { basis: readiness?.alignment.basis, notes }, options)),
    save: draft => call(options => saveMusicVideoProductionDraft(project.id, draft, options)),
    prepare: () => call(options => prepareMusicVideoProductionReview(project.id, {}, options), WHOLE),
    approve: (stage, proofReview) => call(options => approveMusicVideoProductionReview(project.id,
      { stage, basis: readiness?.basis[stage], ...(stage === 'proof' ? { proofReview } : {}) }, options)),
    renderProof: window => proof.start({ id: project.id, window }, project.id),
  };
}
