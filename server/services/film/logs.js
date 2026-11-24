/**
 * One log file per Blender film job under renders/logs/ (the shared writer in
 * ../blenderWorkspace/jobLog.js). The newest 60 are kept.
 */
import { join } from 'node:path';
import { openBlenderJobLogFile } from '../blenderWorkspace/jobLog.js';
import { blenderRendersDir } from './workspace.js';

const KEPT = 60;

/**
 * Open the log of `jobId`. `file` is its path for the media route; `write`
 * appends one line; `close` resolves once the file is flushed.
 */
export async function openBlenderJobLog(owner, jobId) {
  const log = await openBlenderJobLogFile({
    directory: join(blenderRendersDir(owner), 'logs'), name: `${jobId}.log`, label: `Blender film job ${jobId}`, kept: KEPT,
  });
  return { file: `logs/${jobId}.log`, ...log };
}
