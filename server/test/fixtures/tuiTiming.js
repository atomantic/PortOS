// Default PTY timings and retry budgets exercised by the fake-clock integration tests.

export const TUI_TRUST_NAVIGATION_MIN_AGE_MS = 1000;
export const TUI_TRUST_SETTLE_MS = 400;
export const TUI_TRUST_MAX_NAVIGATIONS = 4;

export const SUBMIT_ENTER_ATTEMPTS = 3;
export const SUBMIT_ENTER_SPACING_MS = 700;
export const UNSUBMITTED_PROMPT_SETTLE_MS = 20000;
export const PROMPT_WORK_EVIDENCE_MS = 30000;

export const SELF_CLEARING_RESUBMIT_INTERVAL_MS = 20000;
export const SELF_CLEARING_RESUBMIT_ECHO_MS = 3000;
export const OOM_NUDGE_SETTLE_MS = 25000;
export const OOM_NUDGE_ARM_WINDOW_MS = 120000;
export const OOM_NUDGE_COOLDOWN_MS = 120000;
export const CAPACITY_NUDGE_SETTLE_MS = 90000;
export const CAPACITY_NUDGE_ARM_WINDOW_MS = 300000;
export const CAPACITY_NUDGE_COOLDOWN_MS = 180000;
export const RETRY_STALL_MS = 10 * 60 * 1000;
export const RETRY_STALL_MIN_ADVANCES = 2;
export const TOOL_PERMISSION_REPAINT_COOLDOWN_MS = 15000;
export const STALL_NUDGE_IDLE_MS = 10 * 60 * 1000;
export const STALL_NUDGE_RECOVERY_MS = 30000;
