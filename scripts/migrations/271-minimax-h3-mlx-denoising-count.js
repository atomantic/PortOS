/**
 * Move existing MiniMax H3 MLX rows from the old eight-point sigma grid
 * (seven transformer forwards) to the MLX reference's nine-point grid
 * (eight forwards).
 *
 * Only the shipped PipeNetwork row with the old shipped sampler contract is
 * eligible. A hand-tuned step count, guidance value, lock state, or note is
 * preserved rather than silently overwritten.
 */

import { readMediaRegistry, writeMediaRegistry } from './_lib.js';
import {
  MINIMAX_H3_OUTPUT_PROFILE,
  upgradeMiniMaxH3DenoisingCount,
} from '../../server/lib/mediaModels.js';

const REL_PATH = 'data/media-models.json';
const { id: H3_ID, shippedRepo: SHIPPED_REPO } = MINIMAX_H3_OUTPUT_PROFILE;

export default {
  async up({ rootDir }) {
    const { ok, config, entries: mlxEntries, path } = await readMediaRegistry({ rootDir });
    if (!ok) return;

    const entry = mlxEntries.find((model) => model?.id === H3_ID);
    if (!entry) {
      console.log(`✅ ${REL_PATH}: no '${H3_ID}' entry — user removed it, nothing to migrate`);
      return;
    }
    if (entry.repo !== SHIPPED_REPO) {
      console.log(`✅ ${REL_PATH}: '${H3_ID}' points at ${entry.repo} — user-repointed, leaving it alone`);
      return;
    }

    const [upgraded] = upgradeMiniMaxH3DenoisingCount([entry]);
    if (upgraded === entry) {
      console.log(`✅ ${REL_PATH}: MiniMax H3 sampler is current or customized`);
      return;
    }

    Object.assign(entry, upgraded);
    await writeMediaRegistry(path, config);
    console.log(`📝 ${REL_PATH}: updated MiniMax H3 MLX to 9 sigma points (8 DiT forwards)`);
  },
};
