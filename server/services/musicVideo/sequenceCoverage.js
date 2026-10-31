/**
 * Read-only preview of a project's sequence coverage (#14241): which runs of
 * cutaway shots would be generated in one timed request, the exact prompt and
 * request fields that request carries, where each scene is cut from the clip,
 * and why any other shot of a `coverage: 'sequence'` scene stays per-shot.
 * Nothing is submitted or spent.
 */

import {
  buildFalVideoRequest, FAL_DEFAULT_IMAGE_VIDEO_MODEL, falPromptExpansionAddition, falPromptExpansionMode, getFalVideoModel,
} from '../../lib/falVideoModels.js';
import { authoredShotPrompt } from '../../lib/musicVideoShotPrompt.js';
import {
  composeSequencePrompt, planSequenceCoverage, sequenceClipSpans, SEQUENCE_PROMPT_EXPANSION,
} from '../../lib/musicVideoSequenceCoverage.js';

export function previewSequenceCoverage(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const settings = project?.videoSettings || {};
  const modelId = settings.backend === 'fal' ? settings.falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL : null;
  const { groups, perShot } = planSequenceCoverage(scenes, { modelId });
  const byId = new Map(scenes.map((s) => [s.sceneId, s]));
  return {
    modelId,
    perShot,
    groups: groups.map((group) => {
      const members = group.sceneIds.map((id) => byId.get(id));
      const prompt = composeSequencePrompt({
        modelId,
        shots: members.map((s, i) => ({ prompt: authoredShotPrompt(s), startSec: s.startSec, endSec: s.endSec, imageIndex: i + 1 })),
      });
      // Placeholder image URLs: the preview shows the body's shape, not hosted inputs.
      let request;
      try {
        const built = buildFalVideoRequest({
          modelId, prompt, seconds: group.durationSec, resolution: settings.falResolution,
          referenceImageUrls: members.map((s) => s.referenceImageId || 'pending-frame'),
          promptExpansion: SEQUENCE_PROMPT_EXPANSION,
        });
        const expansion = falPromptExpansionMode(getFalVideoModel(modelId), SEQUENCE_PROMPT_EXPANSION);
        request = {
          body: built.body, seconds: built.seconds, estimatedCostUsd: built.estimatedCostUsd,
          promptAdditions: [falPromptExpansionAddition(expansion)].filter(Boolean),
        };
      } catch (err) {
        request = { refusal: err.message };
      }
      return { ...group, prompt, request, spans: sequenceClipSpans(group, scenes).spans };
    }),
  };
}
