import { basename } from 'node:path';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { musicVideoStyleImages, musicVideoStylePrompt, musicVideoStyleReferenceCapacity } from '../../lib/musicVideoConditioning.js';

/** Resolve style capacity on the actual route, preserving every explicit identity input. */
export async function withMusicVideoStyle(project, params, mode, model, settings) {
  if (!project?.styleReferences?.length) return params;
  let localModel = null;
  if (mode === 'local') {
    const [{ selectLocalImageModelFromSettings }, { getImageModels }] = await Promise.all([
      import('../imageGen/prepareParams.js'), import('../../lib/mediaModels.js'),
    ]);
    localModel = selectLocalImageModelFromSettings(settings, model, getImageModels());
  }
  const identities = params.referenceImagePaths || [];
  const capacity = musicVideoStyleReferenceCapacity(mode, localModel);
  const styles = musicVideoStyleImages(project, identities.map((p) => basename(p)), capacity)
    .map((id) => resolveGalleryImage(id, { mustExist: false })).filter((p) => p && !identities.includes(p));
  return {
    ...params,
    prompt: [params.prompt, musicVideoStylePrompt(project, styles.length)].filter(Boolean).join('. '),
    ...(styles.length ? {
      referenceImagePaths: [...identities, ...styles],
      referenceImageStrengths: [...(params.referenceImageStrengths || identities.map(() => 1)), ...styles.map(() => 1)],
    } : {}),
  };
}
