import {
  VIDEO_GEN_LOCAL_ONLY_FIELDS,
  REFERENCE_AUDIO_FIELDS,
  MAX_VIDEO_REFERENCE_IMAGES,
  MAX_VIDEO_REFERENCE_LABEL_LENGTH,
  VIDEO_REFERENCE_IMAGE_FIELDS,
  PREVIEW_UPLOAD_FIELDS,
} from '../../lib/videoGenRequestFields.js';

export {
  VIDEO_GEN_LOCAL_ONLY_FIELDS,
  REFERENCE_AUDIO_FIELDS,
  MAX_VIDEO_REFERENCE_IMAGES,
  MAX_VIDEO_REFERENCE_LABEL_LENGTH,
  VIDEO_REFERENCE_IMAGE_FIELDS,
  PREVIEW_UPLOAD_FIELDS,
};

/** The uploaded reference images in slot order, each with its trimmed label. */
export const videoReferenceImageSlots = (uploads = {}, body = {}) => VIDEO_REFERENCE_IMAGE_FIELDS
  .map((field, i) => ({ field, file: uploads[field], label: String(body[`referenceLabel${i + 1}`] ?? '').trim() }))
  .filter((slot) => slot.file);

export const VIDEO_GEN_LOCAL_ONLY_FIELD_NAMES = Object.freeze(
  Object.values(VIDEO_GEN_LOCAL_ONLY_FIELDS),
);
