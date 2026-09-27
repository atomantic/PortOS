// Evaluate before importing either managed process's application graph.
// A pending or damaged journal must not allow boot-time writers/schedulers,
// and a process whose pool still names the backend a completed cutover
// retired (a cached PM2 environment, a stale shell PGPORT) must not boot.
import { assertDatabaseAdmission } from '../lib/databaseMaintenanceJournal.js';
import { assertDatabasePoolAuthority } from '../lib/databaseAuthority.js';
import { POOL_CONFIG } from '../lib/db.js';

assertDatabaseAdmission();
assertDatabasePoolAuthority(POOL_CONFIG);
