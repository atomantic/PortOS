import { request } from './apiCore.js';

// Which machines hold each media file: { self, items: { '<kind>:<filename>': { holders, primaryInstanceId } } }.
export const getMediaHolders = (options = {}) => request('/media/holders', options);

// Keep `instanceId`'s copy of the file and release every other holder's.
// Resolves { primaryInstanceId, released, pending, kept }.
export const makeMediaPrimary = ({ kind, filename, instanceId }, options = {}) => request('/media/holders/primary', {
  method: 'POST',
  body: JSON.stringify({ kind, filename, instanceId }),
  ...options,
});
