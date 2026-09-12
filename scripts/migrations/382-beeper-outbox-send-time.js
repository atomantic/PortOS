/**
 * Register the immutable Beeper send-attempt timestamp (#7178).
 * ensureSchema applies the additive nullable column at boot, when the pool is
 * ready. Old rows keep NULL: their original attempt time cannot be recreated
 * after later recovery writes, so lookup retains its conservative legacy floor.
 */
export default {
  async up() {
    console.log('🫧 Beeper send-attempt timestamp is added idempotently by ensureSchema at boot');
  },
};
