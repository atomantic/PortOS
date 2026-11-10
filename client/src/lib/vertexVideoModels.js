/**
 * Curated Google Cloud Vertex AI video model catalog (Veo).
 *
 * Re-export of `server/lib/vertexVideoModels.js`, the one definition of each
 * model's lengths, sizes and inputs, so the Video Gen picker offers exactly
 * what the server sends.
 */
export {
  VERTEX_DEFAULT_VIDEO_MODEL,
  VERTEX_VIDEO_MODELS,
  VERTEX_VIDEO_MODEL_IDS,
  getVertexVideoModel,
} from '../../../server/lib/vertexVideoModels.js';
