/**
 * Read selectable inventory, the PortOS composite and merged shipped/researched model evidence.
 */

import { request } from './apiCore.js';
export const getModelComparison = (options) => request('/providers/comparison', options);
