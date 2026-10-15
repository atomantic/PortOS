// A boot-time consumer: failure to persist the ledger must reject the import.
import { loadMediaModels } from '../../lib/mediaModels.js';
export const registry = loadMediaModels();
