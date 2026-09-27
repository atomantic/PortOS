import { copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The deterministic springs/beat-grid/SFX script compositions load with
// `<script src="portos-motion.js">`. Plain UTF-8 JavaScript, so it passes the
// launch-video asset gate like any other composition source.
export const MOTION_KIT_FILENAME = 'portos-motion.js';
export const MOTION_KIT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'kit', MOTION_KIT_FILENAME);

/** Copy the kit into a composition directory, keeping any copy already there. */
export async function installMotionKit(compositionDir) {
  await mkdir(compositionDir, { recursive: true });
  await copyFile(MOTION_KIT_SOURCE, join(compositionDir, MOTION_KIT_FILENAME), constants.COPYFILE_EXCL).catch(error => {
    // A revision's copied source may already carry the kit (possibly edited).
    if (error.code !== 'EEXIST') throw error;
  });
}
