/**
 * PortOS-owned custom job for auditing the bundled CLI-provider catalogs.
 *
 * The job deliberately lives in the PortOS app's custom-task collection rather
 * than the global task-type registry. Its prompt is the ownership boundary for
 * the shipped fallback catalogs; live provider refresh remains authoritative for
 * the provider record that a user has already configured.
 */

import { PORTOS_APP_ID } from '../../lib/appIdentity.js'
import { DAY } from './constants.js'

export const PORTOS_CLI_CATALOG_REFRESH_JOB_ID = 'job-refresh-cli-provider-catalogs'
export const PORTOS_CLI_CATALOG_REFRESH_TASK_TYPE = 'refresh-cli-provider-catalogs'

const PORTOS_CLI_CATALOG_REFRESH_PROMPT = `[Autonomous Job] Refresh CLI Provider Catalogs

Audit only the static CLI-provider fallback catalogs that PortOS ships. This is a
PortOS maintenance task, not a managed-app task and not a live provider-refresh
operation.

The authoritative static surface is server/lib/aiToolkit/providers.js. Start by
reading its CODEX_MODELS, ANTIGRAVITY_MODELS, and
PRIOR_ANTIGRAVITY_MODEL_CATALOGS constants, then read the related provider,
migration, seed-parity, pin-validation, and model-picker tests. Do not assume
that a list returned by a single signed-in account is the universal fallback.

Research current model IDs from authoritative provider documentation, release
notes, or the provider CLI's model-list command when that command is supported
(for example, agy models). Treat an installed account-specific list as evidence
to compare against, not as sufficient proof for the shipped catalog. Do not make
provider calls during PortOS startup and do not duplicate or bypass the live
refresh path in server/services/providers.js.

If a shipped fallback is stale, update only the PortOS static catalog and both
fresh-install seed snapshots (server/lib/aiToolkit/defaults/providers.sample.json
and data.reference/providers.json), keeping those seeds synchronized. Update the
compatibility recognition that protects independently upgraded installs. When a
shipped default changes, preserve the old seeded Antigravity list in
PRIOR_ANTIGRAVITY_MODEL_CATALOGS. Codex has no prior-catalog recognition today —
changing CODEX_MODELS requires adding a PRIOR_CODEX_MODEL_CATALOGS list and an
isPriorSeededList branch in migrateCodexProvider, mirroring
migrateAntigravityModelCatalog. Preserve configured-default
sentinels, user-selected provider records, live-refreshed model lists, and every
user-selected default/light/medium/heavy pin. Never rewrite data/providers.json or
replace a customized provider list merely because it differs from the shipped
fallback.

Validate that every shipped model ID is unique, every real default/light/medium/heavy
pin resolves to an ID in its provider catalog, configured-default sentinels remain
valid, and the server and client provider model pickers still render valid choices.
Add or update focused tests covering fresh seeding, untouched-default upgrades,
customized-list preservation, pin validity, and picker behavior. Run the relevant
server and client tests.

If the shipped catalogs are already current, leave the worktree clean and report
that no change is needed. Do NOT create a commit, push a branch, or open a PR for
that no-op. If a real change is needed, run the configured simplify pass, commit
the focused change, and open a PR with a concise summary and test plan. Do not
create or edit a changelog file or fragment.`

export const PORTOS_CLI_CATALOG_REFRESH_JOB = Object.freeze({
  id: PORTOS_CLI_CATALOG_REFRESH_JOB_ID,
  name: 'Refresh CLI Provider Catalogs',
  description: 'Audit and refresh the static Codex and Antigravity model fallbacks that PortOS ships.',
  category: 'portos-maintenance',
  appId: PORTOS_APP_ID,
  interval: 'monthly',
  intervalMs: 30 * DAY,
  enabled: false,
  priority: 'MEDIUM',
  autonomyLevel: 'manager',
  type: 'agent',
  promptTemplate: PORTOS_CLI_CATALOG_REFRESH_PROMPT,
  // A verified empty branch is a valid result for this audit. The finalizer
  // consumes this marker only alongside verifyPrClaim's noChangesToShip proof;
  // it is not a general commit-criterion exemption.
  taskMetadata: { useWorktree: true, openPR: true, simplify: true, noChangeSuccess: true },
  providerId: null,
  model: null,
  effort: null,
  lastRun: null,
  runCount: 0,
  createdAt: null,
  updatedAt: null
})
