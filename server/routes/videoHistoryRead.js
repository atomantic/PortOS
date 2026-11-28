// One-record video-history read, shared by the video-gen router and the
// isolated collection-audit fixture so both exercise the same production
// handler without importing the generation stack.
import { historyRecordIdSchema, historyReadQuerySchema } from '../lib/videoHistoryReadValidation.js';
import { withMediaFileSize } from '../lib/mediaFileInfo.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';

// One history entry by id (#4165). A history id is NOT the filename stem — the
// timeline renderer mints `timeline-<project>-<ts>.mp4` beside an independent
// `randomUUID()` id — so a client holding only an id (a Creative Director
// `finalVideoId`, an EpisodeVideoStage final, a compact Media History card) has
// to ask the server for the record instead of pulling the whole history list.
export function createVideoHistoryItemRead(getHistoryItem = async (id) => (await import('../services/videoGen/history.js')).getHistoryItem(id)) {
  return asyncHandler(async (req, res) => {
    const parsed = historyRecordIdSchema.safeParse(req.params.id);
    if (!parsed.success) failValidation(parsed);
    const query = historyReadQuerySchema.safeParse(req.query);
    if (!query.success) failValidation(query);
    const entry = await withMediaFileSize('video', await getHistoryItem(parsed.data));
    if (!entry) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
    // Hosted clips may omit geometry. Opt-in playback callers measure the same source the render measures.
    if (query.data.geometry === 'true' && !(entry.numFrames && entry.fps && entry.width && entry.height)) {
      const { probeVideoGeometry, safeUnder } = await import('../lib/ffmpeg.js');
      const { PATHS } = await import('../lib/fileUtils.js');
      const path = safeUnder(PATHS.videos, entry.filename);
      const geometry = path ? await probeVideoGeometry(path) : null;
      if (!geometry) throw new ServerError('Video geometry unavailable', { status: 422, code: 'VIDEO_GEOMETRY_UNAVAILABLE' });
      res.json({ ...entry, ...geometry });
      return;
    }
    res.json(entry);
  });
}

export { historyRecordIdSchema } from "../lib/videoHistoryReadValidation.js";
