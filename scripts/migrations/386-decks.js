/** Decks (playing-card / tarot design projects) are db-primary. Idempotent DDL
 * runs through ensureSchema at boot and ships in init-db.sql for fresh installs.
 * No user data is seeded. */
export default {
  async up() {
    console.log('🃏 Deck and deck-card tables are installed by ensureSchema at boot');
    return { success: true };
  },
};
