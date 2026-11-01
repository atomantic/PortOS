/**
 * Video render speed profiles (issue #4875).
 *
 * A *speed profile* is a named, pre-validated sampler configuration a user can
 * pick instead of hand-tuning steps and CFG: it swaps the whole schedule at
 * once (stage-1 / stage-2 step counts, guidance, and runtime acceleration
 * levers like TeaCache). Measured claims are separate from experimental profiles.
 * The separately typed H3 LightX2V contract is model/runtime/adapter-bound,
 * overrides the stock lock only as a complete schedule, and refuses mismatches
 * before admission. It has no measured PortOS speed claim (issue #13612).
 *
 * The relationship between a model and its profiles is DECLARED here — not
 * inferred from a runtime name — and attached to registry entries as
 * `speedProfiles` by `applyVideoSpeedProfiles`, the same load-time backfill
 * pattern `applyVideoDisclosures` (lib/videoDisclosure.js) and
 * `applyVideoFinishProfiles` (lib/videoFinishProfiles.js) use. Migration 295
 * makes it durable on disk for installs that already persisted
 * `data/media-models.json`.
 *
 * ## Why the DEFAULT profile is a first-class entry rather than "absence"
 *
 * `SPEED_PROFILE_DEFAULT_ID` ('quality') is the shipped contract: the exact
 * sampler the model has always rendered with. It exists as a named option so
 * the picker has something to show as selected, but it is deliberately a
 * NO-OP — `resolveVideoSpeedProfile` returns `null` for it, so a quality render
 * builds byte-identical spawn args to a render from before this feature
 * existed, and stamps no extra history fields. Absence and `'quality'` are the
 * same request (`isDefaultSpeedProfile`), exactly as `'stock'` and absence are
 * the same request in lib/videoTextEncoders.js.
 *
 * ## Why compatibility is checked rather than assumed
 *
 * A profile's numbers are validated against ONE pipeline on ONE set of weights.
 * Applying them anywhere else would be a speed claim we cannot back:
 *
 *   - **Weights.** `shippedRepo` + `shippedRevision` must both still match the
 *     entry. A user who re-pointed `repo` at a fork, or moved `revision` off
 *     the pin the schedule was measured against, keeps no profile rather than
 *     inheriting a claim about weights we can no longer vouch for. (The
 *     finish-profile precedent guards `repo` only; a sampler schedule is
 *     revision-sensitive in a way a draft→delivery edge is not, so this guards
 *     both.)
 *   - **Mode.** Only the modes in `profile.modes` route through the pipeline
 *     the schedule was measured on. `fflf`/`extend`/`a2v`/`ic` run entirely
 *     different pipelines (KeyframeInterpolation, Extend, A2Vid, IC-LoRA), so
 *     a profile is DECLINED for them with an explicit reason instead of
 *     silently applying numbers that mean nothing there.
 *   - **Sampler lock.** A `samplerLocked` entry pins its own validated
 *     schedule; a speed profile would be a second authority over the same
 *     dials, so legacy LTX profiles and locks are mutually exclusive. Only the
 *     complete pinned H3 contract may replace a locked stock schedule.
 *
 * Everything the RUNNER cannot promise ahead of time — is the pinned
 * `ltx_pipelines_mlx` new enough to accept `enable_teacache`? is the distilled
 * adapter actually in the model pack? — is probed by the Python helper at
 * render time, which emits a `SPEEDPROFILE:` line naming what it actually
 * applied. That is what keeps an unavailable lever from becoming a misleading
 * speed claim: the profile still renders (at its step schedule), the missing
 * lever is reported as `degraded`, and the history record says so.
 *
 * Pure module: no I/O or imports out to services.
 */

import { LTX2_FAMILY_RUNTIMES } from './runners.js';
import {
  MINIMAX_H3_LIGHTX2V_PROFILE, MINIMAX_H3_LIGHTX2V_MLX_PROFILE, MINIMAX_H3_FLEX_MLX_PROFILE, isMiniMaxH3SpeedProfile, isMiniMaxH3SpeedProfileRequest,
  isPinnedMiniMaxH3SpeedProfile, miniMaxH3SpeedProfileDeclineReason,
} from './minimaxH3SpeedProfiles.js';

