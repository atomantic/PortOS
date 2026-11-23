import useMusicVideoExcerpts from './useMusicVideoExcerpts.js';
import useMusicVideoAutoReview from './useMusicVideoAutoReview.js';
import { useMusicVideoReviewDraft } from '../../../hooks/useMusicVideoReviewDraft.js';
import { useVideoFileSrc } from '../../../hooks/useVideoFileSrc.js';
import { latestMusicVideoReviewDraft } from '../../../../../server/lib/musicVideo/musicVideoReviewDraft.js';

/**
 * Final render step (Review): draft excerpts, the automatic review run, the
 * resolved final video file and an imported review draft awaiting a verdict.
 */
export default function useReviewStageWiring({ selected, replaceProject, activeStage }) {
  // Draft excerpt render (#8986): a fast cue/cut preview of a chosen window,
  // separate from the full-render job/mutex so a director can preview a
  // change without waiting on (or blocking) a full render.
  const excerpts = useMusicVideoExcerpts({ project: selected, replaceProject });
  const autoReview = useMusicVideoAutoReview({ project: selected, replaceProject });
  // Final render filename is NOT the history id — resolve once for the workspace
  // so the lightbox item and the inline player share the same lookup (#3718).
  const finalVideo = useVideoFileSrc(selected?.renderHistoryId, {
    enabled: !!selected?.renderHistoryId,
  });
  const reviewingDraft = activeStage === 'review' && !!latestMusicVideoReviewDraft(selected) && !selected?.renderHistoryId;
  const reviewDraftState = useMusicVideoReviewDraft(selected, { enabled: reviewingDraft });

  return {
    excerpts,
    autoReview,
    finalVideo,
    reviewingDraft,
    reviewDraftState,
    board: { reviewDraftState, excerpts, autoReview, finalVideo },
  };
}
