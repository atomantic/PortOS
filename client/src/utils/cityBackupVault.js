// Pure, deterministic helpers for CyberCity's backup-vault landmark (roadmap 2.3):
// a small monument west of downtown whose color, label, and pulse reflect backup
// health. The vault derives "staleness" from the time since the last snapshot, so a
// backup that hasn't run in too long glows red and reads as needing attention. No
// three.js / React imports so the topology is unit-testable (mirrors cityFederation.js).

export const VAULT = {
  position: [-34, 0, -10], // west of the building grid, clear of downtown and the +Z archive district
  width: 5,
  height: 8,
  // Staleness thresholds, in ms since the last snapshot. A fresh backup is healthy;
  // between fresh and stale it ages to amber; past `staleMs` it goes red.
  freshMs: 24 * 60 * 60 * 1000, // < 1 day → healthy
  staleMs: 3 * 24 * 60 * 60 * 1000, // ≥ 3 days → stale
};

// Color per health classification — reuses the PortOS Tailwind design tokens so the
// vault speaks the same visual language as the rest of the UI.
const HEALTH_COLORS = {
  ok: '#22c55e', // port-success — recent snapshot
  aging: '#f59e0b', // port-warning — getting old
  stale: '#ef4444', // port-error — overdue
  error: '#ef4444', // port-error — last run failed
  never: '#64748b', // slate — never backed up / not configured
  running: '#3b82f6', // port-accent — a backup is in flight
};

// Map persisted backup state → a health classification. `state.status` is the stored
// status ('never' | 'ok' | 'error'); `state.lastRun` is the ISO timestamp of the last
// run (or null); `state.running` is set true while a backup is in flight (socket-driven).
// `now` is injected so the staleness derivation is deterministic in tests.
export function vaultHealth(state, now = Date.now()) {
  if (state?.running) return 'running';
  const status = state?.status || 'never';
  if (status === 'error') return 'error';
  if (status === 'never' || !state?.lastRun) return 'never';
  const last = new Date(state.lastRun).getTime();
  if (!Number.isFinite(last)) return 'never';
  const age = now - last;
  if (age >= VAULT.staleMs) return 'stale';
  if (age >= VAULT.freshMs) return 'aging';
  return 'ok';
}

export function vaultColor(health) {
  return HEALTH_COLORS[health] || HEALTH_COLORS.never;
}

// Should the vault read as needing attention (urgent pulse, brighter glow)?
export function vaultIsAlerting(health) {
  return health === 'stale' || health === 'error';
}

// Short uppercase label rendered under the monument.
export function vaultStatusLabel(health) {
  switch (health) {
    case 'running': return 'BACKING UP';
    case 'ok': return 'PROTECTED';
    case 'aging': return 'AGING';
    case 'stale': return 'STALE';
    case 'error': return 'FAILED';
    default: return 'NO BACKUP';
  }
}

// Full derived view-model for the component: geometry + health + color + alert flag +
// emissive intensity (brighter while running or alerting, calm otherwise). `now` is
// injected so the whole view-model is deterministic under test.
export function computeBackupVault(state, now = Date.now()) {
  const health = vaultHealth(state, now);
  const alerting = vaultIsAlerting(health);
  return {
    position: VAULT.position,
    width: VAULT.width,
    height: VAULT.height,
    health,
    color: vaultColor(health),
    alerting,
    running: health === 'running',
    statusLabel: vaultStatusLabel(health),
    lastRun: state?.lastRun ?? null,
    intensity: health === 'running' ? 1 : alerting ? 0.85 : 0.5,
  };
}
