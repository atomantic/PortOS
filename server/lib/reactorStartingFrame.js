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
 *
 * EXIF orientation is load-bearing here, not a refinement. A phone camera
 * writes its sensor buffer unrotated and records the display rotation in an
 * EXIF tag, so a portrait iPhone photo is stored 4032x3024 — LANDSCAPE — with
 * `orientation: 6`. `sharp.metadata()` reports those raw dimensions no matter
 * how it was constructed, so measuring without consulting the tag derives a
 * landscape canvas for a portrait photo (the exact failure this module exists
 * to prevent), and cropping without applying it centre-crops a sideways
 * buffer. Both halves must honour it: `readImageSize` swaps the axes, and the
 * resize decodes through `autoOrient`.
 */
import { rm } from 'node:fs/promises';
import sharp from 'sharp';
import {
  REACTOR_DEFAULT_ASPECT, nearestReactorAspect, reactorCanvas,
} from './reactorVideoClip.js';

/** EXIF orientations 5-8 transpose the image, so its displayed axes are swapped. */
const EXIF_SWAPS_AXES = (orientation) => Number(orientation) >= 5 && Number(orientation) <= 8;

/**
 * An image's DISPLAYED size — `{ width, height, oriented }` — or `null` when it
 * could not be measured. `oriented` is true when EXIF asks for a transform, so
 * a caller knows the bytes on disk are not what a viewer sees.
 */
export const readImageSize = async (path) => {
  const meta = await sharp(path).metadata().catch(() => null);
  const raw = { width: Number(meta?.width), height: Number(meta?.height) };
  if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height) || raw.width <= 0 || raw.height <= 0) return null;
  const swap = EXIF_SWAPS_AXES(meta?.orientation);
  return {
    width: swap ? raw.height : raw.width,
    height: swap ? raw.width : raw.height,
    // Orientation 1 is the identity; anything else (including the flips, 2-4)
    // still needs the re-encode, so this is not just the axis-swap set.
    oriented: Number(meta?.orientation) > 1,
  };
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
  // Unmeasurable, or already exactly the canvas: nothing to gain from a
  // re-encode. An image awaiting an EXIF transform is NOT "already the canvas"
  // even when its displayed size matches — uploading those bytes hands reactor
  // a sideways frame.
  if (!size || (!size.oriented && size.width === canvas.width && size.height === canvas.height)) return passthrough;
  const fittedPath = `${outputPath}.start.png`;
  const written = await sharp(sourceImagePath, { autoOrient: true })
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
