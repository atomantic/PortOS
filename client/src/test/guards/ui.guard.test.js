// @vitest-environment node
/**
 * Structural guard runner (#16996) for client UI conventions: layout and
 * styling, effects and data fetching, module contracts and test timeouts.
 * Every check in `./ui/` runs here in one node-environment worker over one
 * shared corpus; the registry and the loading contract live in
 * `scripts/lib/guardScanners.js` (GUARD_CHECK_DIRS).
 */
import { describe, it } from 'vitest';
import { registerGuardChecks } from '../../../../scripts/lib/guardScanners.js';

const CHECKS = new URL('./ui/', import.meta.url);

registerGuardChecks(CHECKS, { describe, it, load: (name) => import(new URL(name, CHECKS).href) });