/**
 * The implicit "unchanged" profile. Never resolves to an override.
 */
export const SPEED_PROFILE_DEFAULT_ID = 'quality';

/**
 * Modes that route through the LTX two-stage pipeline (`run_two_stage` in
 * scripts/generate_ltx2.py), which is the only pipeline the shipped schedules
 * below were measured on. Declared once so a new profile can't quietly widen
 * itself past what was validated.
 */
export const TWO_STAGE_SPEED_PROFILE_MODES = Object.freeze(['text', 'image']);

/**
 * Shipped profiles, keyed by registry entry id.
 *
 * `shippedRepo` / `shippedRevision` are the pin guards described above.
 * `profiles` is the list attached to the entry, in picker order. Each profile:
 *
 *   id              stable key — persisted in history and submitted by the UI
 *   name            picker label
 *   description     one line under the picker; states the trade honestly
 *   speedupLabel    the measured claim, or null when there is nothing to claim
 *   steps           stage-1 step count (overrides the entry's `steps`)
 *   stage2Steps     explicit stage-2 step count (null → pipeline default)
 *   guidance        CFG scale (1.0 drops the negative branch entirely, which is
 *                   where most of the saving comes from on a two-stage render)
 *   teacache        request stage-1 TeaCache from the runner
 *   teacacheThresh  rel_l1_thresh override, or null for the pin's calibrated
 *                   default (0.5 at the current LTX-2 pin)
 *   requiresAdapter distilled-adapter filename the schedule was measured with,
 *                   or null when the profile doesn't depend on one
 *   modes           modes the profile may resolve for
 */
export const VIDEO_SPEED_PROFILES = Object.freeze({
  minimax_h3_8bit: Object.freeze({
    shippedRepo: MINIMAX_H3_LIGHTX2V_MLX_PROFILE.model.repo,
    shippedRevision: MINIMAX_H3_LIGHTX2V_MLX_PROFILE.model.revision,
    profiles: Object.freeze([MINIMAX_H3_LIGHTX2V_MLX_PROFILE, MINIMAX_H3_FLEX_MLX_PROFILE]),
  }),
  minimax_h3_cuda: Object.freeze({
    shippedRepo: MINIMAX_H3_LIGHTX2V_PROFILE.model.repo,
    shippedRevision: MINIMAX_H3_LIGHTX2V_PROFILE.model.revision,
    profiles: Object.freeze([MINIMAX_H3_LIGHTX2V_PROFILE]),
  }),
  // LTX-2.5 Q8. The step schedule here is NOT invented: it is the same
  // 8 stage-1 / 3 stage-2 / CFG 1.0 configuration the env-gated
  // PORTOS_T2V_TWO_STAGE experiment measured at ~30-35% off wall time
  // (resolveT2vTwoStageOverride, server/services/videoGen/local.js), promoted
  // from a hidden env knob to a user-facing, capability-gated choice.
  //
  // The 2.5 pack adds the lever 2.3 did not have: its own distilled adapter
  // (ltx-2.5-22b-distilled-lora-450) plus a pinned runtime whose two-stage
  // `generate_and_save` accepts `enable_teacache`. TeaCache caches stage-1
  // residuals between steps against upstream's calibrated coefficients; PortOS
  // has always left it off on this path because it never passed the kwarg.
  ltx25_mlx_q8: Object.freeze({
    shippedRepo: 'MrMofer/ltx-2.5-mlx-q8',
    shippedRevision: 'f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc',
    profiles: Object.freeze([
      Object.freeze({
        id: 'fast',
        name: 'Fast',
        description: 'Validated 8+3-step two-stage schedule at CFG 1.0 with stage-1 TeaCache. Softer detail and weaker prompt adherence than Quality.',
        // Deliberately conservative, and traceable to the two numbers this repo
        // can actually cite: the step schedule measured ~30-35% off wall time
        // (resolveT2vTwoStageOverride, i.e. ~1.4-1.5x), and the pin's own
        // --teacache-thresh help documents ~1.2x at the calibrated default —
        // ~1.7-1.85x combined, so ~35-45% off. NOT "2x": that would overstate
        // the evidence, and on a pin without the TeaCache kwarg the cache half
        // degrades away entirely (leaving only the ~30-35%). For a feature
        // whose whole contract is an honest speed claim, the label is the last
        // place to round up. Raise this only against an A/B measured on 2.5.
        speedupLabel: '~35-45% faster',
        steps: 8,
        stage2Steps: 3,
        guidance: 1.0,
        teacache: true,
        teacacheThresh: null,
        requiresAdapter: 'ltx-2.5-22b-distilled-lora-450.safetensors',
        modes: TWO_STAGE_SPEED_PROFILE_MODES,
      }),
    ]),
  }),
});

