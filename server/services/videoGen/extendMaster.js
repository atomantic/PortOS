/**
 * Sidecar naming for the lossless audio master kept beside an Extend output.
 *
 * Its own import-free module: the history delete path and the unpublished-output
 * discard both need the name, and neither should pull in the splice's ffmpeg graph.
 */

/** `<id>.mp4` → `<id>.master.flac`, in the same directory. Null for a non-mp4 path. */
export const extendMasterPath = (videoPath) =>
  typeof videoPath === 'string' && /\.mp4$/i.test(videoPath) ? videoPath.replace(/\.mp4$/i, '.master.flac') : null;
