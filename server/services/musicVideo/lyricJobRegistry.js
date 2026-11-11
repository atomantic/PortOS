// Shared reservations prevent a verification and alignment from running together.
export const activeLyricAlign = new Map();
export const activeLyricVerify = new Map();
export const getActiveLyricVerifyJobId = projectId => activeLyricVerify.get(projectId) || null;
export const getReservedLyricAlignJobId = projectId => activeLyricAlign.get(projectId) || null;
