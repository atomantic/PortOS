/** Validate cutover direction and the forward-only chain of published stages. */
import { stages } from './schemas.js';

const normalizedHost = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase())
  ? 'loopback' : host.toLowerCase();

export const databaseMaintenanceError = () => Object.assign(
  new Error('Persistent database maintenance is active or requires recovery. Inspect scripts/database-maintenance.mjs status.'),
  { status: 503, code: 'DATABASE_MAINTENANCE' },
);

export function assertDistinctBackends(source, target) {
  if (source.mode === target.mode ||
      (normalizedHost(source.host) === normalizedHost(target.host) && source.port === target.port)) {
    throw new Error('Database maintenance requires distinct source and target backends.');
  }
}

export function assertForwardTransition(current, id, expectedStage, nextStage) {
  if (!current || current.id !== id || !stages.includes(expectedStage)
    || stages.indexOf(nextStage) !== stages.indexOf(expectedStage) + 1) throw databaseMaintenanceError();
}

export function assertPublishedStage(current, next, stage) {
  if (JSON.stringify(next) !== JSON.stringify({ ...current, stage })) throw databaseMaintenanceError();
}
