/**
 * Structural guard runner (#16996) for module structure and contracts: import
 * boundaries and cycles, single-owner tables, inventories and mock factories.
 * Every check in `./modules/` runs here in one worker over one shared corpus;
 * the registry and the loading contract live in `scripts/lib/guardScanners.js`
 * (GUARD_CHECK_DIRS).
 */
import { describe, it } from 'vitest';
import { registerGuardChecks } from '../../../scripts/lib/guardScanners.js';

registerGuardChecks(new URL('./modules/', import.meta.url), { describe, it });
