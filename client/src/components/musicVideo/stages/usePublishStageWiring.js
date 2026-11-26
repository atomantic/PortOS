import useMusicVideoPublishKit from './useMusicVideoPublishKit.js';
import { PUBLISH_TARGETS } from '../PublishPostingPanel.jsx';

// Publish counts every platform the director turned on (#9287), not just any one post.
export const publishProgress = (publishing) => ({
  targets: PUBLISH_TARGETS.filter((entry) => publishing.enabledTargets?.includes(entry.target)),
  drafts: publishing.drafts,
});

/**
 * Publish step: the publishing kit (release encodes, thumbnails, captions,
 * chapters and copy, #9281) and what blocks building it. Posting itself is a
 * page-wide slot (`publishing`), read here through the board.
 */
export default function usePublishStageWiring({ selected, replaceProject, publishing, goToStage, creativeSetupPending, styleReferencesPending, compositionSavePending }) {
  const publishKit = useMusicVideoPublishKit({ project: selected, replaceProject });
  const publishBuildBlockedReason = creativeSetupPending ? 'Save or cancel the creative setup before building the publishing kit.'
    : styleReferencesPending ? 'Save or cancel the style references before building the publishing kit.'
      : compositionSavePending > 0 ? 'Saving composition…' : publishKit.cropBlockedReason;
  const buildPublishKit = () => {
    if (!selected.renderHistoryId || publishKit.building || publishBuildBlockedReason) return;
    goToStage('publish', 'mv-publish-kit');
    publishKit.build();
  };
  return {
    publishKit,
    publishBuildBlockedReason,
    buildPublishKit,
    board: { publishKit, publishing },
  };
}
