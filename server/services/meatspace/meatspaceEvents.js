import { EventEmitter } from 'node:events';

// Invalidation metadata only: personal health records never travel on this bus.
export const meatspaceEvents = new EventEmitter();
const COLLECTION_RESOURCES = {
  profile: ['overview', 'alcohol', 'calendar'],
  alcoholDrinks: ['alcohol'],
  bodyEntries: ['body'],
  bloodTests: ['blood'],
  epigeneticTests: ['epigenetic'],
  eyeExams: ['eyes'],
};
export function invalidateMeatspace(resources) {
  if (resources.length) meatspaceEvents.emit('changed', { resources: [...new Set(resources)] });
}
export function invalidateMortalLoomChanges(before, after) {
  const resources = Object.entries(COLLECTION_RESOURCES)
    .filter(([key]) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
    .flatMap(([, affected]) => affected);
  invalidateMeatspace(resources);
}
