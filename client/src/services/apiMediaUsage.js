/**
 * `getMediaUsages` (where each media file is used: music video shots, storyboards,
 * Casting/Environments/Objects, universes, mood boards, …).
 */

import { request } from './apiCore.js';

// Where each media file is used: { items: { '<kind>:<ref>': [{ source, label, id, title, role, href }] } }.
export const getMediaUsages = (options = {}) => request('/media/usages', options);
