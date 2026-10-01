/** Empty db-primary Production stores are installed by boot DDL and init-db.sql. */
export default {
  async up() {
    console.log('🎞️ Code Animation Production project, revision and run tables are installed by ensureSchema at boot');
    return { success: true };
  },
};
