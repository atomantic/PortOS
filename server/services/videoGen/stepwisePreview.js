/** Watches a local render’s stepwise preview and releases its directory on teardown. */

import { watch as fsWatch } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { rmGuarded } from '../../lib/fileUtils.js';
import { videoGenEvents } from './events.js';
import { videoJobState } from './jobState.js';

export function watchStepwisePreview({ job, jobId, stepwiseDir }, retainOwnership) {
  // Runners publish one atomically-replaced `preview.png`. Keep the reader
  // serialized because fs.watch can report several events for one replacement;
  // a pending flag collapses those events to the newest available frame.
  let previewWatcher = null;
  let previewReading = false;
  let previewPending = false;
  let previewClosed = false;
  let previewCleanup;
  const cleanupStepwisePreview = () => {
    if (previewClosed) return previewCleanup;
    previewClosed = true;
    if (previewWatcher) {
      try { previewWatcher.close(); } catch { /* already closed */ }
      previewWatcher = null;
    }
    previewCleanup = Promise.resolve().then(() => rmGuarded(stepwiseDir, { recursive: true, force: true })).catch(error => {
      if (error.code !== 'ENOENT') retainOwnership();
    });
    return previewCleanup;
  };
  const processLatestPreview = async () => {
    if (previewClosed) return;
    if (previewReading) {
      previewPending = true;
      return;
    }
    previewReading = true;
    try {
      const framePath = join(stepwiseDir, 'preview.png');
      const currentImage = (await readFile(framePath)).toString('base64');
      if (videoJobState.jobs.get(jobId) === job && job.status === 'running') {
        job.currentImage = currentImage;
        videoGenEvents.emit('progress', { generationId: jobId, currentImage });
      }
    } catch (err) {
      // A replacement can race a read, and cancel/close removes the directory;
      // both are ordinary teardown races rather than render failures.
      if (!previewClosed && err.code !== 'ENOENT') console.log(`⚠️ Video preview read skipped [${jobId.slice(0, 8)}]: ${err.message}`);
    }
    previewReading = false;
    if (previewPending) {
      previewPending = false;
      void processLatestPreview();
    }
  };
  try {
    previewWatcher = fsWatch(stepwiseDir, (event) => {
      if (event === 'rename' || event === 'change') void processLatestPreview();
    });
    // Windows raises EPERM here when the watched dir is deleted (job teardown);
    // with no listener that is an uncaught exception and the server exits.
    previewWatcher.on?.('error', (err) => {
      console.warn(`⚠️ Video preview watcher error [${jobId.slice(0, 8)}]: ${err?.message}`);
    });
  } catch { /* preview is best-effort; the final video remains authoritative */ }
  return cleanupStepwisePreview;
}
