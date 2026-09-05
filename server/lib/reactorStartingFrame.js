/**
 * Fit a reactor.inc `starting_frame` to the fast-h3 session canvas.
 *
 * fast-h3 renders at ONE resolution per session — whichever `set_canvas`
 * aspect the session opened with (`reactorVideoClip.js#REACTOR_CANVASES`) — and
 * the API's own contract for a starting frame is "common formats decode; the
 * frame is fitted to the session canvas." That fitting is reactor's, not
 * PortOS's, and it is the part a caller cannot see: hand a 3024×4032 phone
 * photo to a 1344×768 session and what conditions the render is whatever
 * reactor's fit left of it, which is how a portrait input came back as a clip
 * with clean audio and no usable picture.
 *
 * So PortOS does the fit itself, deterministically, and tells the caller which
 * canvas it fitted TO:
 *
 * - The canvas is chosen from the frame's own shape when the request didn't
 *   name one, so a portrait photo opens a portrait session instead of being
 *   squeezed into a landscape one.
 * - The frame is then cover-cropped from the centre to the canvas's exact pixel
 *   size, so reactor's own fit is a no-op and the render is conditioned on
 *   pixels the user can predict.
 *
 * A frame that sharp cannot decode is passed through untouched with the
 * default canvas — reactor accepts more container formats than sharp does, and
 * refusing a render PortOS merely failed to measure would be worse than letting
 * reactor fit it.
 */
import { rm } from 'node:fs/promises';
import sharp from 'sharp';
import {
  REACTOR_DEFAULT_ASPECT, nearestReactorAspect, reactorCanvas,
} from './reactorVideoClip.js';

/** `{ width, height }` of an image, or `null` when it could not be measured. */
export const readImageSize = async (path) => {
  const meta = await sharp(path).metadata().catch(() => null);
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
};

/**
 * Resolve the canvas one render opens with, and the frame it starts from.
 *
 * `requestedAspect` absent means "derive it" — that is the picker's Auto entry
 * and the shape every non-UI caller (FableLoom, the API) gets by default.
 *
 * Returns `{ aspect, canvas, framePath, fittedPath }` where `framePath` is what
 * to upload and `fittedPath` is the temp file the caller must delete afterwards
 * (`null` when nothing was written).
 */
export async function prepareReactorStartingFrame(sourceImagePath, requestedAspect, outputPath) {
  if (!sourceImagePath) {
    const aspect = requestedAspect || REACTOR_DEFAULT_ASPECT;
    return { aspect, canvas: reactorCanvas(aspect), framePath: null, fittedPath: null };
  }
  const size = await readImageSize(sourceImagePath);
  const aspect = requestedAspect
    || (size ? nearestReactorAspect(size.width, size.height) : REACTOR_DEFAULT_ASPECT);
  const canvas = reactorCanvas(aspect);
  const passthrough = { aspect, canvas, framePath: sourceImagePath, fittedPath: null };
  // Unmeasurable, or already exactly the canvas: nothing to gain from a re-encode.
  if (!size || (size.width === canvas.width && size.height === canvas.height)) return passthrough;
  const fittedPath = `${outputPath}.start.png`;
  const written = await sharp(sourceImagePath)
    .resize({ width: canvas.width, height: canvas.height, fit: 'cover', position: 'centre' })
    .png()
    .toFile(fittedPath)
    .then(() => true)
    .catch(() => false);
  if (!written) {
    // A failed encode can still have created the destination. Nothing reports
    // this path back to the caller (passthrough carries `fittedPath: null`), so
    // its cleanup would never run and a truncated PNG would sit in the video
    // gallery directory forever.
    await rm(fittedPath, { force: true }).catch(() => {});
    return passthrough;
  }
  console.log(`🖼️ Reactor starting frame fitted ${size.width}x${size.height} → ${canvas.width}x${canvas.height} (${aspect})`);
  return { aspect, canvas, framePath: fittedPath, fittedPath };
}
