/** Explicit, local-only release step: no provider calls and no peer evidence. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../server/lib/paths.js';
import { buildQualitySnapshot } from '../server/services/appQualityFederation.js';

const { close } = await import('../server/lib/db.js');
await (async () => {
  const snapshot = await buildQualitySnapshot();
  if (!snapshot?.measurements.length) throw new Error('No local quality evidence to publish; existing snapshot preserved');
  await writeFile(join(PATHS.root, 'quality-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Published ${snapshot.measurements.length} numeric assessments to quality-snapshot.json`);
})().finally(close);
