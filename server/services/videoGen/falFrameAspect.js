/**
 * fal.ai clip frames at the project's aspect.
 *
 * Most fal image-to-video and audio-driven routes (OmniHuman, Hailuo-02, Kling)
 * take no aspect parameter: the output canvas follows the start frame. A square
 * still therefore became a 1080x1080 lip-sync clip that pillarboxes in a 16:9
 * music video. A Music Video clip names its project's aspect as `frameAspect`,
 * and the start and end frames are cropped to it here, in memory, just before
 * upload. The gallery image stays untouched, so the take still records the
 * frame the director picked. A frame within the shared tolerance uploads
 * byte-for-byte; anything else is attention-cropped (a close-up keeps its face)
 * to the largest rectangle of that ratio, never upscaled.
 */
import sharp from 'sharp';
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
