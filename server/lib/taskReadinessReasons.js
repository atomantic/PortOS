// Stable wire codes shared by scheduling, workflow projections, and the Schedule UI.
// Keep values unchanged: federated peers and clients may run different versions.
export const TASK_READINESS_REASON = Object.freeze({
  REQUIRES_INSTALL_WIDE_TARGET: 'requires-install-wide-target',
  DISABLED: 'disabled',
  FEATURE_DISABLED: 'feature-disabled',
  ON_DEMAND_ONLY: 'on-demand-only',
  WEEKDAY_ONLY: 'weekday-only',
  DISABLED_FOR_APP: 'disabled-for-app',
  FAILURE_PARKED: 'failure-parked',
  PERPETUAL_PARKED: 'perpetual-parked',
  PERPETUAL_RECHECK: 'perpetual-recheck',
  PERPETUAL_DRAIN: 'perpetual-drain',
  INVALID_CRON: 'invalid-cron',
  CRON_DUE: 'cron-due',
  CRON_COOLDOWN: 'cron-cooldown',
  FAILURE_COOLDOWN: 'failure-cooldown',
  WAITING_ON_DEPENDENCIES: 'waiting-on-dependencies',
});

export const TASK_READINESS_REASONS = Object.freeze(Object.values(TASK_READINESS_REASON));
export const TASK_READINESS_REASON_SET = new Set(TASK_READINESS_REASONS);
