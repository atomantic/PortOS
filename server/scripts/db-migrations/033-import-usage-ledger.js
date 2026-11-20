import { join } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { importLegacyUsageLedger } from '../../services/usageLedgerDb.js';

export async function up(client) {
  await importLegacyUsageLedger(client, join(PATHS.data, 'usage.json'));
}
