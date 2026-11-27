/**
 * fal.ai clip frames at the project's aspect.
 *
 * Most fal image-to-video routes take no aspect parameter (the canvas follows
 * the start frame), so a Music Video clip names its project's aspect as
 * `frameAspect` and the start/end frames are cropped to it in memory just
 * before upload. The gallery image is untouched. A frame within the shared
 * tolerance is sanitized without cropping. Other frames are attention-cropped
 * to the largest rectangle of that ratio, never upscaled.
 */
import { fileToDataUri } from '../falQueue.js';
import { aspectCropSize } from '../imageGen/aspectConform.js';

const RATIO = /^(\d+):(\d+)$/;

/**
 * The frame at `filePath` as a data URI, cropped to `aspect` (`"16:9"`) when it
 * is off. Returns `{ dataUri, conformed }`; `conformed` is `{ from, to }`
 * (`"WxH"`) when it cropped, else null. Without a measurable or requested
 * aspect, the standard data-URI encoder handles the upload.
 */
export async function frameDataUriAtAspect(filePath, aspect) {
  const ratio = RATIO.exec(typeof aspect === 'string' ? aspect : '');
  if (!ratio) return { dataUri: await fileToDataUri(filePath), conformed: null };
  const { default: sharp } = await import('sharp');
  const image = sharp(filePath);
  const meta = await image.metadata().catch(() => null);
  const { width, height } = meta?.autoOrient ?? {};
  const crop = aspectCropSize(width, height, Number(ratio[1]), Number(ratio[2]));
  if (!crop) return { dataUri: await fileToDataUri(filePath), conformed: null };
  const buffer = await image.autoOrient()
    .resize(crop.width, crop.height, { fit: 'cover', position: sharp.strategy.attention })
    .png()
    .toBuffer();
  return {
    dataUri: `data:image/png;base64,${buffer.toString('base64')}`,
    conformed: { from: `${width}x${height}`, to: `${crop.width}x${crop.height}` },
  };
}
