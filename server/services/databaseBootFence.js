// Evaluate before importing either managed process's application graph.
// A pending or damaged journal must not allow boot-time writers/schedulers.
import { assertDatabaseAdmission } from '../lib/databaseMaintenanceJournal.js';

assertDatabaseAdmission();
