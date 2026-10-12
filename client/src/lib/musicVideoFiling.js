/**
 * Which music video an Image Gen or Video Gen render is made for. The forms
 * keep it in the `musicVideo` URL param, so it survives a reload and rides a
 * handoff from one of the video's clips (Remix, Continue, a trim), and send it
 * as `musicVideoProjectId`: the server files the render into that video's
 * collection even when no shot keeps it.
 */

export const MUSIC_VIDEO_FILING_PARAM = 'musicVideo';

/** The request fields that file a render into the video named in the URL. */
export function musicVideoFilingFields(searchParams) {
  const projectId = searchParams?.get(MUSIC_VIDEO_FILING_PARAM);
  return projectId ? { musicVideoProjectId: projectId } : {};
}

/** The music video a gallery item or history record was made for, if any. */
export function musicVideoOf(item) {
  const projectId = (item?.raw || item)?.musicVideo?.projectId;
  return typeof projectId === 'string' && projectId ? projectId : null;
}
