import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  createRenderBudget,
  recordFrame,
  restartWarmup,
  resetRenderBudget,
  getEffectiveTier,
} from '../../utils/openWorldRenderBudget.js';

// In-Canvas driver for Auto quality mode (issue #2592). It samples per-frame delta
// times via useFrame, feeds them to the pure render-budget state machine, and lifts
// tier changes back up to OpenWorld through a callback.
// It renders nothing. All impurity (timers, refs, frame loop) lives here so the
// state machine stays pure and unit-tested.
//
// - `enabled`: Auto mode is on. When off, the machine is left idle (Manual mode).
// - `startTier`: the tier to (re)start the budget at when Auto engages.
// - `resumeToken`: bumped by OpenWorldScene when the frameloop resumes after the tab was
//   hidden — re-arms the warm-up so post-resume jank doesn't drive a bogus decision.
export default function OpenWorldAdaptiveQuality({
  enabled,
  startTier = 'high',
  resumeToken = 0,
  resetToken = 0,
  onTierChange,
}) {
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0);
  const stateRef = useRef(null);
  if (stateRef.current === null) {
    stateRef.current = createRenderBudget(startTier, nowMs());
  }
  // Tracks the last-seen resumeToken so the re-arm happens INSIDE the frame loop (below),
  // before the first resumed frame is measured — a passive effect could run after the
  // Canvas has already switched frameloop back to "always", letting one stale-window
  // frame classify against pre-hide samples first.
  const seenResumeRef = useRef(resumeToken);

  // Re-start the budget whenever Auto (re)engages, the starting tier changes, or the user
  // resets defaults (resetToken) — so a Manual→Auto switch and a RESET DEFAULTS both begin
  // adaptation fresh at the start tier rather than resuming a stale runtime tier.
  useEffect(() => {
    if (!enabled) return;
    stateRef.current = resetRenderBudget(stateRef.current, startTier, nowMs());
    seenResumeRef.current = resumeToken;
    onTierChange?.(getEffectiveTier(stateRef.current));
    // Deps are intentionally [enabled, startTier, resetToken] — a fresh onTierChange
    // callback identity must not reset the live budget mid-run.
  }, [enabled, startTier, resetToken]);

  useFrame((_, delta) => {
    if (!enabled) return;
    const now = nowMs();
    // Frameloop just resumed from a hidden tab → re-arm warm-up before measuring, so the
    // first sluggish post-resume frames (and any pre-hide streaks/samples) are dropped.
    if (seenResumeRef.current !== resumeToken) {
      seenResumeRef.current = resumeToken;
      stateRef.current = restartWarmup(stateRef.current, now);
    }
    const prevTier = getEffectiveTier(stateRef.current);
    stateRef.current = recordFrame(stateRef.current, { now, dt: delta * 1000 });
    const nextTier = getEffectiveTier(stateRef.current);
    if (nextTier !== prevTier) onTierChange?.(nextTier);
  });

  return null;
}
