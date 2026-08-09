/**
 * Seed the ten Digital Twin prompt stages that shipped a `stage-config.json`
 * entry but no template file (#3644).
 *
 * `promptService.buildPrompt()` resolves the config first and the template
 * second, so every one of these stages threw `Template for <stage> not found`
 * and each call site's `.catch(() => null)` degraded to its fallback path —
 * silently, forever. Now that the templates ship in `data.reference/`, existing
 * installs need them copied in: boot runs migrations (`server/index.js`) but NOT
 * `setup-data.js`, so an upgrade that pulls + `pm2 restart`s would otherwise
 * keep running the fallbacks.
 *
 * `twin-interview-analyze` had no stage-config entry either — the shared helper
 * merges it from `data.reference/prompts/stage-config.json` along with the rest.
 *
 * Customization-safe + idempotent per `_seedStageHelpers.js` — each template is
 * copied only when missing and each config entry merged only when absent.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'soul-contradiction-detector',
  'soul-enrichment',
  'soul-enrichment-process',
  'soul-test-generator',
  'soul-test-scorer',
  'soul-writing-analyzer',
  'twin-confidence-analyzer',
  'twin-import-analyzer',
  'twin-interview-analyze',
  'twin-trait-extractor',
]);
