/** Default endpoint and served model shared by managed mkserve and its provider presets. */

import { PORTS } from './ports.js';

export const MKSERVE_ORIGIN = `http://127.0.0.1:${PORTS.MKSERVE}`;
export const MKSERVE_MODEL = 'thinkingmachines/Inkling-2-Mini';
export const MKSERVE_CONTEXT = 32768;
