/** Labels and tones shared by the Music Video production, auto-review and autonomous run panels. */

export const RUN_STATUS_LABELS = Object.freeze({
  running: 'Running',
  stopped: 'Paused',
  'limit-reached': 'Stopped at a limit',
  blocked: 'Blocked',
  'needs-replan': 'Setup changed',
  'awaiting-video': 'Stills done',
  'awaiting-approval': 'Awaiting review',
  'needs-human': 'Needs you',
  completed: 'Finished',
  passed: 'Passed',
  failed: 'Failed',
  canceled: 'Cancelled',
});

export const RUN_STATUS_TONES = Object.freeze({
  running: 'text-port-accent',
  stopped: 'text-port-warning',
  'limit-reached': 'text-port-warning',
  blocked: 'text-port-warning',
  'needs-replan': 'text-port-warning',
  'awaiting-video': 'text-port-warning',
  'awaiting-approval': 'text-port-warning',
  'needs-human': 'text-port-warning',
  completed: 'text-port-success',
  passed: 'text-port-success',
  failed: 'text-port-error',
  canceled: 'text-port-text-muted',
});
