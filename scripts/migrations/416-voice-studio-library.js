/** Voice Studio library profiles have no character binding until assigned.
 * ensureSchema applies the idempotent nullability change to existing installs.
 * Existing bound records and their unique approved-binding index are preserved.
 */
export default {
  async up() {
    console.log('🎙️ Voice Studio library schema is applied by ensureSchema at boot');
  },
};
