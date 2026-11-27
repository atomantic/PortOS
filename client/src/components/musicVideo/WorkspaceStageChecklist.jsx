import StageChecklist from './StageChecklist.jsx';
import { stageChecklist } from '../../lib/musicVideoStages.js';

export default function WorkspaceStageChecklist({
  activeStage, stageProject, productionReview, publish, publishStage, castSets,
  runChecklistAction, nextAction,
}) {
  const { publishBuildBlockedReason, publishKit } = publishStage;
  return (
    <StageChecklist
      items={stageChecklist(activeStage, stageProject, productionReview.readiness, publish).map((item) => publishBuildBlockedReason && item.action?.run === 'build-publish-kit'
        ? { ...item, detail: publishBuildBlockedReason, action: { ...item.action, disabled: true, reason: publishBuildBlockedReason } } : item)}
      onAction={runChecklistAction}
      busy={castSets.busy || productionReview.busy || publishKit.building}
      onRevert={productionReview.revert}
      headerAnchor={nextAction?.kind === 'goto' ? nextAction.anchor : null}
    />
  );
}
