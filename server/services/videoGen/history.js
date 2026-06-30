/**
 * Video Gen — render history I/O.
 *
 * The render history (`data/video-history.json`) is the flat list the Media
 * History page grid-views. This module owns the read/write primitives; the
 * generation and post-processing code in local.js loads/saves through them.
 */

import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite } from '../../lib/fileUtils.js';

const HISTORY_FILE = join(PATHS.data, 'video-history.json');

export const loadHistory = () => readJSONFile(HISTORY_FILE, []);
export const saveHistory = (h) => atomicWrite(HISTORY_FILE, h);