const isEntry = (entry) => !!entry && typeof entry === 'object' && typeof entry.id === 'string';

/**
 * Attach `speedProfiles` to shipped entries that don't already carry the key.
 * Pure; returns a new array and never mutates the input entries.
 *
 * Preservation contract (mirrors migration 295, and the two sibling
 * decorators):
 *   - `'speedProfiles' in entry` → user/existing value wins (including `null`
 *     or `[]`, the explicit "no speed profiles on this model" override)
 *   - entry id not shipped → custom model, left as-is
 *   - `repo` or `revision` differs from the pin → left as-is (see the pin
 *     guard rationale in the module docblock)
 */
export const applyVideoSpeedProfiles = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isEntry(entry)) return entry;
    if ('speedProfiles' in entry) return entry;
    const spec = VIDEO_SPEED_PROFILES[entry.id];
    if (!spec) return entry;
    if (spec.shippedRepo !== null && entry.repo !== spec.shippedRepo) return entry;
    if (spec.shippedRevision !== null && entry.revision !== spec.shippedRevision) return entry;
    if (spec.profiles.some((profile) => isMiniMaxH3SpeedProfile(profile)
      && !isPinnedMiniMaxH3SpeedProfile(entry, profile))) return entry;
    return { ...entry, speedProfiles: spec.profiles.map((p) => ({ ...p })) };
  });
};

/**
 * Absence and the default id are the same request — so a client that always
 * submits its picker value doesn't create a second spelling of "unchanged".
 */
export const isDefaultSpeedProfile = (id) => id == null || id === '' || id === SPEED_PROFILE_DEFAULT_ID;

/**
 * The profiles a model declares, or `[]`. Deliberately does NOT prepend the
 * implicit default entry: that is a PRESENTATION rule (the picker owns it, the
 * same way `TextEncoderPicker` owns hide-when-there-is-no-real-choice), and
 * folding it in here would make every model look like it has a profile.
 */
export const videoSpeedProfiles = (model) => (
  Array.isArray(model?.speedProfiles) ? model.speedProfiles.filter((p) => typeof p?.id === 'string') : []
);

/**
 * Does this model offer any speed profile at all?
 */
export const supportsSpeedProfiles = (model) => videoSpeedProfiles(model).length > 0;

/**
 * Look up one declared profile by id. `null` for the default id, an unknown
 * id, or a model with none.
 */
export const findVideoSpeedProfile = (model, id) => (
  isDefaultSpeedProfile(id) ? null : videoSpeedProfiles(model).find((p) => p.id === id) || null
);

/**
 * Why a requested profile could not be applied — a machine-readable reason plus
 * a sentence the UI/log can show verbatim. `null` when the profile applies.
 *
 * Returned rather than thrown. Legacy LTX callers may retain their documented
 * fallback; H3 callers propagate the reason as a refusal, without fallback.
 */
