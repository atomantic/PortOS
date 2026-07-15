import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  createRenderBudget,
  recordFrame,
  restartWarmup,
  resetRenderBudget,
  getEffectiveTier,
} from '../../utils/cityRenderBudget.js';

// In-Canvas driver for Auto quality mode (issue #2592). It samples per-frame delta
// times via useFrame, feeds them to the pure render-budget state machine, and lifts
// tier changes + (throttled) diagnostics back up to CyberCity through callbacks.
// It renders nothing. All impurity (timers, refs, frame loop) lives here so the
// state machine stays pure and unit-tested.
//
// - `enabled`: Auto mode is on. When off, the machine is left idle (Manual mode).
// - `startTier`: the tier to (re)start the budget at when Auto engages.
// - `resumeToken`: bumped by CityScene when the frameloop resumes after the tab was
//   hidden — re-arms the warm-up so post-resume jank doesn't drive a bogus decision.
// - `diagnosticsEnabled`: only push diagnostics upward while the settings panel is
//   open, so the 0.5Hz readout doesn't re-render the scene when nobody's watching.
export default function CityAdaptiveQuality({
  enabled,
  startTier = 'high',
  resumeToken = 0,
  diagnosticsEnabled = false,
  onTierChange,
  onDiagnostics,
}) {
  const stateRef = useRef(null);
  if (stateRef.current === null) {
    stateRef.current = createRenderBudget(startTier, typeof performance !== 'undefined' ? performance.now() : 0);
  }

  // Re-start the budget whenever Auto (re)engages or the starting tier changes, so a
  // Manual→Auto switch always begins at High rather than resuming a stale tier.
  useEffect(() => {
    if (!enabled) return;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    stateRef.current = resetRenderBudget(stateRef.current, startTier, now);
    onTierChange?.(getEffectiveTier(stateRef.current));
    // Deps are intentionally just [enabled, startTier] — a fresh onTierChange callback
    // identity must not reset the live budget mid-run.
  }, [enabled, startTier]);

  // Re-arm warm-up on frameloop resume (tab became visible again).
  useEffect(() => {
    if (!enabled) return;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    stateRef.current = restartWarmup(stateRef.current, now);
  }, [resumeToken]);

  useFrame((_, delta) => {
    if (!enabled) return;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const prevTier = getEffectiveTier(stateRef.current);
    stateRef.current = recordFrame(stateRef.current, { now, dt: delta * 1000 });
    const nextTier = getEffectiveTier(stateRef.current);
    if (nextTier !== prevTier) onTierChange?.(nextTier);
    // Diagnostics refresh only when a window closes (~0.5Hz) and only if someone's
    // watching — keeps the hot loop from re-rendering the page.
    if (diagnosticsEnabled && stateRef.current.windowClosed) {
      onDiagnostics?.(stateRef.current.diagnostics);
    }
  });

  return null;
}
