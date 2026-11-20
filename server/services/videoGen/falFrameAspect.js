/**
 * fal.ai clip frames at the project's aspect.
 *
 * Most fal image-to-video routes take no aspect parameter (the canvas follows
 * the start frame), so a Music Video clip names its project's aspect as
 * `frameAspect` and the start/end frames are cropped to it in memory just
 * before upload. The gallery image is untouched. A frame within the shared
 * tolerance uploads byte-for-byte; anything else is attention-cropped to the
 * largest rectangle of that ratio, never upscaled.
 */
import { fileToDataUri } from '../falQueue.js';
import { aspectCropSize } from '../imageGen/aspectConform.js';

const RATIO = /^(\d+):(\d+)$/;

/**
 * The frame at `filePath` as a data URI, cropped to `aspect` (`"16:9"`) when it
 * is off. Returns `{ dataUri, conformed }`; `conformed` is `{ from, to }`
 * (`"WxH"`) when it cropped, else null. No aspect, or a frame sharp cannot
 * read, uploads as is.
 */
export async function frameDataUriAtAspect(filePath, aspect) {
  const ratio = RATIO.exec(typeof aspect === 'string' ? aspect : '');
  const { default: sharp } = await import('sharp');
  const meta = ratio ? await sharp(filePath).metadata().catch(() => null) : null;
  const crop = meta && aspectCropSize(meta.width, meta.height, Number(ratio[1]), Number(ratio[2]));
  if (!crop) return { dataUri: await fileToDataUri(filePath), conformed: null };
  const buffer = await sharp(filePath)
    .resize(crop.width, crop.height, { fit: 'cover', position: sharp.strategy.attention })
    .png()
    .toBuffer();
  return {
    dataUri: `data:image/png;base64,${buffer.toString('base64')}`,
    conformed: { from: `${meta.width}x${meta.height}`, to: `${crop.width}x${crop.height}` },
  };
}
