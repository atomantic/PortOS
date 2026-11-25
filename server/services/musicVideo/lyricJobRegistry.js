import { trackedRenderMap } from '../renderActivity.js';

const link = projectId => `/music-video/${encodeURIComponent(projectId)}`;
// Shared reservations prevent a verification and alignment from running together.
export const activeLyricAlign = trackedRenderMap('lyric-align', { noun: 'lyric alignment', link });
export const activeLyricVerify = trackedRenderMap('lyric-verify', { noun: 'lyric check', link });
export const getActiveLyricVerifyJobId = projectId => activeLyricVerify.get(projectId) || null;
export const getReservedLyricAlignJobId = projectId => activeLyricAlign.get(projectId) || null;
