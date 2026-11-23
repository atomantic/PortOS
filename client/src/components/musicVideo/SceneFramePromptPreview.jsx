import { authoredFramePromptText } from '../../../../server/lib/musicVideo/musicVideoShotPrompt.js';
import { musicVideoFrameGenSize } from '../../../../server/lib/musicVideo/musicVideoAspect.js';
import useModelInputPreview from '../../hooks/useModelInputPreview.js';
import { previewImagePrompt } from '../../services/apiImageVideo.js';
import ModelInputPreview from '../media/ModelInputPreview.jsx';

/** The actual image backend's prompt preview, including its wrappers and style additions.
 * References are resolved on the server from the shot, the same way the frame render is (#15583).
 * `enabled` false (its panel is hidden) sends no preview request until the panel shows (#16306). */
export default function SceneFramePromptPreview({ project, scene, slot, referenceImageId = null, instruction = null, includeReferences = true, enabled = true, imageTarget = null }) {
  const prompt = instruction ?? authoredFramePromptText(scene, slot);
  const preview = useModelInputPreview(previewImagePrompt, {
    prompt, ...musicVideoFrameGenSize(project),
    ...(imageTarget?.mode ? {
      mode: imageTarget.mode,
      ...(imageTarget.modelId ? { modelId: imageTarget.modelId } : {}),
      ...(imageTarget.cloudModel ? { cloudModel: imageTarget.cloudModel } : {}),
    } : {}),
    musicVideo: {
      projectId: project.id, sceneId: scene.sceneId, catalogBasis: project.castAndSets?.catalogCheckin?.basis, compose: true,
      ...(referenceImageId ? { leadImageId: referenceImageId } : {}),
      ...(slot === 'end' ? { slot: 'end' } : {}),
      ...(instruction !== null ? { refine: true } : referenceImageId ? { fromFrame: true } : {}),
      ...(!includeReferences ? { includeReferences: false } : {}),
    },
  }, { enabled });
  return <ModelInputPreview prompt={prompt} preview={preview} />;
}