export const speedProfileDeclineReason = ({ model, profileId, mode }) => {
  if (isDefaultSpeedProfile(profileId)) return null;
  if (isMiniMaxH3SpeedProfileRequest(profileId)) {
    return miniMaxH3SpeedProfileDeclineReason({ model, profileId, mode });
  }
  if (model?.samplerLocked === true) {
    return {
      code: 'SPEED_PROFILE_SAMPLER_LOCKED',
      message: `${model?.name || model?.id || 'This model'} locks its own validated sampler, so speed profiles don't apply.`,
    };
  }
  const profile = findVideoSpeedProfile(model, profileId);
  if (!profile) {
    return {
      code: 'SPEED_PROFILE_UNSUPPORTED',
      message: `Speed profile "${profileId}" isn't offered by ${model?.name || model?.id || 'this model'} — rendering at its default sampler.`,
    };
  }
  const modes = Array.isArray(profile.modes) ? profile.modes : TWO_STAGE_SPEED_PROFILE_MODES;
  // Absence is read as the plain text render — which is only SAFE because the
  // caller resolves the runner's own inference first (see `inferEffectiveMode`
  // below, used by generateVideo). A direct caller that hands us a raw absent
  // `mode` alongside keyframes would otherwise be told the profile applies,
  // while buildLtx2Args infers `fflf` and runs an entirely different pipeline.
  const effectiveMode = mode == null || mode === '' ? 'text' : mode;
  if (!modes.includes(effectiveMode)) {
    return {
      code: 'SPEED_PROFILE_MODE_UNSUPPORTED',
      message: `The ${profile.name} profile is validated for ${modes.join('/')} renders only — ${effectiveMode} renders use a different pipeline and keep the default sampler.`,
    };
  }
  return null;
};

/**
 * Resolve the sampler override a requested speed profile implies.
 *
 * Returns `null` when nothing should change (default profile, unsupported
 * model, incompatible mode) — the caller then leaves every dial exactly where
 * it was. Otherwise returns the concrete override the render should use.
 *
 * @returns {{ id, steps, stage2Steps, guidance, teacache, teacacheThresh, requiresAdapter } | null}
 */
export const resolveVideoSpeedProfile = ({ model, profileId, mode }) => {
  if (speedProfileDeclineReason({ model, profileId, mode })) return null;
  const profile = findVideoSpeedProfile(model, profileId);
  if (!profile) return null;
  if (isMiniMaxH3SpeedProfile(profile)) return isPinnedMiniMaxH3SpeedProfile(model, profile) ? profile : null;
  return {
    id: profile.id,
    steps: profile.steps,
    stage2Steps: profile.stage2Steps ?? null,
    guidance: profile.guidance,
    teacache: profile.teacache === true,
    teacacheThresh: profile.teacacheThresh ?? null,
    requiresAdapter: profile.requiresAdapter ?? null,
  };
};

/**
 * The mode a render will EFFECTIVELY run in when the caller omitted one.
 *
 * `buildLtx2Args` infers the helper mode from the conditioning it was handed —
 * `fflf` from multi-keyframes, `image` from a source image — so a gate that
 * read a raw absent `mode` as "text" would green-light a two-stage schedule for
 * a KeyframeInterpolation render the profile was never validated on. This is
 * that same inference, narrowed to what the gate needs, so the two agree by
 * construction rather than by comment.
 */
export const inferEffectiveVideoMode = ({ mode, keyframes, sourceImagePath, extendFromVideoPath, audioFilePath }) => {
  if (mode != null && mode !== '') return mode;
  if (Array.isArray(keyframes) && keyframes.length >= 2) return 'fflf';
  if (audioFilePath) return 'a2v';
  if (extendFromVideoPath) return 'extend';
  if (sourceImagePath) return 'image';
  return 'text';
};

/**
 * Resolve a profile for a MULTI-RENDER request (a chained render), where the
 * chunks do not all run in the same mode.
 *
 * A chained render is one clip. Applying the profile to the chunks whose mode
 * supports it and not to the rest would stitch a fast chunk (CFG 1.0, fewer
 * stage-2 steps, TeaCache) onto quality chunks — a visible seam mid-clip, and
 * a chain-level ETA that assumes a speed-up three quarters of the render never
 * takes. So the profile applies to the whole chain or to none of it.
 *
 * This is the same "degrade rather than half-apply" rule `resolveVideoSampler`
 * enforces for one render, lifted to the unit the user actually receives.
 *
 * @param {string[]} modes - every mode the chunks will run in
 * @returns the override when EVERY mode accepts it, otherwise `null`
 */
