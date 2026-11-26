import { useCallback, useEffect, useRef, useState } from 'react';
import { READINESS_GATE_LABELS } from '../../lib/editorialHealth.js';
import { getSettings, patchSettingsSlice } from '../../services/apiSystem.js';
import { SERIES_AUTOPILOT_DEFAULTS } from '../../../../server/lib/seriesAutopilotDefaults.js';
import { ROUND_MIN, ROUND_MAX } from './AutopilotStageQualitySections';
import usePersistedOptions, { readBoolean, readInteger, readNumber } from './usePersistedOptions';

// Threshold input: a [0,10] number (0.5 steps allowed — NOT integer-rounded like
// the round clamps), blank/invalid → the default.
const clampFoundationThreshold = (n, fallback) => {
  if (n === '' || n === null || n === undefined) return fallback;
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(10, Math.round(v * 100) / 100));
};

// Clamp a number-input value to [min, max] integers, with a blank/invalid field
// falling back to `fallback` (NOT min — for round gates fallback is the default,
// not 0, so a cleared input never silently disables a gate; an explicitly typed 0
// is still honored). `max === null` leaves the value uncapped.
const clampNumber = (n, { fallback, min, max }) => {
  if (n === '' || n === null || n === undefined) return fallback;
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const rounded = Math.max(min, Math.round(v));
  return max === null ? rounded : Math.min(max, rounded);
};
const clampRound = (n, fallback) => clampNumber(n, { fallback, min: ROUND_MIN, max: ROUND_MAX });
// Pause threshold: blank → 0 (off), non-negative integer, no upper cap.
const clampThreshold = (n) => clampNumber(n, { fallback: 0, min: 0, max: null });
// Revision cycles: at least 1 (0 would strand the loop), capped like the rounds.
const clampCycles = (n, fallback) => clampNumber(n, { fallback, min: 1, max: ROUND_MAX });
// Plateau delta: a float ≥ 0 (blank → the default). No rounding, unlike the gates.
const clampDelta = (n, fallback) => {
  if (n === '' || n === null || n === undefined) return fallback;
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(10, Math.max(0, v));
};

// Every option that follows the "saved default + per-run override" contract, as
// ONE row each: the display default, how to read a saved value (undefined =
// absent/invalid → the default), the clamp applied both on blur and when the
// value is sent as an override, and whether editing persists immediately.
// `persistOnEdit` is for controls with no blur event (checkboxes); the numeric
// inputs persist from RoundInput's onBlur instead. Keyed by the SETTING key the
// server reads, so a key can't drift between the load, the save and the run.
// Per-run-only options (readiness gate, unlock pre-pass, provider/model/effort)
// are deliberately NOT here — they are never persisted.
const OPTION_SPECS = {
  maxArcVerifyRounds: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.maxArcVerifyRounds,
    read: readInteger,
    clamp: (v) => clampRound(v, SERIES_AUTOPILOT_DEFAULTS.maxArcVerifyRounds),
  },
  maxEditorialRounds: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.maxEditorialRounds,
    read: readInteger,
    clamp: (v) => clampRound(v, SERIES_AUTOPILOT_DEFAULTS.maxEditorialRounds),
  },
  maxBeatContinuityRounds: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.maxBeatContinuityRounds,
    read: readInteger,
    clamp: (v) => clampRound(v, SERIES_AUTOPILOT_DEFAULTS.maxBeatContinuityRounds),
  },
  // #1613 — non-negative integer, no upper cap (0 = off).
  checkFindingsPauseThreshold: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.checkFindingsPauseThreshold,
    read: readInteger,
    clamp: clampThreshold,
  },
  // #1615 — plain boolean, no clamp. Defaults ON.
  notifyOnPause: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.notifyOnPause,
    read: readBoolean,
    persistOnEdit: true,
  },
  // #2171 — revision loop: enable checkbox + cycle bounds + plateau delta.
  revisionEnabled: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.revisionEnabled,
    read: readBoolean,
    persistOnEdit: true,
  },
  revisionMinCycles: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.revisionMinCycles,
    read: readInteger,
    clamp: (v) => clampCycles(v, SERIES_AUTOPILOT_DEFAULTS.revisionMinCycles),
  },
  revisionMaxCycles: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.revisionMaxCycles,
    read: readInteger,
    clamp: (v) => clampCycles(v, SERIES_AUTOPILOT_DEFAULTS.revisionMaxCycles),
  },
  revisionPlateauDelta: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.revisionPlateauDelta,
    read: readNumber,
    clamp: (v) => clampDelta(v, SERIES_AUTOPILOT_DEFAULTS.revisionPlateauDelta),
  },
  // #2176 — foundation gate (defaults ON) + weighted threshold + round bound.
  foundationGate: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.foundationGate,
    read: readBoolean,
    persistOnEdit: true,
  },
  foundationThreshold: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.foundationThreshold,
    read: readNumber,
    clamp: (v) => clampFoundationThreshold(v, SERIES_AUTOPILOT_DEFAULTS.foundationThreshold),
  },
  maxFoundationRounds: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.maxFoundationRounds,
    read: readInteger,
    clamp: (v) => clampRound(v, SERIES_AUTOPILOT_DEFAULTS.maxFoundationRounds),
  },
  // Pipeline self-improvement — boolean, off by default.
  selfImprove: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.selfImprove,
    read: readBoolean,
    persistOnEdit: true,
  },
  // Observing orchestrator — boolean, off by default. Persisted like selfImprove:
  // a scheduled unattended run is exactly where the user wants the pipeline
  // hardening itself.
  observer: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.observer,
    read: readBoolean,
    persistOnEdit: true,
  },
  autoSelectModels: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.autoSelectModels,
    read: readBoolean,
    persistOnEdit: true,
  },
  overrideStagePins: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.overrideStagePins,
    read: readBoolean,
    persistOnEdit: true,
  },
};

