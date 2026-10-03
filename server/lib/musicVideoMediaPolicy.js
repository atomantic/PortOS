/** Media provenance policy is independent of the composition renderer. */
export const MUSIC_VIDEO_MEDIA_MODES = ['code-only', 'code-images', 'code-images-video'];
export const MUSIC_VIDEO_MEDIA_MODE_LABELS = {
  'code-only': 'Code only', 'code-images': 'Code + images', 'code-images-video': 'Code + images + video',
};

// Old explicit code-only tool choices remain restrictive. Missing policy never
// adds tools or permits a provider the existing brief did not authorize.
export function musicVideoMediaMode(project) {
  if (MUSIC_VIDEO_MEDIA_MODES.includes(project?.mediaMode)) return project.mediaMode;
  const tools = project?.automation?.tools || project?.tools || [];
  return tools.includes('code:render') && !tools.some((id) => /^(image|video):/.test(id))
    ? 'code-only' : 'code-images-video';
}
export function musicVideoAllowsMedia(project, kind) {
  const mode = musicVideoMediaMode(project);
  return kind === 'image' ? mode !== 'code-only' : kind === 'video' ? mode === 'code-images-video' : true;
}
export function assertMusicVideoMedia(project, kind, purpose = 'asset') {
  if (musicVideoAllowsMedia(project, kind)) return;
  const error = new Error(`${MUSIC_VIDEO_MEDIA_MODE_LABELS[musicVideoMediaMode(project)]} does not allow ${kind} ${purpose}, including planning guides. Change the media mode explicitly to use this asset.`);
  Object.assign(error, { status: 422, code: 'MUSIC_VIDEO_MEDIA_POLICY' });
  throw error;
}
export function assertMusicVideoMediaSelections(project) {
  if (project?.visualSpec?.references?.length || project?.visualSpec?.moodBoardId || project?.styleReferences?.some((ref) => ref.imageId)) assertMusicVideoMedia(project, 'image', 'references');
  for (const scene of project?.scenes || []) {
    if (scene.referenceImageId) assertMusicVideoMedia(project, 'image', 'selection');
    if (scene.videoHistoryId) assertMusicVideoMedia(project, 'video', 'selection');
  }
}
export const musicVideoDocumentRenderer = (project) => project?.composition?.authoringRenderer
  || (musicVideoMediaMode(project) === 'code-only' ? 'three' : 'canvas');
