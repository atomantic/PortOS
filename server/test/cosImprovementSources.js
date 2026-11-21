import { readFileSync } from 'node:fs';

// The architecture guards cover the complete generator, including deferred and
// programmatic paths that do not pass through the normal scheduler.
export const improvementSources = [
  'cosImprovementTasks', 'cosImprovementPolicy', 'cosPerpetualDrain',
  'cosPlanBinding', 'cosOnDemandRequests', 'cosManagedAppPreparation',
].map(name => readFileSync(new URL(`../services/cos/${name}.js`, import.meta.url), 'utf8')).join('\n');
