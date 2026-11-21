// @vitest-environment node
/**
 * Structural guard runner (#16996) for accessibility conventions over client markup:
 * control names, landmarks, hit areas, overlays, touch, drag and drop and headings.
 * Every check in `./a11y/` runs here in one node-environment worker over one
 * shared corpus; the registry and the loading contract live in
 * `scripts/lib/guardScanners.js` (GUARD_CHECK_DIRS).
 */
import { describe, it } from 'vitest';
import { registerGuardChecks } from '../../../../scripts/lib/guardScanners.js';

const CHECKS = new URL('./a11y/', import.meta.url);

registerGuardChecks(CHECKS, { describe, it, load: (name) => import(new URL(name, CHECKS).href) });
