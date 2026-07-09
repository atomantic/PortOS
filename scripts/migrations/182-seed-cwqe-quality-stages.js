/**
 * Seed the six Creative Writing Quality Engine judge/revision stages into
 * existing installs (v2.27.0 — CWQE calibrated-judge + Writers-Room revision work,
 * #2167 / #2169 / #2171 / #2176 / #2168 / #2173).
 *
 * Mirrors `165-reader-panel-persona-stages.js`: copies each `.md` template from
 * `data.reference/prompts/stages/` and merges the matching stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but NOT
 * `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than running
 * `update.sh`) would otherwise leave these stages unseeded and the first
 * invocation would throw "Stage <name> not found":
 *   - `pipeline-judge-issue`            — the calibrated per-issue quality judge (#2167)
 *   - `pipeline-judge-foundation`       — the pre-draft world/character/arc gate (#2176)
 *   - `pipeline-judge-compare`          — the multi-candidate / Elo head-to-head gate (#2169)
 *   - `pipeline-editorial-adversarial-cuts` — the "what a ruthless editor cuts" check (#2168)
 *   - `writers-room-cuts`               — Writers-Room autonomous polish: identify cuts (#2173)
 *   - `writers-room-revise`             — Writers-Room autonomous polish: apply the brief (#2173)
 *
 * Every other new stage in this release ships its own seed migration (cd-plan→175,
 * reader panel→165, world doctrine→167, premature-reveal→168, voice-discover→174,
 * concept-judge→180); these six were the gap. Customization-safe + idempotent: each
 * template is copied only when missing and each config entry merged only when absent.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'pipeline-judge-issue',
  'pipeline-judge-foundation',
  'pipeline-judge-compare',
  'pipeline-editorial-adversarial-cuts',
  'writers-room-cuts',
  'writers-room-revise',
]);
