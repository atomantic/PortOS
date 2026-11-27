/**
 * How long a caller publishing output that already exists (a finished render) waits for an open
 * backup cut before giving up. A cut spans the file copy and the database dump.
 *
 * A leaf on purpose: about forty suites mock `backupSnapshotBoundary.js` with a factory that
 * returns only `withBackupAssetPublication`, so a constant exported from it would read as undefined.
 */
export const FINISHED_OUTPUT_ADMISSION_MS = 60 * 60 * 1000;

// Keep the render's queue watchdog alive while its finished bytes await admission.
export function finishedImageAdmission(events, generationId) {
  return {
    timeoutMs: FINISHED_OUTPUT_ADMISSION_MS,
    onWait: () => {
      events.emit('activity', { generationId });
      events.emit('status', { generationId, message: 'Waiting for the backup to finish before saving the image' });
    },
  };
}
