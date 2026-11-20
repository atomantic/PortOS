/**
 * Structural guard runner (#16996) for repository text and test-suite hygiene:
 * docs, scripts, CI, migrations, instruction files and test conventions.
 * Every check in `./repo/` runs here in one worker over one shared corpus;
 * the registry and the loading contract live in `scripts/lib/guardScanners.js`
 * (GUARD_CHECK_DIRS).
 */
import { describe, it } from 'vitest';
import { registerGuardChecks } from '../../../scripts/lib/guardScanners.js';

registerGuardChecks(new URL('./repo/', import.meta.url), { describe, it });
