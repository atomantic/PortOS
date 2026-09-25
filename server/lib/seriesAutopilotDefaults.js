// Shared saved-setting defaults for the Series Autopilot panel and runtime.
// Keep these keyed by the existing pipelineEditorialChecks setting names.
export const SERIES_AUTOPILOT_DEFAULTS = Object.freeze({
  maxArcVerifyRounds: 3,
  maxEditorialRounds: 2,
  maxBeatContinuityRounds: 2,
  maxFoundationRounds: 3,
  checkFindingsPauseThreshold: 0,
  notifyOnPause: true,
  revisionEnabled: false,
  revisionMinCycles: 1,
  revisionMaxCycles: 2,
  revisionPlateauDelta: 0.3,
  foundationGate: true,
  foundationThreshold: 7.5,
  selfImprove: false,
  observer: false,
  autoSelectModels: false,
  overrideStagePins: false,
});
