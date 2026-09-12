/** Recipe definitions are db-primary. Idempotent DDL runs through ensureSchema
 * at boot and ships in init-db.sql for fresh installs. No user data is seeded. */
export default {
  async up() {
    console.log('📚 Mind recipe definition and revision tables are installed by ensureSchema at boot');
    return { success: true };
  },
};
