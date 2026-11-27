// Validates editorial checks and their pipeline settings.

import { z } from 'zod';
import { CHECK_SCOPES, CHECK_SEVERITIES } from './editorial/checkInfra/taxonomy.js';
import { READINESS_GATES } from './editorial/severityConfig.js';

// Per-check enable/config. `config` is a free-form blob validated a second time
// against the check's own Zod `configSchema` in the registry (resolveCheckConfig)
// — this gate just bounds the wire shape so a malformed PATCH can't write junk.
export const editorialCheckConfigSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  // Optional per-check severity override (#1596). Absent falls through to the
  // check's registry `severityDefault`; an explicit `null` CLEARS a previously
  // stored override (so the catalog "Default" option resets to the registry
  // value rather than pinning a level). Bounded to the registry's own severity
  // enum so the wire gate can't drift from resolveCheckState.
  severity: z.enum([...CHECK_SEVERITIES]).nullable().optional(),
}).strict();

// POST .../editorial/checks/run — run all enabled checks, or a named subset.
// providerId/model are optional overrides forwarded to LLM-kind checks.
export const editorialChecksRunSchema = z.object({
  checkIds: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).strict();

// User-defined editorial check (#1346). The base authored-field shapes carry NO
// `.default()` so the UPDATE schema (a `.partial()` of them) leaves an omitted
// field unchanged — a defaulted optional would silently RESET the stored value
// on a field-specific PATCH (Zod's `.partial()` keeps the inner `.default()`,
// which still fires when the key is absent). `scope`/`severityDefault` reuse the
// registry's own enums so the wire gate can't drift from `buildCustomCheck`.
const editorialCustomCheckShape = {
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  prompt: z.string().trim().min(1).max(8_000),
  scope: z.enum([...CHECK_SCOPES]),
  category: z.string().trim().max(60),
  severityDefault: z.enum([...CHECK_SEVERITIES]),
};

// Create: label + prompt required; the rest optional with sensible defaults (so
// a new check is fully-formed). The JSON output contract is enforced server-side
// (buildCustomCheckPrompt), so no schema field captures it.
export const editorialCustomCheckCreateSchema = z.object({
  ...editorialCustomCheckShape,
  description: editorialCustomCheckShape.description.optional().default(''),
  scope: editorialCustomCheckShape.scope.optional().default('issue'),
  category: editorialCustomCheckShape.category.optional().default('custom'),
  severityDefault: editorialCustomCheckShape.severityDefault.optional().default('medium'),
}).strict();

// Edit (the id is in the URL): every field optional, NO defaults, so an omitted
// field is left unchanged rather than reset.
export const editorialCustomCheckUpdateSchema = z.object(editorialCustomCheckShape).partial().strict();

// Dry-run preview (#1607): run an UNSAVED draft check against a series and return
// sample findings without persisting. Same authored fields as create (so the
// draft synthesizes into a runnable check), plus an optional per-run cap and the
// provider/model overrides the run route accepts.
export const editorialCustomCheckPreviewSchema = z.object({
  ...editorialCustomCheckShape,
  description: editorialCustomCheckShape.description.optional().default(''),
  scope: editorialCustomCheckShape.scope.optional().default('issue'),
  category: editorialCustomCheckShape.category.optional().default('custom'),
  severityDefault: editorialCustomCheckShape.severityDefault.optional().default('medium'),
  maxFindings: z.number().int().min(1).max(50).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).strict();

// settings.pipelineEditorialChecks slice (validated on PUT /api/settings when
// present). `checks` maps a checkId → its persisted enable/config; `customChecks`
// holds the user-defined check definitions (#1346).
//
// `customChecks` items are gated LENIENTLY (any object, unknown keys preserved):
// the authoring CRUD routes (editorialCustomCheck{Create,Update}Schema) are the
// strict input gate, while this wholesale-settings path must stay forward/older-
// peer compatible — a def carrying a future field (or a newer scope value) must
// not 400 an unrelated settings save. `buildCustomCheck`/`isValidCustomCheckDef`
// decide at read time which stored defs are actually runnable.
// `readinessGate` (#1316) is the editorial health convergence gate the autopilot
// loop + UI read as "manuscript clean": 'noOpenHigh' (default), the stricter
// 'noOpenHighOrMedium', or 'none' (disable). Optional + additive, so older peers
// and a never-configured install fall through to the service default.
// `maxArcVerifyRounds` / `maxEditorialRounds` bound the autopilot's verify→resolve
// convergence loops before it pauses for human review (0 = skip that gate
// entirely). Persisted defaults the autopilot reads when a run doesn't pass a
// per-run override; raised cap so a stubborn arc can be given more rounds. The
// cap is exported so the autopilot route schema (and any UI) share one ceiling
// instead of re-hardcoding it and drifting.
export const MAX_CONVERGENCE_ROUNDS = 20;
export const pipelineEditorialChecksSettingsSchema = z.object({
  checks: z.record(editorialCheckConfigSchema).optional(),
  customChecks: z.array(z.object({}).passthrough()).optional(),
  readinessGate: z.enum(READINESS_GATES).optional(),
  maxArcVerifyRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  maxEditorialRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Whole-manuscript beat-continuity convergence (#1510) — same bound + 0-skip
  // semantics. Optional + additive so older peers fall through to the default.
  maxBeatContinuityRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Foundation-quality gate (#2176, CWQE Phase 11). Before drafting, the
  // autopilot judges the whole foundation (world/characters/arc) against a
  // weighted rubric and iterates on the weakest dimension until it clears
  // `foundationThreshold` (a weighted [0,10] score), bounded by
  // `maxFoundationRounds` (0 = skip the gate). `foundationGate` toggles the gate
  // (defaults ON — the point of the phase). All three optional + additive so
  // older peers fall through to the defaults.
  foundationGate: z.boolean().optional(),
  foundationThreshold: z.number().min(0).max(10).optional(),
  maxFoundationRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Editorial-checks pause threshold (#1613). When the registry-driven editorial
  // checks pass surfaces ≥ N high-severity findings, the autopilot pauses the run
  // for human review instead of silently proceeding (the downstream health gate is
  // a backstop, but the per-step signal was misleading — a 50-high-finding pass
  // looked "complete"). 0 = off (default), so the behavior is opt-in and existing
  // installs are unchanged. Optional + additive so older peers fall through to off.
  // No upper bound mirrors the round caps — a large N just means "effectively off".
  checkFindingsPauseThreshold: z.number().int().min(0).optional(),
  // Pause-notification escalation (#1615). When an autopilot run pauses, post an
  // in-app notification (reason + resume link) so a paused run isn't missed until
  // the user opens the status page. Defaults ON (true) when unset — a zero-cost
  // informational signal — so this is the one autopilot setting that's opt-OUT.
  // Optional + additive so older peers fall through to the default.
  notifyOnPause: z.boolean().optional(),
  // Autopilot → CD teaser deliverable (CDO Phase 3, #2185). When on, once a comic
  // issue is text-ready + drafted the autopilot OPTIONALLY mints + starts a
  // Creative Director teaser/trailer video project seeded from it. Defaults OFF
  // (opt-in) — producing video is a fresh burst of LLM + render spend. Optional +
  // additive so older peers fall through to off.
  produceTeaser: z.boolean().optional(),
  // Iterate-to-quality revision loop (CWQE Phase 7, #2171). When on, the autopilot
  // cycles the weakest drafted issue through adversarial cuts + a judge-gated
  // keep/revert after the editorial-health gate, stopping on plateau /
  // hedged-convergence / maxCycles. Defaults OFF (opt-in) — a fresh burst of judge
  // + cut LLM spend. `revisionMaxCycles` is the cost ceiling; `revisionMinCycles`
  // floors the plateau/hedge stops; `revisionPlateauDelta` is the mean-score
  // movement below which the series counts as converged. All optional + additive.
  revisionEnabled: z.boolean().optional(),
  revisionMinCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionMaxCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionPlateauDelta: z.number().min(0).max(10).optional(),
  // NOTE: the autopilot's `unlockForRun` option is deliberately NOT stored here.
  // Every knob in this slice is a spend/quality default that is harmless to
  // reuse unattended; unlocking rewrites protection state the user set by hand,
  // and `seriesAutopilotScheduler` reads this slice — so a saved default would
  // arm lock-clearing for every scheduled run of every series. It is a per-run
  // option only (see seriesAutopilot/config.js#resolveAutopilotUnlockForRun).
  // Pipeline self-improvement. When on, a run that ends badly (or finishes with
  // unhealthy telemetry) spends ONE extra LLM call diagnosing whether the
  // AUTOMATION is at fault — a missing editorial step earlier in the pipeline, a
  // prompt producing unusable output, a runner swallowing a failure — and files
  // a CoS task against PortOS itself to fix it. Defaults OFF (opt-in): it is
  // fresh LLM spend AND it queues work that changes PortOS's own code.
  // The filed task always awaits human approval, runs in a worktree and opens a
  // PR — that is not configurable, matching every other autonomously generated
  // code-editing task in PortOS. Optional + additive so older peers fall
  // through to off.
  selfImprove: z.boolean().optional(),
  // Observing orchestrator — the continuous, self-dispatching sibling of
  // selfImprove. When on, an autopilot run watches its own telemetry step by
  // step and dispatches AUTO-APPROVED PortOS fix tasks (worktree + PR + review
  // loop + merge, no human gate) as pipeline defects surface, so unattended
  // runs continuously harden the pipeline itself. Defaults OFF (opt-in): it is
  // fresh LLM spend AND standing consent for unattended changes to PortOS's own
  // code — enabling it is that consent (see seriesAutopilot/observer.js for the
  // structural guards: execute-mode only, budget-gated, pass-capped, raised
  // confidence bar, full PR review loop). Persistable deliberately, unlike
  // unlockForRun: a scheduled unattended run is exactly where the user wants
  // the pipeline improving itself. Optional + additive so older peers fall
  // through to off.
  observer: z.boolean().optional(),
  // Evidence-based Series Autopilot routing. Metrics are collected regardless;
  // this opt-in permits sufficiently sampled recommendations to become the
  // run's soft provider/model/effort defaults. Explicit run/stage pins win.
  autoSelectModels: z.boolean().optional(),
  // Series Autopilot: run the whole pipeline on ONE provider/model/effort by
  // ignoring the per-stage pins set on the Prompts page. Defaults OFF (opt-in),
  // and persistable unlike unlockForRun — it re-routes spend but mutates
  // nothing, and an unattended scheduled run is exactly where "always use my
  // one provider" belongs. Optional + additive so older peers fall through to
  // off. See seriesAutopilot/config.js#resolveAutopilotOverrideStagePins and
  // lib/stagePinPolicy.js.
  overrideStagePins: z.boolean().optional(),
}).strict();
