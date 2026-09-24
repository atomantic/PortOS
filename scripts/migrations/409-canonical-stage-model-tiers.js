/**
 * Rewrite legacy stage tier spellings to the one tier vocabulary (#8149).
 *
 * Prompt stages named the provider's light and medium models `quick` and
 * `coding`, while everything else (MODEL_TIERS, task metadata, orchestration
 * roles, dispatch labels) says `light` and `medium`. The Prompt Manager and the
 * Writers Room stage picker now write only the canonical names, so a stored
 * `quick`/`coding` would render as an unselected option. This rewrites the
 * stage `model` and `judgeModel` fields in `data/prompts/stage-config.json`.
 *
 * Safe for mixed-version peers: every stageRunner that ships a `light`/`medium`
 * alias (all of them since the tier map existed) resolves the new spelling, and
 * the current stageRunner still reads the legacy spelling. Idempotent, and a
 * missing file (fresh install before setup-data) is a no-op.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileCore.js';

const STAGE_CONFIG_PATH = join('data', 'prompts', 'stage-config.json');
const LEGACY_TIERS = Object.freeze({ quick: 'light', coding: 'medium' });
const TIER_FIELDS = Object.freeze(['model', 'judgeModel']);

export default {
  async up({ rootDir }) {
    const fullPath = join(rootDir, STAGE_CONFIG_PATH);
    const raw = await readFile(fullPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) return { stages: 0 };
    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${STAGE_CONFIG_PATH} is not valid JSON (${err.message}) — repair it and re-run migrations`);
    }
    const stages = config?.stages;
    if (!stages || typeof stages !== 'object' || Array.isArray(stages)) return { stages: 0 };

    let changed = 0;
    for (const stage of Object.values(stages)) {
      if (!stage || typeof stage !== 'object') continue;
      let touched = false;
      for (const field of TIER_FIELDS) {
        const canonical = LEGACY_TIERS[stage[field]];
        if (canonical) {
          stage[field] = canonical;
          touched = true;
        }
      }
      if (touched) changed += 1;
    }
    if (changed) await atomicWrite(fullPath, `${JSON.stringify(config, null, 2)}\n`);
    return { stages: changed };
  },
};
