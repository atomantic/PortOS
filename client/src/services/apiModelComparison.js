/**
 * Read selectable inventory, and the PortOS composites built from shipped and researched model evidence.
 */

import { request } from './apiCore.js';
export const getModelComparison = (options) => request('/providers/comparison?view=summary', options);