export const resolveVideoSpeedProfileForModes = ({ model, profileId, modes }) => {
  if (isDefaultSpeedProfile(profileId)) return null;
  const list = Array.isArray(modes) && modes.length > 0 ? modes : [null];
  if (list.some((mode) => speedProfileDeclineReason({ model, profileId, mode }))) return null;
  return resolveVideoSpeedProfile({ model, profileId, mode: list[0] });
};

/**
 * The first reason any of `modes` declines the profile, for logging. `null`
 * when every mode accepts it (or the request is the default profile).
 */
export const speedProfileDeclineReasonForModes = ({ model, profileId, modes }) => {
  if (isDefaultSpeedProfile(profileId)) return null;
  const list = Array.isArray(modes) && modes.length > 0 ? modes : [null];
  for (const mode of list) {
    const reason = speedProfileDeclineReason({ model, profileId, mode });
    if (reason) return reason;
  }
  return null;
};

/**
 * The effective sampler for one render — the SINGLE place the precedence
 * between a locked sampler, a speed profile, an explicit user value and the
 * model default is decided.
 *
 * Precedence, highest first:
 *   1. `model.samplerLocked` — the model's own validated schedule wins over
 *      everything, including a user-typed value (pre-existing contract).
 *   2. An applicable speed profile — the user picked a named schedule, so it
 *      drives steps AND guidance together. Same shape as a locked sampler:
 *      the UI disables the two inputs while a profile is active, and a direct
 *      API caller that sends both gets the profile it asked for rather than a
 *      half-applied hybrid whose speed claim would be false.
 *   3. An explicit `steps` / `guidanceScale` from the request.
 *   4. The model's registry defaults.
 *
 * `stage2Steps` is `null` unless a profile asked for an explicit one, so the
 * pipeline keeps its own default on every other path.
 *
 * Exported and pure so the render path and the chained-render ETA agree by
 * construction instead of by two copies of the same rule.
 */
export const resolveVideoSampler = ({ model, steps, guidanceScale, speedProfile = null }) => {
  if (isMiniMaxH3SpeedProfile(speedProfile)) {
    return { steps: speedProfile.steps, guidance: speedProfile.guidance, stage2Steps: null };
  }
  if (model?.samplerLocked === true) {
    return { steps: model.steps, guidance: model.guidance, stage2Steps: null };
  }
  if (speedProfile) {
    return {
      steps: speedProfile.steps,
      guidance: speedProfile.guidance,
      stage2Steps: speedProfile.stage2Steps ?? null,
    };
  }
  return {
    steps: steps ? Number(steps) : model?.steps,
    guidance: guidanceScale != null && guidanceScale !== '' ? Number(guidanceScale) : model?.guidance,
    stage2Steps: null,
  };
};

/**
 * Validate one platform's video list for speed-profile problems. Pure — returns
 * `{ id, profileId, reason }` rows (empty when sound). Callers decide whether
 * to warn-and-strip (load path) or fail (the test that pins the shipped
 * registry).
 *
 * Checked, in the order a hand-edit is most likely to break:
 *   - `speedProfiles` is an array (or absent)
 *   - every profile has a non-empty string id, unique within the entry
 *   - no profile reuses the reserved default id
 *   - `steps` is a positive integer and `guidance` a finite non-negative number
 *     — a profile that resolved to NaN steps would spawn a broken render
 *   - `stage2Steps`, when present, is a positive integer
 *   - `modes` is a non-empty array of strings
 *   - the entry is not also `samplerLocked` (two authorities over one dial)
 */
