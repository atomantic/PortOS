/**
 * Structural guard runner (#16996) for conventions over runtime source: rejection
 * ownership, logging, spawning, timers, parameters, environment reads, data
 * directories and send authority.
 * Every check in `./runtime/` runs here in one worker over one shared corpus;
 * the registry and the loading contract live in `scripts/lib/guardScanners.js`
 * (GUARD_CHECK_DIRS).
 */
import { describe, it } from 'vitest';
import { registerGuardChecks } from '../../../scripts/lib/guardScanners.js';

const CHECKS = new URL('./runtime/', import.meta.url);

registerGuardChecks(CHECKS, { describe, it, load: (name) => import(new URL(name, CHECKS).href) });
