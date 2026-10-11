/**
 * Brain bridge identity is db-primary. Boot DDL installs the additive table;
 * first bridge use imports valid legacy map links before any memory writes.
 * No seed: links derive from each install's existing map and memory rows.
 */
export default {
  async up() {
    console.log('🧠 Brain memory links are installed by ensureSchema and backfilled on first bridge use');
    return { success: true };
  }
};
