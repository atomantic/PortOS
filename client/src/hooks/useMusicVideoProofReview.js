/**
 * Revision-bound animated-proof playback state, render range, approval blockers and evidence payload.
 *
 * Returns playback/media setters, `range`/`setRange`, and approval state/actions. Use when:
 * `ProductionReviewPanel` and its proof content.
 */

import { useEffect, useState } from 'react';

const EMPTY_PLAYBACK = { timecodedNotes: '' };

/** Proof playback evidence belongs to the exact project, creative basis and rendered file. */
export default function useMusicVideoProofReview({ project, review, ready, blocked }) {
  const [proofMedia, setProofMedia] = useState(null);
  const [playbackReview, setPlaybackReview] = useState({ ...EMPTY_PLAYBACK, identity: null });
  const [startSec, setStartSec] = useState(project.productionReview?.proof?.startSec || 0);
  const [endSec, setEndSec] = useState(project.productionReview?.proof?.endSec || Math.min(20, project.audioAnalysis?.durationSec || 20));
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
  // Without a current proof the next thing to do is render one, so its controls lead the box.
  const needsRender = !excerpt || ['error', 'canceled'].includes(excerpt.status)
    || (project.productionReview?.proof?.basis && ready?.basis.proof && project.productionReview.proof.basis !== ready.basis.proof);
  const approvalDisabled = blocked || ready?.proof.approved || !!ready?.proof.problems.length || playbackBlocked;
  // Machine reviews are agent-only (API); the human form always records playback.
  const approvalLabel = 'Approve proof — watched with sound';
  const approvalBlocker = () => {
    if (review.proof.active) return 'Wait for the proof to finish rendering.';
    if (playbackBlocked) return needsRender ? 'Render a 10–45 second chorus proof, then watch it with sound.' : 'Play the proof below with sound first.';
    return null;
  };
  const approvalPayload = () => ({ method: 'playback', watchedWithAudio: true,
      ...(playback.timecodedNotes.trim() ? { timecodedNotes: playback.timecodedNotes.trim() } : {}),
      excerptId: excerpt.id, filename: excerpt.filename });
  return { excerpt, proofIdentity, needsRender, playback, setPlayback, setProofMedia, proofMedia,
    matchingRecordedReview, playbackBlocked, approvalLabel, approvalDisabled,
    approvalBlocker, approvalPayload, range: { startSec, endSec },
    setRange: patch => {
      if ('startSec' in patch) setStartSec(patch.startSec);
      if ('endSec' in patch) setEndSec(patch.endSec);
    } };
}
