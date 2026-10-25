/**
 * Retain this migration ID without deleting historical recovery evidence.
 * Stopping new archives does not prove old copies are disposable: they can hold
 * unpublished bytes, quarantined originals or an interrupted transaction.
 */
export default {
  async up() {
    return { historicalRecoveryPreserved: true };
  },
};
