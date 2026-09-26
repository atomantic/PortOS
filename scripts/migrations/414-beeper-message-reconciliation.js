/**
 * Register machine-local Beeper message reconciliation state (#8682).
 * ensureSchema applies the additive message observation column and rotating
 * checkpoint table at boot; init-db.sql supplies the same fresh-install shape.
 * Existing messages start at the epoch observation watermark and are revisited
 * by the bounded rotation. No user records or default data files are seeded.
 */
export default {
  async up() {
    console.log('🫧 Beeper message reconciliation: local checkpoints added by ensureSchema at boot');
  },
};
