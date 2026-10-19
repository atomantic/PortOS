// One-record video-history read, shared by the video-gen router and the
// isolated collection-audit fixture so both exercise the same production
// handler without importing the generation stack.
import { withMediaFileSize } from '../lib/mediaFileInfo.js';
import { z } from 'zod';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';

// The ONE contract every `/history/:id*` route resolves its record id through
// (#5713) — GET, DELETE, visibility and prompt all name the same stored row, so
// they share one schema instead of three (loose / strict / none).
//
// It stays looser than a UUID check on purpose: that suits ids this install
// MINTS, but entries also arrive from a caller-supplied download id and from
// federated peers, so a `.guid()` gate here would 400 rows that are
// legitimately in the list. The charset bound is the floor — every legitimate
// id is `[A-Za-z0-9._-]+`, and a value carrying a path segment or a `..` can no
// longer parse, so `safeUnder()` in historyOps is defense in depth rather than
// the only thing standing between a hostile id and an unlink loop.
export const historyRecordIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9._-]+$/, 'invalid history id');
const historyReadQuerySchema = z.object({ geometry: z.enum(['true', 'false']).optional() });

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
