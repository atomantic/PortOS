/** HAND-AUTHORED canonical→executable model aliases for one provider route (#6369), persisted separately from aliases observed by model discovery. */

import { isNonBlankStr } from '../textUtils.js';

/** A stored alias map with unusable entries dropped. Older records and hand-edited rows may contain invalid values. */
export const sanitizeModelAliases = (aliases) => Object.fromEntries(
  Object.entries(aliases && typeof aliases === 'object' ? aliases : {})
    .filter(([canonical, executable]) => isNonBlankStr(canonical) && isNonBlankStr(executable))
    .map(([canonical, executable]) => [canonical.trim(), executable.trim()]),
);
