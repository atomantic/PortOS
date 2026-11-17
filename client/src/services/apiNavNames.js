/**
 * Sidebar sub-nav name lists (`{ id, name }` rows) for Music Video and Pipeline series.
 *
 * They live apart from `apiMusicVideo.js` and `apiPipeline.js` so the always-mounted sidebar
 * does not pull those large page modules into every cold load (#16562). Both modules
 * re-export these, so page code and mocks of either module keep working.
 */

import { request } from './apiCore.js';

export const listMusicVideoProjectNames = (options = {}) => request('/music-video/names', options);
export const listPipelineSeriesNames = (options = {}) => request('/pipeline/series/names', options);