const QUALITY_OPTION_KEYS = [
  'foundationGate', 'foundationThreshold', 'maxFoundationRounds',
  'maxArcVerifyRounds', 'maxBeatContinuityRounds', 'maxEditorialRounds',
  'checkFindingsPauseThreshold', 'revisionEnabled', 'revisionMinCycles',
  'revisionMaxCycles', 'revisionPlateauDelta',
];


export default function useAutopilotRunOptions(series) {
  const seriesId = series?.id;
  const [includeVisual, setIncludeVisual] = useState(true);
  const [fileGaps, setFileGaps] = useState(false);

  // A paused run is a continuation, not a new configuration. Restore the two
  // run-local toggles the server stamped onto its marker so a reload/restart
  // cannot silently turn gap filing off (or visuals back on). A completed run
  // and a different series intentionally return to the ordinary defaults.
  const resumeIncludeVisual = series?.autopilot?.resumeOptions?.includeVisual;
  const resumeFileGaps = series?.autopilot?.resumeOptions?.fileGaps;
  useEffect(() => {
    const paused = series?.autopilot?.status === 'paused';
    setIncludeVisual(paused && typeof resumeIncludeVisual === 'boolean' ? resumeIncludeVisual : true);
    setFileGaps(paused && typeof resumeFileGaps === 'boolean' ? resumeFileGaps : false);
  }, [seriesId, series?.autopilot?.status, resumeIncludeVisual, resumeFileGaps]);
  // Persist a setting (clamped) so a later Resume picks it up server-side.
  // Keep same-control writes ordered so start() also waits for an in-flight
  // blur save. Independent settings patches are merged atomically server-side.
  const persistTailRef = useRef(Promise.resolve());
  const persistRounds = useCallback((patch) => {
    const next = persistTailRef.current
      .catch(() => {})
      .then(() => patchSettingsSlice('pipelineEditorialChecks', patch).catch(() => null));
    persistTailRef.current = next;
    return next;
  }, []);
  // Every persisted option (saved default + per-run override) in one registry —
  // see OPTION_SPECS. The registry owns the state, the per-field dirty flags, the
  // hydrate-if-untouched pass and the edited-only override collection, so adding
  // an option is one spec row plus its control, not seven scattered edits.
  const options = usePersistedOptions(OPTION_SPECS, persistRounds);
  const opt = options.values;
  // Per-run readiness-gate override (#1580). '' = use the saved default (send
  // nothing). `savedGate` is the persisted gate, shown in the "saved default"
  // option label so the user knows what the fallback is.
  const [readinessGate, setReadinessGate] = useState('');
  const [savedGate, setSavedGate] = useState('');
  // Unlock-everything pre-pass. PER-RUN ONLY and never persisted (like
  // `readinessGate` below, unlike every other option here): it rewrites lock
  // state the user set by hand, and a saved default would be picked up by
  // scheduled unattended runs of every series. Always starts unticked, so
  // clearing locks is a fresh, deliberate choice each run.
  const [unlockForRun, setUnlockForRun] = useState(false);

  // Disarm unlock consent when the panel switches series. The
  // component is reused across `seriesId` changes rather than remounted, so
  // without this a box ticked for series A would still be armed — invisibly,
  // since the Options popover is collapsed — when the user lands on series B
  // and hits Run. Consent is per series AND per run; never inherited.
  useEffect(() => { setUnlockForRun(false); }, [seriesId]);

  // Load the persisted option defaults so the Options controls reflect the
  // install's settings. The autopilot reads the same settings server-side, so we
  // never send an untouched option as a per-run override — we just keep the UI in
  // sync and persist edits back. `hydrate` applies the fetched values only to
  // fields the user hasn't already edited, so a slow load can't clobber a fast
  // edit (per-field).
  const { hydrate } = options;
  useEffect(() => {
    let canceled = false;
    getSettings({ silent: true })
      .then((s) => {
        if (canceled) return;
        const pec = s?.pipelineEditorialChecks || {};
        hydrate(pec);
        // Persisted readiness gate — display-only, drives the "saved default" label.
        setSavedGate(READINESS_GATE_LABELS[pec.readinessGate] ? pec.readinessGate : '');
      })
      .catch(() => null); // load failed → inputs keep defaults but start() only persists EDITED fields
    return () => { canceled = true; };
  }, [hydrate]);

  const prepareRunOptions = async (productionScope) => {
    // ONLY the options the user edited (clamped, real values — never the display
    // defaults of untouched options, which would mask a saved setting). Send them
    // as per-run overrides AND persist them: the override makes the edit effective
    // for THIS run even if the save fails (persist is best-effort, server
    // precedence is per-run → setting → default), and the persist makes it the
    // saved default for next time. Untouched options send nothing, so the server
    // resolves them from the persisted setting.
    const roundOverrides = options.collectOverrides();
    if (Object.keys(roundOverrides).length) await persistRounds(roundOverrides);
    // Per-run readiness-gate override (#1580): send it ONLY when the user picked a
    // specific gate. Unlike the round inputs we never persist it — '' leaves the
    // server to resolve the gate from the saved setting (then the default).
    const gateOverride = READINESS_GATE_LABELS[readinessGate] ? { readinessGate } : {};
    // Per-run unlock pre-pass — sent only when ticked, and never persisted (see
    // the state declaration): a saved default would reach unattended scheduled
    // runs of every series, and this one rewrites user-set lock state.
    const unlockOverride = unlockForRun ? { unlockForRun: true } : {};

    const scopeOverride = productionScope === 'first-issue' ? { productionScope } : {};
    return { includeVisual, fileGaps, ...scopeOverride, ...roundOverrides, ...gateOverride, ...unlockOverride };
  };

  const qualityOverrides = QUALITY_OPTION_KEYS
    .filter((key) => (OPTION_SPECS[key].clamp?.(opt[key]) ?? opt[key]) !== OPTION_SPECS[key].defaultValue).length
    + Number(Boolean(readinessGate));

  return {
    prepareRunOptions, clearUnlockForRun: () => setUnlockForRun(false),
    runOptionFields: { opt, options, includeVisual, setIncludeVisual, fileGaps, setFileGaps, unlockForRun, setUnlockForRun },
    qualityFields: { opt, options, qualityOverrides, readinessGate, setReadinessGate, savedGate },
  };
}
