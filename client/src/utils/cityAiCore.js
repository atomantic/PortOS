// Pure, deterministic helpers for CyberCity's AI Core landmark (roadmap 2.1): a central
// spire above downtown from which all model activity radiates. The server broadcasts
// phase-tagged `ai:status` events (start → model:loading → model:loaded → complete/error)
// for every LLM/model call; this module tracks the in-flight set and derives the core's
// glow/beam state. No three.js / React imports so the logic is unit-testable (mirrors
// cityBackupVault.js).
//
// Note: `ai:status` carries no agent/building association, so beams radiate generically
// from the core rather than targeting the originating building — see issue note. Model
// tier is a best-effort heuristic from the model name (the event has no explicit tier).

export const AI_CORE = {
  position: [0, 0, 0], // city center — the spire rises above the building grid
  height: 34, // tall enough to clear downtown and read as the central landmark
  apexY: 34, // beams/glow originate from the apex
  maxBeams: 6, // visible activity beams cap
  // How long an op with no terminal (complete/error) event lingers before being pruned,
  // so a dropped/never-finished call can't pin the core "busy" forever.
  opMaxAgeMs: 60_000,
  // How long after the last op start the core keeps its "just fired" flare.
  flareMs: 1200,
};

const TIER_COLORS = {
  light: '#22d3ee', // cyan — fast/cheap models
  medium: '#3b82f6', // port-accent — standard models
  heavy: '#a855f7', // violet — large/expensive models
  idle: '#334155', // slate — core at rest
};

// Phases that mean the op is no longer in flight.
const TERMINAL_PHASES = new Set(['complete', 'error']);

// Best-effort model-tier classification from the model name. The `ai:status` event has no
// explicit tier, so we pattern-match common families. Unknown models fall to `medium`.
export function modelTier(model) {
  if (!model || typeof model !== 'string') return 'medium';
  const m = model.toLowerCase();
  if (/\b(opus|70b|72b|405b|large|heavy|ultra|max)\b/.test(m) || /:(70|72|405)b/.test(m)) return 'heavy';
  if (/(haiku|mini|flash|lite|light|tiny|small|1\.5b|3b|7b|8b|9b|nano|gemma)/.test(m)) return 'light';
  return 'medium';
}

export function tierColor(tier) {
  return TIER_COLORS[tier] || TIER_COLORS.medium;
}

// Rank tiers so the core can pick the "loudest" active tier when several ops overlap.
const TIER_RANK = { light: 1, medium: 2, heavy: 3 };

// Apply one `ai:status` event to the in-flight op map (plain object keyed by op id),
// returning a NEW object. Terminal phases remove the op; every other phase adds/updates
// it with the event's model + a last-seen timestamp. Entries older than `opMaxAgeMs` are
// pruned so a never-completed op can't wedge the core busy. Pure — `now` is injected.
export function applyAiStatusEvent(ops, event, now = Date.now()) {
  const next = {};
  // Prune stale ops first.
  for (const [id, op] of Object.entries(ops || {})) {
    if (now - op.ts <= AI_CORE.opMaxAgeMs) next[id] = op;
  }
  const id = event?.id;
  if (!id) return next;
  if (TERMINAL_PHASES.has(event.phase)) {
    delete next[id];
    return next;
  }
  next[id] = { id, model: event.model || null, tier: modelTier(event.model), ts: now };
  return next;
}

// Derive the core's view-model from the in-flight op map. `lastStartTs` (the timestamp of
// the most recent op start) drives a brief flare; `now` is injected for determinism.
export function computeAiCore(ops, lastStartTs = 0, now = Date.now()) {
  const active = Object.values(ops || {}).filter(op => now - op.ts <= AI_CORE.opMaxAgeMs);
  const activeCount = active.length;
  const busy = activeCount > 0;
  // Loudest active tier wins the color; idle when nothing is in flight.
  const tier = busy
    ? active.reduce((hi, op) => (TIER_RANK[op.tier] > TIER_RANK[hi] ? op.tier : hi), 'light')
    : 'idle';
  const flaring = lastStartTs > 0 && now - lastStartTs <= AI_CORE.flareMs;
  return {
    position: AI_CORE.position,
    height: AI_CORE.height,
    apexY: AI_CORE.apexY,
    activeCount,
    busy,
    tier,
    color: busy ? tierColor(tier) : TIER_COLORS.idle,
    // Beam count tracks concurrency, capped; at least one beam while flaring even if the
    // op already cleared (so a fast call still produces a visible pulse).
    beamCount: Math.min(Math.max(activeCount, flaring ? 1 : 0), AI_CORE.maxBeams),
    flaring,
    // Idle core breathes faintly; busy core glows; a flare spikes intensity briefly.
    intensity: busy ? 0.7 + Math.min(activeCount, 4) * 0.075 : flaring ? 0.6 : 0.25,
  };
}
