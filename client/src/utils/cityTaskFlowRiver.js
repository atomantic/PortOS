// Pure, deterministic helpers for CyberCity's task-flow river (roadmap 2.6 follow-up, issue
// #817): an animated flow that runs from the task-queue warehouse to the productivity
// district, visually tying queued work to completed throughput. The river's WIDTH tracks the
// live backlog (more pending/in-progress work → a broader channel) and its SPEED tracks
// recent throughput / queue drain (more recently-completed tasks relative to the backlog → a
// faster current). No three.js / React imports so the topology is unit-testable (mirrors
// cityProductivity.js / cityTaskQueue.js).

import { MONUMENT } from './cityProductivity';
import { TASK_QUEUE } from './cityTaskQueue';

export const RIVER = {
  // The channel runs warehouse → monument. Endpoints mirror the two districts it links.
  from: TASK_QUEUE.position, // task-queue warehouse (east)
  to: MONUMENT.position, // productivity-district monument (southwest)
  minWidth: 1.4, // a thin trickle when the queue is empty
  maxWidth: 7, // a broad channel at/above the backlog cap
  backlogCap: 12, // backlog count mapped to full width; beyond this stays capped
  minSpeed: 0.15, // a barely-moving current when nothing is draining
  maxSpeed: 1.6, // full-tilt flow when throughput is high
  throughputCap: 10, // recently-completed count mapped to full speed
  particleSpacing: 3.2, // world units between flow particles along the channel
};

const ACTIVE_COLOR = '#22c55e'; // port-success — work is draining (completing)
const QUEUED_COLOR = '#3b82f6'; // port-accent — backlog present, little draining
const BLOCKED_COLOR = '#f59e0b'; // port-warning — blocked work gumming up the flow
const IDLE_COLOR = '#475569'; // slate — empty channel, nothing moving

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Coerce to a finite, non-negative number or 0 — counts and throughput are never negative.
function nonNegOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

// Map a backlog count to a 0..1 width level against the cap, clamped.
export function widthLevel(backlog, cap = RIVER.backlogCap) {
  const b = nonNegOrZero(backlog);
  const c = nonNegOrZero(cap) || 1;
  return clamp01(b / c);
}

// Map a recent-throughput count to a 0..1 speed level against the cap, clamped.
export function speedLevel(throughput, cap = RIVER.throughputCap) {
  const t = nonNegOrZero(throughput);
  const c = nonNegOrZero(cap) || 1;
  return clamp01(t / c);
}

// Sum completed tasks over the most recent `days` calendar days (excluding future days), as a
// bounded "recent drain" signal. The activity calendar's `summary.totalTasks` spans the whole
// 12-week window, so it would pin the river at full speed forever after a few historical
// completions; a trailing window keeps the current honest about *recent* throughput. Returns
// null when there's no usable calendar so the caller can fall back to today's count.
export function recentCalendarThroughput(calendarData, days = 7) {
  const weeks = Array.isArray(calendarData?.weeks) ? calendarData.weeks : null;
  if (!weeks) return null;
  const flat = [];
  for (const week of weeks) {
    if (!Array.isArray(week)) continue;
    for (const day of week) {
      if (day && typeof day === 'object' && !day.isFuture) flat.push(day);
    }
  }
  if (flat.length === 0) return null;
  const window = days > 0 ? flat.slice(-days) : flat;
  return window.reduce((sum, day) => sum + nonNegOrZero(day.tasks), 0);
}

// Euclidean distance on the ground plane (x/z) between the two endpoints.
function groundLength(from, to) {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  return Math.sqrt(dx * dx + dz * dz);
}

// Full derived view-model for the component. Inputs:
//  - `taskQueue`: the `computeTaskQueue` view-model (`{ pending, inProgress, blocked, ... }`)
//    — the live backlog that sets the channel width.
//  - `recentThroughput`: a count of recently-completed tasks (e.g. the calendar window's
//    `summary.totalTasks` or today's completed) that sets the current speed.
// Tolerates missing/garbage inputs by reading them as zero, yielding a thin, near-still,
// idle-slate channel that still renders as a quiet seam between the districts.
export function computeTaskFlowRiver(taskQueue, recentThroughput) {
  const queue = taskQueue && typeof taskQueue === 'object' ? taskQueue : {};
  const pending = nonNegOrZero(queue.pending);
  const inProgress = nonNegOrZero(queue.inProgress);
  const blocked = nonNegOrZero(queue.blocked);
  const backlog = pending + inProgress + blocked;
  const throughput = nonNegOrZero(recentThroughput);

  const wLevel = widthLevel(backlog);
  const sLevel = speedLevel(throughput);

  const width = RIVER.minWidth + wLevel * (RIVER.maxWidth - RIVER.minWidth);
  const speed = RIVER.minSpeed + sLevel * (RIVER.maxSpeed - RIVER.minSpeed);

  // Color reads the queue's dominant state, mirroring the warehouse: blocked work warns,
  // active draining flows green, a non-empty backlog sits accent-blue, an empty channel idles.
  let state;
  if (blocked > 0) state = 'blocked';
  else if (inProgress > 0) state = 'active';
  else if (pending > 0) state = 'queued';
  else state = 'idle';
  const color = state === 'blocked' ? BLOCKED_COLOR
    : state === 'active' ? ACTIVE_COLOR
      : state === 'queued' ? QUEUED_COLOR
        : IDLE_COLOR;

  const length = groundLength(RIVER.from, RIVER.to);
  // Rotation about +Y so the channel's local +x (its length axis) points from `from` toward
  // `to`. A +Y rotation by θ maps local +x (1,0,0) to world (cosθ, 0, -sinθ); aligning that
  // with the ground-plane direction (dx, dz) gives θ = atan2(-dz, dx).
  const dx = RIVER.to[0] - RIVER.from[0];
  const dz = RIVER.to[2] - RIVER.from[2];
  const angle = Math.atan2(-dz, dx);
  const center = [
    (RIVER.from[0] + RIVER.to[0]) / 2,
    0,
    (RIVER.from[2] + RIVER.to[2]) / 2,
  ];

  // Evenly-spaced flow particles along the channel; their count scales with length so the
  // current reads continuously regardless of how far apart the districts sit. Each carries a
  // 0..1 phase offset so the component can animate them flowing along the channel.
  const particleCount = Math.max(2, Math.round(length / RIVER.particleSpacing));
  const particles = [];
  for (let i = 0; i < particleCount; i++) {
    particles.push({ index: i, phase: i / particleCount });
  }

  return {
    from: RIVER.from,
    to: RIVER.to,
    center,
    angle,
    length,
    width,
    widthLevel: wLevel,
    speed,
    speedLevel: sLevel,
    backlog,
    pending,
    inProgress,
    blocked,
    throughput,
    state,
    color,
    flowing: state !== 'idle' && sLevel > 0,
    particles,
  };
}
