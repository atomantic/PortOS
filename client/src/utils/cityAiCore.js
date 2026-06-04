// Pure, deterministic helpers for CyberCity's AI Core landmark (roadmap 2.1): a central
// spire above downtown from which all model activity radiates. The server broadcasts
// phase-tagged `ai:status` events (start → model:loading → model:loaded → complete/error)
// for every LLM/model call; this module tracks the in-flight set and derives the core's
// glow/beam state. No three.js / React imports so the logic is unit-testable (mirrors
// cityBackupVault.js).
//
// When a call originates on behalf of a managed app or CoS-agent workspace, the event
// carries `appId` / `workspacePath`; `computeAiCoreBeams` maps that to the building's world
// position and aims the beam there, scaling its thickness by the call's tokens/sec. Ops
// with no building association (most PortOS-internal calls — taste summaries, embeddings)
// keep the generic radial fan-out. Model tier is a best-effort heuristic from the model
// name (the event has no explicit tier).

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
  // How long a just-completed op lingers as an "afterglow" beam. The provider only reports
  // token throughput on the completion event (which ends the op), so this window is what
  // lets a measured tokens/sec actually thicken a beam before it fades — without it, every
  // beam would render at the base thickness.
  afterglowMs: 1500,
  // Generic (un-targeted) radial beam length, in world units.
  radialLength: 16,
  // Beam thickness clamps (world units). Un-measured ops use `beamThicknessBase`;
  // measured throughput scales between base and max across `beamThicknessTopTokensPerSec`.
  beamThicknessBase: 0.18,
  beamThicknessMax: 0.6,
  beamThicknessTopTokensPerSec: 200,
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