export const validateSpeedProfileTable = (list) => {
  if (!Array.isArray(list)) return [];
  const problems = [];
  const fail = (id, profileId, reason) => problems.push({ id, profileId, reason });
  for (const entry of list) {
    if (!isEntry(entry)) continue;
    if (!('speedProfiles' in entry) || entry.speedProfiles == null) continue;
    if (!Array.isArray(entry.speedProfiles)) {
      fail(entry.id, null, 'speedProfiles must be an array');
      continue;
    }
    const h3Profiles = entry.speedProfiles.length > 0
      && entry.speedProfiles.every((profile) => isPinnedMiniMaxH3SpeedProfile(entry, profile));
    if (entry.speedProfiles.length > 0 && entry.samplerLocked === true && !h3Profiles) {
      fail(entry.id, null, 'a samplerLocked model cannot also declare speedProfiles');
      continue;
    }
    // Only buildLtx2Args emits the profile's runner flags. On any other runtime
    // the step schedule would still apply (resolveVideoSampler is runtime-blind)
    // while TeaCache and the adapter silently would not — and no SPEEDPROFILE:
    // report would come back, so history would read as a FULL speed-up that
    // never happened. Refuse the declaration rather than ship that gap.
    if (entry.speedProfiles.length > 0 && !LTX2_FAMILY_RUNTIMES.includes(entry.runtime) && !h3Profiles) {
      fail(entry.id, null, `speedProfiles need an LTX-2-family runtime (got "${entry.runtime || 'none'}") — no other builder emits their flags`);
      continue;
    }
    const seen = new Set();
    for (const profile of entry.speedProfiles) {
      const pid = profile?.id;
      if (isMiniMaxH3SpeedProfile(profile) && !isPinnedMiniMaxH3SpeedProfile(entry, profile)) {
        fail(entry.id, pid, 'H3 speed profiles must match the complete pinned model/runtime/adapter/schedule contract');
        continue;
      }
      if (typeof pid !== 'string' || pid.length === 0) {
        fail(entry.id, pid ?? null, 'profile id must be a non-empty string');
        continue;
      }
      if (pid === SPEED_PROFILE_DEFAULT_ID) {
        fail(entry.id, pid, `"${SPEED_PROFILE_DEFAULT_ID}" is the reserved default profile id`);
        continue;
      }
      if (seen.has(pid)) {
        fail(entry.id, pid, `duplicate profile id "${pid}"`);
        continue;
      }
      seen.add(pid);
      if (!Number.isInteger(profile.steps) || profile.steps <= 0) {
        fail(entry.id, pid, 'steps must be a positive integer');
        continue;
      }
      if (!Number.isFinite(profile.guidance) || profile.guidance < 0) {
        fail(entry.id, pid, 'guidance must be a finite number >= 0');
        continue;
      }
      if (profile.stage2Steps != null
        && (!Number.isInteger(profile.stage2Steps) || profile.stage2Steps <= 0)) {
        fail(entry.id, pid, 'stage2Steps must be a positive integer when present');
        continue;
      }
      if (!Array.isArray(profile.modes) || profile.modes.length === 0
        || profile.modes.some((m) => typeof m !== 'string' || m.length === 0)) {
        fail(entry.id, pid, 'modes must be a non-empty array of strings');
        continue;
      }
      // Both of these reach the helper's argv. A non-numeric threshold exits the
      // child at argparse (`type=float`) mid-job, and a non-string adapter name
      // throws out of spawn — so they belong in the same fail-closed check as
      // the sampler numbers rather than being trusted from a hand-edited file.
      if (profile.teacacheThresh != null
        && (!Number.isFinite(profile.teacacheThresh) || profile.teacacheThresh <= 0)) {
        fail(entry.id, pid, 'teacacheThresh must be a positive number when present');
        continue;
      }
      if (profile.requiresAdapter != null
        && (typeof profile.requiresAdapter !== 'string' || profile.requiresAdapter.length === 0)) {
        fail(entry.id, pid, 'requiresAdapter must be a non-empty string when present');
      }
    }
  }
  return problems;
};

/**
 * Load-time guard: strip every invalid `speedProfiles` list, logging each
 * problem. A user-edited (or migration-stale) registry must not be able to
 * offer a profile that would spawn a broken render, and must not crash boot
 * (`loadMediaModels` runs at import time). Returns the input array unchanged
 * when the table is sound, so the common path allocates nothing.
 */
export const sanitizeSpeedProfiles = (list) => {
  const problems = validateSpeedProfileTable(list);
  if (problems.length === 0) return list;
  const bad = new Set(problems.map((p) => p.id));
  for (const p of problems) {
    console.log(`⚠️ media-models: dropping speedProfiles on "${p.id}" — ${p.reason}`);
  }
  return list.map((entry) => {
    if (!isEntry(entry) || !bad.has(entry.id)) return entry;
    const { speedProfiles: _dropped, ...rest } = entry;
    return rest;
  });
};
