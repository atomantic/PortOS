/**
 * Register the machine-local Beeper account enumeration checkpoint (#8681).
 * The file migration runner precedes DB initialization. As in migration 336,
 * ensureSchema applies the additive, idempotent ALTER at boot; init-db.sql
 * includes the column for fresh installs. NULL starts the walk at the head.
 */
export default {
  async up() {
    console.log('🫧 Beeper account continuation: chat_cursor added by ensureSchema at boot');
  },
};
