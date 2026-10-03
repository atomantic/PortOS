// Evaluate before importing either managed process's application graph.
// A pending or damaged journal must not allow boot-time writers/schedulers,
// and a process whose pool still names the backend a completed cutover
// retired (a cached PM2 environment, a stale shell PGPORT) must not boot.
// A committed snapshot restore awaiting repair (#9725) fences boot the same
// way; server/start.js resumes that repair before reaching this fence.
import { assertDatabaseAdmission } from '../lib/databaseMaintenanceJournal.js';
import { assertDatabasePoolAuthority } from '../lib/databaseAuthority.js';
import { POOL_CONFIG, databaseRestoreRecovery } from '../lib/db.js';

assertDatabaseAdmission();
assertDatabasePoolAuthority(POOL_CONFIG);
databaseRestoreRecovery.assertAdmission();
