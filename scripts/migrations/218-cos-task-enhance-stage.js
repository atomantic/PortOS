/**
 * Seed the `cos-task-enhance` prompt stage into existing installs (#3314).
 *
 * `server/services/taskEnhancer.js` has resolved its provider/model and prompt
 * through this stage since v0.10.29 ("configure via Prompt Manager instead of
 * hardcoded defaults"), and both the delete guard and the Prompt Manager's
 * SYSTEM badge have listed the key — but no `stage-config.json` entry ever
 * shipped, so the stage rendered no row and there was nothing to configure. The
 * service fell back to its hardcoded template and the active provider's default
 * model on every run.
 *
 * Shipping the reference template + config entry alone would only reach FRESH
 * installs: boot runs migrations (`server/index.js`) but NOT `setup-data.js`, so
 * an upgrade that pulls and `pm2 restart`s would keep silently using the
 * fallback. Customization-safe + idempotent per `_seedStageHelpers.js` — the
 * template is copied only when missing and the config entry merged only when
 * absent, so an install that hand-created the stage keeps its own version.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('cos-task-enhance');
