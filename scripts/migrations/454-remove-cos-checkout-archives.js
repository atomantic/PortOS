import { removeCosCheckoutArchives } from './442-remove-cos-checkout-archives.js';

/**
 * Remove legacy CoS checkout and branch retirement archive directories on
 * installs that already recorded the earlier no-op 442 migration as applied.
 */
export default {
  up: removeCosCheckoutArchives,
};
