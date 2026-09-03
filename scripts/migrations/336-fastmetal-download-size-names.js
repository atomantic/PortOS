/**
 * Correct the FastMetal rows' download size where the user actually reads it.
 *
 * All three shipped names quoted the MLX DiT alone (~3.5 / ~10 / ~25 GB) while
 * the entries pull a whole-repo snapshot that also carries a bundled T5 text
 * encoder and VAE — 13.4 / 19.5 / 42.3 GB. #5860 fixed the disclosure panel's
 * `estimatedDownloadGb` but shipped no migration, and left the NAME — the
 * number shown in the picker before that panel is ever opened — untouched.
 *
 * This also narrows the 14B row with `repoFiles`, dropping the `ema/` copy of
 * its DiT (14.14 GB the entry script never loads), which is why its corrected
 * figure is 27.1 GB rather than the full 42.3 GB snapshot.
 *
 * Conservative customization rules (see `upgradeFastMetalDownloadSizes`):
 * - only a row still pointing at the shipped repo is eligible;
 * - the name changes only when it is byte-for-byte the prior shipped string;
 * - `repoFiles` is added only when the row declares none;
 * - a persisted `estimatedDownloadGb` changes only when it equals a value
 *   PortOS itself shipped.
 *
 * Fresh installs receive all of this from data.reference/media-models.json.
 */

import { readMediaRegistry, writeMediaRegistry } from './_lib.js';
import {
  FASTMETAL_DOWNLOAD_SIZE_PROFILES,
  upgradeFastMetalDownloadSizes,
} from '../../server/lib/mediaModels.js';

const REL_PATH = 'data/media-models.json';

export default {
  async up({ rootDir }) {
    const { ok, config, entries, path } = await readMediaRegistry({ rootDir });
    if (!ok) return;

    const changedIds = [];
    for (const profile of FASTMETAL_DOWNLOAD_SIZE_PROFILES) {
      const entry = entries.find((model) => model?.id === profile.id);
      if (!entry) continue;
      const [upgraded] = upgradeFastMetalDownloadSizes([entry]);
      if (upgraded === entry) continue;
      Object.assign(entry, upgraded);
      changedIds.push(profile.id);
    }

    if (changedIds.length === 0) {
      console.log(`✅ ${REL_PATH}: FastMetal download sizes already current or customized`);
      return;
    }
    await writeMediaRegistry(path, config);
    console.log(`📝 ${REL_PATH}: corrected FastMetal download sizes on ${changedIds.length} row(s) — ${changedIds.join(', ')}`);
  },
};
