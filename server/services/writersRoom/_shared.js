// Tiny helpers shared by every Writers Room service module (local, evaluator,
// characters). All three need the same iso-stamp + ServerError shorthands;
// duplicating them turned into byte-for-byte drift risk.

import { ServerError } from '../../lib/errorHandler.js';

export const nowIso = () => new Date().toISOString();
export const badRequest = (message) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
export const notFound = (what) => new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });
