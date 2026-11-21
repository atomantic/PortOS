/**
  * Fit a reactor.inc `starting_frame` to the fast-h3 session canvas.
  *
  * fast-h3 renders at ONE resolution per session (the `set_canvas` aspect the session opened with, `reactorVideoClip.js#REACTOR_CANVASES`) and the API only promises "common formats decode; the frame is fitted to the session canvas", a fit invisible to the caller (a 3024×4032 phone photo into a 1344×768 session conditioned a portrait input into a clip with clean audio and no usable picture). So PortOS fits deterministically and reports which canvas it fitted TO: the canvas is chosen from the frame's own shape when none was requested (a portrait photo opens a portrait session), then the frame is cover-cropped from the centre to the canvas's exact pixel size so reactor's fit is a no-op. A frame sharp can't decode passes through untouched with the default canvas (reactor accepts more containers; refusing what PortOS merely failed to measure is worse). EXIF orientation is load-bearing: a phone writes its sensor buffer unrotated with an EXIF tag (a portrait iPhone photo is stored 4032x3024 with `orientation: 6`) and `sharp.metadata()` reports the raw dimensions, so measuring without the tag derives a landscape canvas for a portrait photo and cropping without applying it centre-crops a sideways buffer. Both halves honour it: `readImageSize` swaps the axes and the resize decodes through `autoOrient`.
 */
import { rm } from 'node:fs/promises';
import {
  REACTOR_DEFAULT_ASPECT, nearestReactorAspect, reactorCanvas,
} from './reactorVideoClip.js';

/** EXIF orientations 5-8 transpose the image, so its displayed axes are swapped. */
const EXIF_SWAPS_AXES = (orientation) => Number(orientation) >= 5 && Number(orientation) <= 8;

/** An image's DISPLAYED size `{ width, height, oriented }`, or `null` when unmeasurable; `oriented` is true when EXIF asks for a transform (the bytes on disk aren't what a viewer sees). */
export const readImageSize = async (path) => {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(path).metadata().catch(() => null);
  const raw = { width: Number(meta?.width), height: Number(meta?.height) };
  if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height) || raw.width <= 0 || raw.height <= 0) return null;
  const swap = EXIF_SWAPS_AXES(meta?.orientation);
  return {
    width: swap ? raw.height : raw.width,
    height: swap ? raw.width : raw.height,
    // Orientation 1 is the identity; anything else (including the flips, 2-4) still needs the re-encode, so this is not just the axis-swap set.
    oriented: Number(meta?.orientation) > 1,
  };
};

/**
 * Resolve the canvas one render opens with and the frame it starts from. `requestedAspect` absent means "derive it" (the picker's Auto entry and the default for every non-UI caller: FableLoom, the API).
 * Returns `{ aspect, canvas, framePath, fittedPath }`: `framePath` is what to upload; `fittedPath` is the temp file the caller must delete afterwards (`null` when nothing was written).
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
  // Unmeasurable, or already exactly the canvas: nothing to gain from a re-encode. An image awaiting an EXIF transform is NOT "already the canvas" even when its displayed size matches (it would hand reactor a sideways frame).
  if (!size || (!size.oriented && size.width === canvas.width && size.height === canvas.height)) return passthrough;
  const fittedPath = `${outputPath}.start.png`;
  const { default: sharp } = await import('sharp');
  const written = await sharp(sourceImagePath, { autoOrient: true })
    .resize({ width: canvas.width, height: canvas.height, fit: 'cover', position: 'centre' })
    .png()
    .toFile(fittedPath)
    .then(() => true)
    .catch(() => false);
  if (!written) {
    // A failed encode can still have created the destination, and passthrough carries `fittedPath: null`, so nothing would clean it and a truncated PNG would sit in the video gallery directory forever.
    await rm(fittedPath, { force: true }).catch(() => {});
    return passthrough;
  }
  console.log(`🖼️ Reactor starting frame fitted ${size.width}x${size.height} → ${canvas.width}x${canvas.height} (${aspect})`);
  return { aspect, canvas, framePath: fittedPath, fittedPath };
}