// Coerce a finite, non-negative tokens/sec from an event; otherwise null ("unknown").
// Keeps "the provider didn't report usage" distinct from a measured zero. Only an actual
// number counts — `null`/`undefined`/`''` (which `Number()` would coerce to 0/NaN) are
// "unknown", per the sentinel-vs-empty convention.
function readTokensPerSec(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// True while an op should still draw a beam: in flight (within opMaxAgeMs), or just
// completed and within its afterglow window. `done` ops keep their last `ts` and are timed
// against `afterglowMs` so a measured tokens/sec gets a moment to thicken its beam.
function opWithinWindow(op, now) {
  const age = now - op.ts;
  return op.done ? age <= AI_CORE.afterglowMs : age <= AI_CORE.opMaxAgeMs;
}

// Apply one `ai:status` event to the in-flight op map (plain object keyed by op id),
// returning a NEW object. A terminal phase (complete/error) doesn't drop the op outright:
// if it reported token throughput, the op is kept briefly as a `done` afterglow entry (so
// the measured tokens/sec can size its beam — throughput only arrives at completion); a
// terminal phase with no throughput drops the op immediately. Every other phase adds/updates
// it with the event's model, building association (`appId`/`workspacePath`), last-known
// tokens/sec, and a last-seen timestamp. Entries past their window are pruned so a
// never-completed op can't wedge the core busy. Pure — `now` is injected.
export function applyAiStatusEvent(ops, event, now = Date.now()) {
  const next = {};
  // Prune ops past their (in-flight or afterglow) window first.
  for (const [id, op] of Object.entries(ops || {})) {
    if (opWithinWindow(op, now)) next[id] = op;
  }
  const id = event?.id;
  if (!id) return next;
  const prev = next[id] || {};
  const tokensPerSec = readTokensPerSec(event.tokensPerSec) ?? prev.tokensPerSec ?? null;
  if (TERMINAL_PHASES.has(event.phase)) {
    // Drop immediately when there's nothing to show; otherwise keep a short afterglow so
    // the just-measured throughput visibly thickens the beam before it fades. Re-read the
    // association from the event (every phase event carries it) — the in-flight entry may
    // have been pruned at opMaxAgeMs on a long call, so falling back to `prev` alone would
    // lose the building target.
    if (tokensPerSec === null) {
      delete next[id];
      return next;
    }
    next[id] = {
      id,
      done: true,
      model: event.model || prev.model || null,
      tier: modelTier(event.model || prev.model),
      appId: event.appId ?? prev.appId ?? null,
      workspacePath: event.workspacePath ?? prev.workspacePath ?? null,
      tokensPerSec,
      ts: now,
    };
    return next;
  }
  next[id] = {
    id,
    done: false,
    model: event.model || prev.model || null,
    tier: modelTier(event.model || prev.model),
    // Association is stamped at start; carry it forward across intermediate phases even if
    // a later event omits it.
    appId: event.appId ?? prev.appId ?? null,
    workspacePath: event.workspacePath ?? prev.workspacePath ?? null,
    // Throughput typically only arrives on later phases; keep the last measured value.
    tokensPerSec,
    ts: now,
  };
  return next;
}

// True when `child` is `parent` itself or a path nested under it — a boundary-aware check so
// `/repos/app` does NOT match the sibling `/repos/app-other`. Compares on a trailing-slash
// normalized form. Pure.
function isPathUnder(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const base = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(base);
}

// Drop every op past its window (in-flight or afterglow). Returns the SAME reference when
// nothing changed so callers can skip a no-op state update; otherwise a new pruned object.
// Used by a one-shot timer so a `done`/flare beam fades on schedule even when no further
// `ai:status` event arrives to trigger the reducer. Pure.
export function pruneAiOps(ops, now = Date.now()) {
  const entries = Object.entries(ops || {});
  const kept = entries.filter(([, op]) => opWithinWindow(op, now));
  if (kept.length === entries.length) return ops;
  return Object.fromEntries(kept);
}

// Map an op's building association to an app id. Prefers an explicit `appId`; otherwise
// matches the app whose `repoPath` is the longest path-boundary prefix of the op's
// `workspacePath` (a CoS-agent worktree lives under its app's repo). Returns null when
// nothing matches. Pure.
export function resolveOpAppId(op, apps = []) {
  if (op?.appId) return op.appId;
  const wp = op?.workspacePath;
  if (!wp || !Array.isArray(apps)) return null;
  let best = null;
  let bestLen = -1;
  for (const app of apps) {
    if (app?.repoPath && isPathUnder(wp, app.repoPath) && app.repoPath.length > bestLen) {
      best = app.id;
      bestLen = app.repoPath.length;
    }
  }
  return best;
}

// Map measured tokens/sec to a beam thickness, clamped between base and max. A null/unknown
// throughput renders at the base thickness so an un-instrumented call still draws a beam.
export function beamThickness(tokensPerSec) {
  const base = AI_CORE.beamThicknessBase;
  const max = AI_CORE.beamThicknessMax;
  const tps = readTokensPerSec(tokensPerSec);
  if (tps === null) return base;
  const frac = Math.min(tps / AI_CORE.beamThicknessTopTokensPerSec, 1);
  return base + (max - base) * frac;
}

// Derive the core's view-model from the in-flight op map. `lastStartTs` (the timestamp of
// the most recent op start) drives a brief flare; `now` is injected for determinism.
export function computeAiCore(ops, lastStartTs = 0, now = Date.now()) {
  // Only in-flight ops count toward "busy"/concurrency; `done` afterglow ops still draw a
  // beam (see computeAiCoreBeams) but the call is finished, so they don't inflate the count.
  const active = Object.values(ops || {}).filter(op => !op.done && now - op.ts <= AI_CORE.opMaxAgeMs);
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

// Build the per-beam descriptors the renderer draws from the apex. Each op still within its
// window (in flight, or completed within the afterglow) becomes one beam: if it resolves to
// a building whose world position is known, the beam is `targeted` and aims at that building
// (in apex-local space); otherwise it falls back to a generic radial beam at an even angle.
// Thickness scales by the op's measured tokens/sec — which is why afterglow ops are kept:
// throughput is only known once the call completes.
//
//   ops       — op map (from applyAiStatusEvent), including afterglow `done` entries
//   positions — Map<appId, { x, z }> of building world positions (CityScene's layout)
//   apps      — app records (for workspacePath → app resolution)
//   apexY     — world Y of the spire apex (beams originate here)
//   color     — fallback color when an op has no tier (e.g. the core's active-tier color)
//   now       — injected for determinism
//
// Returns up to AI_CORE.maxBeams descriptors. Pure.
export function computeAiCoreBeams(ops, positions, apps = [], apexY = AI_CORE.apexY, color, now = Date.now()) {
  const active = Object.values(ops || {})
    .filter(op => opWithinWindow(op, now))
    .slice(0, AI_CORE.maxBeams);

  const getPos = (id) => {
    if (!id || !positions) return null;
    // Tolerate both a Map and a plain object so callers can pass either.
    return typeof positions.get === 'function' ? positions.get(id) : positions[id];
  };

  // Radial fallback angles spread evenly across however many beams we draw, so a mix of
  // targeted + radial beams still reads as a balanced fan.
  const total = Math.max(active.length, 1);

  return active.map((op, i) => {
    const appId = resolveOpAppId(op, apps);
    const pos = getPos(appId);
    const thickness = beamThickness(op.tokensPerSec);
    // Color by the op's own tier so a `done` afterglow beam keeps its tier color even when
    // the core has gone idle (no in-flight op left to set the core color).
    const beamColor = op.tier ? tierColor(op.tier) : color;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
      // Apex-local target: building roof-ish height so the beam arcs down to the building.
      return {
        key: op.id,
        targeted: true,
        appId,
        // Vector from the apex (group origin) to the building, in apex-local space.
        target: [pos.x, -apexY + 4, pos.z],
        thickness,
        color: beamColor,
      };
    }
    return {
      key: op.id,
      targeted: false,
      angle: (i / total) * Math.PI * 2,
      length: AI_CORE.radialLength,
      thickness,
      color: beamColor,
    };
  });
}
