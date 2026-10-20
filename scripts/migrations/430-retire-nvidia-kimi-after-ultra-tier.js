/**
 * Re-run the NVIDIA Kimi retirement for installs whose ledger already records
 * migration 402.
 *
 * Migration 357 stamps `ultraModel: null` on every provider, and it runs before
 * 402 on every install that still carried the shipped preset. 402 compared the
 * record exactly, read that stamp as a user edit, and kept the retired preset
 * on every upgraded install while recording itself as applied. 402 now treats
 * the stamp as the default it is; this pass applies the corrected check where
 * 402 can no longer run. A customized, enabled, keyed or referenced record is
 * still kept, and an install without the preset is untouched.
 */
import retireNvidiaKimi from './402-retire-nvidia-kimi-provider.js';

export default {
  up: (context) => retireNvidiaKimi.up(context),
};
