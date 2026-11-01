import { musicVideoConditioningReferences, musicVideoFrameReferenceFiles, MUSIC_VIDEO_MAX_REFERENCE_CHOICES } from '../../../../server/lib/musicVideoConditioning.js';
import { authoredFramePromptText } from '../../../../server/lib/musicVideoShotPrompt.js';
import { musicVideoFrameGenSize } from '../../../../server/lib/musicVideoAspect.js';
import useModelInputPreview from '../../hooks/useModelInputPreview.js';
import { previewImagePrompt } from '../../services/apiImageVideo.js';
import ModelInputPreview from '../media/ModelInputPreview.jsx';

/** The actual image backend's prompt preview, including its wrappers and style additions. */
export default function SceneFramePromptPreview({ project, scene, castMedia, greybox, slot, referenceImageId = null, instruction = null }) {
  const references = musicVideoFrameReferenceFiles(referenceImageId, musicVideoConditioningReferences(project, scene, castMedia, greybox), MUSIC_VIDEO_MAX_REFERENCE_CHOICES, { reservePanel: !Array.isArray(scene.frameReferenceIds) });
  const prompt = instruction ?? authoredFramePromptText(scene, slot);
  const preview = useModelInputPreview(previewImagePrompt, {
    prompt, ...musicVideoFrameGenSize(project), referenceImageFiles: references,
    musicVideo: { projectId: project.id, sceneId: scene.sceneId, compose: true, greyboxImageId: greybox?.reference?.imageId,
      ...(slot === 'end' ? { slot: 'end' } : {}),
      ...(instruction !== null ? { refine: true } : referenceImageId ? { fromFrame: true } : {}),
    },
  });
  return <ModelInputPreview prompt={prompt} preview={preview} />;
}
