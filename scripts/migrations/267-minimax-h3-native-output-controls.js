/**
 * Bring existing MiniMax H3 registry rows onto the model's published output
 * contract. Fresh installs receive these values from data.reference.
 *
 * Conservative customization rules:
 * - only the shipped PipeNetwork row is eligible;
 * - frameOptions changes only when it is byte-for-byte the prior shipped list;
 * - the native default-size pair is added only when both fields are absent;
 * - resolutionStep + resolutionOptions are one geometry contract and are added
 *   only when both are absent, so a partial custom contract stays user-owned.
 */

import { readMediaRegistry, writeMediaRegistry } from './_lib.js';
import {
  MINIMAX_H3_OUTPUT_PROFILE,
  upgradeMiniMaxH3OutputControls,
} from '../../server/lib/mediaModels.js';

const REL_PATH = 'data/media-models.json';
const { id: H3_ID, shippedRepo: SHIPPED_REPO } = MINIMAX_H3_OUTPUT_PROFILE;

export default {
  async up({ rootDir }) {
    const { ok, config, entries: macos, path } = await readMediaRegistry({ rootDir });
    if (!ok) return;

    const entry = macos.find((model) => model?.id === H3_ID);
    if (!entry) {
      console.log(`✅ ${REL_PATH}: no '${H3_ID}' entry — user removed it, nothing to migrate`);
      return;
    }
    if (entry.repo !== SHIPPED_REPO) {
      console.log(`✅ ${REL_PATH}: '${H3_ID}' points at ${entry.repo} — user-repointed, leaving it alone`);
      return;
    }

    const [upgraded] = upgradeMiniMaxH3OutputControls([entry]);
    const changed = upgraded !== entry;

    if (changed) {
      Object.assign(entry, upgraded);
      await writeMediaRegistry(path, config);
      console.log(`📝 ${REL_PATH}: added MiniMax H3's 4-second option and native 768p canvases`);
    } else {
      console.log(`✅ ${REL_PATH}: MiniMax H3 output controls already current or customized`);
    }
  },
};
