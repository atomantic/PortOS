import { authoredFramePromptText } from '../../../../server/lib/musicVideoShotPrompt.js';
import { musicVideoFrameGenSize } from '../../../../server/lib/musicVideoAspect.js';
import useModelInputPreview from '../../hooks/useModelInputPreview.js';
import { previewImagePrompt } from '../../services/apiImageVideo.js';
import ModelInputPreview from '../media/ModelInputPreview.jsx';

/** The actual image backend's prompt preview, including its wrappers and style additions.
 * References are resolved on the server from the shot, the same way the frame render is (#15583). */
export default function SceneFramePromptPreview({ project, scene, slot, referenceImageId = null, instruction = null, includeReferences = true }) {
  const prompt = instruction ?? authoredFramePromptText(scene, slot);
  const preview = useModelInputPreview(previewImagePrompt, {
    prompt, ...musicVideoFrameGenSize(project),
    musicVideo: {
      projectId: project.id, sceneId: scene.sceneId, catalogBasis: project.castAndSets?.catalogCheckin?.basis, compose: true,
      ...(referenceImageId ? { leadImageId: referenceImageId } : {}),
      ...(slot === 'end' ? { slot: 'end' } : {}),
      ...(instruction !== null ? { refine: true } : referenceImageId ? { fromFrame: true } : {}),
      ...(!includeReferences ? { includeReferences: false } : {}),
    },
  });
  return <ModelInputPreview prompt={prompt} preview={preview} />;
}
