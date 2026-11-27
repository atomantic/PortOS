import toast from '../ui/Toast';
import { formatCount } from '../../utils/formatters.js';
import { deriveAttentionItems } from '../../lib/musicVideoAttention.js';
import { deriveNextAction } from '../../lib/musicVideoStages.js';

export default function buildMusicVideoStageActions({
  selected, stageProject, productionReview, publish, progress, renderTargetsSelected,
  review, plan, renderJob, analyzing, publishStage, produce, activeStage, castSets,
  navigation,
  compositionSavePending, onAnalyze,
}) {
  const { openArtifact, setSettingsTab, editShot, goToStage } = navigation;
  const { excerpts, reviewingDraft, reviewDraftState } = review;
  const { publishKit, publishBuildBlockedReason, buildPublishKit } = publishStage;
  const { sceneMedia, production } = produce;
  const { kickoff, autonomous, planning, autopilotBlockedReason } = plan;
  const productionNextAction = selected ? deriveNextAction(stageProject, {
    readiness: productionReview.readiness,
    publish,
    progress,
    renderActive: renderTargetsSelected,
    draftActive: excerpts.rendering,
    proofActive: productionReview.proof.active,
    renderProgress: renderJob.progress,
    renderPending: renderJob.pending,
    renderBlockedByOther: !!renderJob.active && !renderTargetsSelected,
    kickoffRunning: kickoff.running,
    kickoffStep: kickoff.stepLabel,
    kickoffBlockedReason: autopilotBlockedReason,
    planning,
    analyzing,
  }) : null;
  const reviewDraft = reviewDraftState.draft;
  const nextAction = reviewingDraft ? reviewDraftState.checking
    ? { id: 'review-imported', kind: 'goto', stage: 'review', label: 'Checking review draft', disabled: true, reason: 'Checking exact-version media availability' }
    : reviewDraft
      ? { id: 'review-imported', kind: 'goto', stage: 'review', label: 'Review imported draft', shortLabel: 'Review draft' }
      : { id: 'review-files', kind: 'open', label: 'Choose review file', shortLabel: 'Choose file' }
    : productionNextAction?.id === 'build-publish-kit' && (publishKit.building || publishBuildBlockedReason)
      ? { ...productionNextAction, disabled: true, ...(publishKit.building ? { label: 'Building publishing kit…' } : { reason: publishBuildBlockedReason }) }
      : productionNextAction;
  // What the server holds that this tab might not be showing (#9940): derived
  // from the saved record, so it survives a reload. Work this tab can see
  // progressing (spinning sections, an attached render) is not flagged.
  const attentionItems = selected ? deriveAttentionItems(stageProject, {
    generatingSceneIds: new Set([...Object.keys(sceneMedia.genScenes || {}), ...Object.keys(sceneMedia.genVideoScenes || {})]
      .filter((sceneId) => sceneMedia.genScenes?.[sceneId] || sceneMedia.genVideoScenes?.[sceneId])),
    draftRendering: excerpts.rendering,
    finalRenderAttached: renderTargetsSelected,
    readiness: productionReview.readiness,
    headerAction: nextAction,
    stage: activeStage,
  }) : [];
  // A checklist row either jumps to the control that settles it or, for work
  // the page can start itself (build or resume the cast & sets, fill the art
  // direction from an approved sheet), starts it.
  // Revising re-plans or regenerates in place; the requests stay open until the director resolves each one.
  const reviseFromFeedback = async (stage) => {
    const result = await productionReview.revise(stage);
    if (!result) return;
    const count = result.revision?.sceneIds?.length;
    toast.success(stage === 'art' ? 'Cast & Sets is regenerating with these requests. Review the new sheet, then resolve each request.'
      : stage === 'storyboard' ? `Revised ${formatCount(count)} shot${count === 1 ? '' : 's'}. Review them, then resolve each request.`
        : 'A revised composition is ready. Render and review a new proof, then resolve each request.');
  };
  // "Keep approved" on a stale approval: the Cast & Sets check-in is re-stamped on its
  // current inputs; a production approval is given again on the current revision.
  const keepApproval = (stage) => (stage === 'castAndSets' ? castSets.reconfirm() : productionReview.approve(stage));
  const runChecklistAction = (action) => {
    if (action.run === 'build-publish-kit') { buildPublishKit(); return; }
    if (action.run === 'start-cast-sets') { castSets.start(); return; }
    if (action.run === 'resume-cast-sets') { castSets.resume(); return; }
    if (action.run === 'prepare-art') { productionReview.prepare(); return; }
    if (action.run === 'resolve-feedback') { productionReview.resolveFeedback(action.feedbackId, ''); return; }
    if (action.run === 'revise-feedback') { reviseFromFeedback(action.stage); return; }
    if (action.run === 'keep-approval') { keepApproval(action.stage); return; }
    if (action.run === 'sync-lyric-anchors') { productionReview.syncLyricAnchors(); return; }
    if (action.run === 'remove-stale-rows') { productionReview.removeStaleRows(); return; }
    if (action.editShot) { editShot(action.editShot); return; }
    goToStage(action.stage || activeStage, action.anchor, action.params);
  };
  const runNextAction = () => {
    if (!selected || !nextAction || nextAction.disabled || compositionSavePending > 0) return;
    if (nextAction.id === 'review-imported') { openArtifact(reviewDraft.artifactId); return; }
    if (nextAction.id === 'review-files') { setSettingsTab('files'); return; }
    if (nextAction.id === 'review-autonomous') { setSettingsTab('autopilot'); return; }
    if (nextAction.id === 'build-publish-kit') { buildPublishKit(); return; }
    if (nextAction.kind === 'goto') { goToStage(nextAction.stage, nextAction.anchor); return; }
    switch (nextAction.id) {
      case 'kickoff': plan.handleKickoff(); break;
      case 'analyze': onAnalyze(); break;
      case 'plan': plan.handlePlan(); break;
      case 'approve-cast-sets': plan.approveCastAndSets(); break;
      case 'resume-cast-sets': castSets.resume(); break;
      case 'start-cast-sets': castSets.start(); break;
      case 'stop-production': production.stop(nextAction.runId); break;
      case 'resume-production': production.resume(nextAction.runId, nextAction.acceptBasis ? { acceptBasis: true } : {}); break;
      case 'resume-autonomous':
      case 'retry-autonomous':
        autonomous.resume();
        break;
      case 'render-final': renderJob.start(selected.id); break;
      default: break;
    }
  };
  return { nextAction, productionNextAction, attentionItems, runChecklistAction, runNextAction,
    keepApproval };
}
