import { request } from './apiCore.js';
export const getModelComparison = (options) => request('/providers/comparison', options);
