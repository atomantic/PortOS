import { useEffect, useState } from 'react';

const EMPTY_PLAYBACK = { method: 'playback', timecodedNotes: '', visualReview: '', audioReview: '', limitations: '' };

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
  const machineReview = playback.method === 'machine';
  const evidenceComplete = machineReview
    ? playback.visualReview.trim().length >= 40 && playback.audioReview.trim().length >= 40 && !!playback.limitations.trim()
    : true;
  // Without a current proof the next thing to do is render one, so its controls lead the box.
  const needsRender = !excerpt || ['error', 'canceled'].includes(excerpt.status)
    || (project.productionReview?.proof?.basis && ready?.basis.proof && project.productionReview.proof.basis !== ready.basis.proof);
  const approvalDisabled = blocked || ready?.proof.approved || !!ready?.proof.problems.length || playbackBlocked || !evidenceComplete;
  const approvalLabel = machineReview ? 'Approve proof with machine evidence' : 'Approve proof — watched with sound';
  const approvalBlocker = () => {
    if (review.proof.active) return 'Wait for the proof to finish rendering.';
    if (playbackBlocked) return needsRender ? 'Render a 10–45 second chorus proof, then watch it with sound.' : 'Play the proof below with sound first.';
    if (!evidenceComplete) return 'Complete the machine review notes (40+ characters each, plus limitations).';
    return null;
  };
  const approvalPayload = () => ({ watchedWithAudio: !machineReview,
      ...(machineReview ? { method: 'machine', machineEvidence: {
        visualReview: playback.visualReview.trim(), audioReview: playback.audioReview.trim(), limitations: playback.limitations.trim(),
      } } : {}),
      ...(playback.timecodedNotes.trim() ? { timecodedNotes: playback.timecodedNotes.trim() } : {}),
      excerptId: excerpt.id, filename: excerpt.filename });
  return { excerpt, proofIdentity, needsRender, playback, setPlayback, setProofMedia, proofMedia,
    matchingRecordedReview, playbackBlocked, machineReview, evidenceComplete, approvalLabel, approvalDisabled,
    approvalBlocker, approvalPayload, range: { startSec, endSec },
    setRange: patch => {
      if ('startSec' in patch) setStartSec(patch.startSec);
      if ('endSec' in patch) setEndSec(patch.endSec);
    } };
}
