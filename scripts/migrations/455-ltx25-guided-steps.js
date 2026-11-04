/** Update the old shipped LTX-2.5 guided sampler and retire its stale speed estimate. */
import { readMediaRegistry, writeMediaRegistry } from './_lib.js';
import { invalidateMediaModelsForPath } from '../../server/lib/mediaModels.js';

const ID = 'ltx25_mlx_q8';
const REPO = 'MrMofer/ltx-2.5-mlx-q8';
const REVISION = 'f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc';
const OLD_SPEEDUP = '~35-45% faster';
const OLD_FAST_DESCRIPTION = 'Validated 8+3-step two-stage schedule at CFG 1.0 with stage-1 TeaCache. Softer detail and weaker prompt adherence than Quality.';
const FAST_DESCRIPTION = '8+3-step two-stage schedule at CFG 1.0 with experimental TeaCache. Detail and prompt adherence may be reduced; TeaCache is not calibrated for LTX-2.5.';

export default {
  async up({ rootDir }) {
    const { ok, config, entries, path } = await readMediaRegistry({ rootDir });
    if (!ok) return;

    let changed = false;
    for (const entry of entries) {
      if (entry?.id !== ID || entry.repo !== REPO || entry.revision !== REVISION
        || entry.runtime !== 'ltx25' || entry.source === 'user') continue;

      // An old default and an intentional identical value cannot be told apart.
      // Other sampler settings, forks, and user-added models remain untouched.
      if (entry.steps === 8 && entry.guidance === 3 && entry.samplerLocked !== true) {
        entry.steps = 30;
        changed = true;
      }
      if (!Array.isArray(entry.speedProfiles)) continue;
      for (const profile of entry.speedProfiles) {
        if (profile?.id === 'fast' && profile.speedupLabel === OLD_SPEEDUP) {
          delete profile.speedupLabel;
          changed = true;
        }
        if (profile?.id === 'fast' && profile.description === OLD_FAST_DESCRIPTION) {
          profile.description = FAST_DESCRIPTION;
          changed = true;
        }
      }
    }
    if (!changed) return;
    await writeMediaRegistry(path, config);
    invalidateMediaModelsForPath(path);
    console.log('📝 data/media-models.json: updated the LTX-2.5 guided sampler default');
  },
};
