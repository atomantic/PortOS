import { describe, it, expect } from 'vitest';
import {
  AI_CORE,
  modelTier,
  tierColor,
  applyAiStatusEvent,
  computeAiCore,
  resolveOpAppId,
  beamThickness,
  computeAiCoreBeams,
  pruneAiOps,
} from './cityAiCore';

const NOW = 1_000_000;
const ev = (id, phase, model, extra = {}) => ({ id, phase, model, ...extra });

describe('modelTier', () => {
  it('classifies heavy families', () => {
    expect(modelTier('claude-opus-4-8')).toBe('heavy');
    expect(modelTier('llama-3.1-70b')).toBe('heavy');
    expect(modelTier('qwen2.5:72b')).toBe('heavy');
  });
  it('classifies light families', () => {
    expect(modelTier('claude-haiku-4-5')).toBe('light');
    expect(modelTier('gpt-4o-mini')).toBe('light');
    expect(modelTier('gemini-1.5-flash')).toBe('light');
    expect(modelTier('llama-3-8b')).toBe('light');
  });
  it('defaults unknown / missing to medium', () => {
    expect(modelTier('some-unknown-model')).toBe('medium');
    expect(modelTier(undefined)).toBe('medium');
    expect(modelTier(null)).toBe('medium');
    expect(modelTier(42)).toBe('medium');
  });
});

describe('tierColor', () => {
  it('maps tiers to distinct colors and falls back to medium', () => {
    expect(tierColor('light')).toBe('#22d3ee');
    expect(tierColor('medium')).toBe('#3b82f6');
    expect(tierColor('heavy')).toBe('#a855f7');
    expect(tierColor('bogus')).toBe(tierColor('medium'));
  });
});

describe('applyAiStatusEvent', () => {
  it('adds an op on a non-terminal phase', () => {
    const ops = applyAiStatusEvent({}, ev('a', 'start', 'gpt-4o-mini'), NOW);
    expect(Object.keys(ops)).toEqual(['a']);
    expect(ops.a.tier).toBe('light');
    expect(ops.a.ts).toBe(NOW);
  });

  it('keeps the op across intermediate phases, refreshing its timestamp', () => {
    let ops = applyAiStatusEvent({}, ev('a', 'start', 'claude-opus-4-8'), NOW);
    ops = applyAiStatusEvent(ops, ev('a', 'model:loading', 'claude-opus-4-8'), NOW + 500);
    expect(Object.keys(ops)).toEqual(['a']);
    expect(ops.a.ts).toBe(NOW + 500);
    expect(ops.a.tier).toBe('heavy');
  });

  it('removes the op on complete and on error', () => {
    let ops = applyAiStatusEvent({}, ev('a', 'start', 'm'), NOW);
    ops = applyAiStatusEvent(ops, ev('b', 'start', 'm'), NOW);
    ops = applyAiStatusEvent(ops, ev('a', 'complete', 'm'), NOW + 1);
    expect(Object.keys(ops)).toEqual(['b']);
    ops = applyAiStatusEvent(ops, ev('b', 'error', 'm'), NOW + 2);
    expect(Object.keys(ops)).toEqual([]);
  });

  it('prunes ops older than opMaxAgeMs', () => {
    let ops = applyAiStatusEvent({}, ev('old', 'start', 'm'), NOW);
    // A later event prunes the stale 'old' op while adding the new one.
    ops = applyAiStatusEvent(ops, ev('new', 'start', 'm'), NOW + AI_CORE.opMaxAgeMs + 1);
    expect(Object.keys(ops)).toEqual(['new']);
  });

  it('ignores an event with no id but still prunes', () => {
    let ops = applyAiStatusEvent({}, ev('old', 'start', 'm'), NOW);
    ops = applyAiStatusEvent(ops, { phase: 'start', model: 'm' }, NOW + AI_CORE.opMaxAgeMs + 1);
    expect(Object.keys(ops)).toEqual([]);
  });

  it('returns a new object (no mutation of the input)', () => {
    const input = {};
    const out = applyAiStatusEvent(input, ev('a', 'start', 'm'), NOW);
    expect(out).not.toBe(input);
    expect(Object.keys(input)).toEqual([]);
  });
});

describe('computeAiCore', () => {
  it('is idle with no ops', () => {
    const vm = computeAiCore({}, 0, NOW);
    expect(vm.busy).toBe(false);
    expect(vm.activeCount).toBe(0);
    expect(vm.tier).toBe('idle');
    expect(vm.color).toBe('#334155');
    expect(vm.beamCount).toBe(0);
    expect(vm.intensity).toBe(0.25);
    expect(vm.position).toEqual(AI_CORE.position);
  });

  it('glows with the loudest active tier when ops overlap', () => {
    const ops = {
      a: { id: 'a', tier: 'light', ts: NOW },
      b: { id: 'b', tier: 'heavy', ts: NOW },
      c: { id: 'c', tier: 'medium', ts: NOW },
    };
    const vm = computeAiCore(ops, NOW, NOW);
    expect(vm.busy).toBe(true);
    expect(vm.activeCount).toBe(3);
    expect(vm.tier).toBe('heavy');
    expect(vm.color).toBe('#a855f7');
    expect(vm.beamCount).toBe(3);
  });

  it('caps beam count at maxBeams', () => {
    const ops = {};
    for (let i = 0; i < AI_CORE.maxBeams + 5; i++) ops[i] = { id: String(i), tier: 'medium', ts: NOW };
    const vm = computeAiCore(ops, NOW, NOW);
    expect(vm.activeCount).toBe(AI_CORE.maxBeams + 5);
    expect(vm.beamCount).toBe(AI_CORE.maxBeams);
  });

  it('ignores stale ops past opMaxAgeMs', () => {
    const ops = { a: { id: 'a', tier: 'heavy', ts: NOW } };
    const vm = computeAiCore(ops, 0, NOW + AI_CORE.opMaxAgeMs + 1);
    expect(vm.busy).toBe(false);
    expect(vm.activeCount).toBe(0);
  });

  it('flares briefly after a start even once the op has cleared', () => {
    const vm = computeAiCore({}, NOW, NOW + 200);
    expect(vm.busy).toBe(false);
    expect(vm.flaring).toBe(true);
    expect(vm.beamCount).toBe(1); // a fast call still pulses
    expect(vm.intensity).toBe(0.6);
  });

  it('stops flaring after flareMs', () => {
    const vm = computeAiCore({}, NOW, NOW + AI_CORE.flareMs + 1);
    expect(vm.flaring).toBe(false);
    expect(vm.beamCount).toBe(0);
  });
});

describe('applyAiStatusEvent building association', () => {
  it('stamps appId / workspacePath / tokensPerSec from the event', () => {
    const ops = applyAiStatusEvent({}, ev('a', 'start', 'gpt-4o', { appId: 'app-1', workspacePath: '/r/x', tokensPerSec: 90 }), NOW);
    expect(ops.a.appId).toBe('app-1');
    expect(ops.a.workspacePath).toBe('/r/x');
    expect(ops.a.tokensPerSec).toBe(90);
  });

  it('carries association forward when a later phase omits it', () => {
    let ops = applyAiStatusEvent({}, ev('a', 'start', 'm', { appId: 'app-1' }), NOW);
    ops = applyAiStatusEvent(ops, ev('a', 'model:loading', 'm'), NOW + 100);
    expect(ops.a.appId).toBe('app-1');
  });

  it('updates tokensPerSec when a later phase reports it, keeping last-known otherwise', () => {
    let ops = applyAiStatusEvent({}, ev('a', 'start', 'm'), NOW);
    expect(ops.a.tokensPerSec).toBeNull();
    ops = applyAiStatusEvent(ops, ev('a', 'provider:starting', 'm', { tokensPerSec: 150 }), NOW + 10);
    expect(ops.a.tokensPerSec).toBe(150);
    ops = applyAiStatusEvent(ops, ev('a', 'provider:starting', 'm'), NOW + 20);
    expect(ops.a.tokensPerSec).toBe(150); // preserved
  });

  it('drops a terminal op with no throughput immediately', () => {
    let ops = applyAiStatusEvent({}, ev('a', 'start', 'm', { appId: 'app-1' }), NOW);
    ops = applyAiStatusEvent(ops, ev('a', 'complete', 'm'), NOW + 1);
    expect(Object.keys(ops)).toEqual([]);
  });

  it('keeps a completed op as a done afterglow when it reported throughput', () => {
    let ops = applyAiStatusEvent({}, ev('a', 'start', 'm', { appId: 'app-1' }), NOW);
    ops = applyAiStatusEvent(ops, ev('a', 'complete', 'm', { tokens: 200, tokensPerSec: 80 }), NOW + 5);
    expect(ops.a.done).toBe(true);
    expect(ops.a.tokensPerSec).toBe(80);
    expect(ops.a.appId).toBe('app-1'); // association carried onto the afterglow
  });

  it('reads the association from the completion event when the in-flight op was already pruned', () => {
    // A long call (300s) whose in-flight entry was pruned at opMaxAgeMs (60s); the completion
    // event still carries appId, so the afterglow must target the building, not go radial.
    const completeEvent = ev('a', 'complete', 'm', { appId: 'app-9', workspacePath: '/r/x', tokensPerSec: 40 });
    const ops = applyAiStatusEvent({}, completeEvent, NOW); // empty prior map → no prev
    expect(ops.a.done).toBe(true);
    expect(ops.a.appId).toBe('app-9');
    expect(ops.a.workspacePath).toBe('/r/x');
  });

  it('prunes a done afterglow op once afterglowMs has passed', () => {
    let ops = applyAiStatusEvent({}, ev('a', 'start', 'm'), NOW);
    ops = applyAiStatusEvent(ops, ev('a', 'complete', 'm', { tokensPerSec: 80 }), NOW + 5);
    // A later event past the afterglow window prunes the done op.
    ops = applyAiStatusEvent(ops, ev('b', 'start', 'm'), NOW + 5 + AI_CORE.afterglowMs + 1);
    expect(Object.keys(ops)).toEqual(['b']);
  });
});

describe('resolveOpAppId', () => {
  const apps = [
    { id: 'outer', repoPath: '/repos/proj' },
    { id: 'inner', repoPath: '/repos/proj/packages/web' },
  ];
  it('prefers an explicit appId', () => {
    expect(resolveOpAppId({ appId: 'x', workspacePath: '/repos/proj' }, apps)).toBe('x');
  });
  it('matches the longest repoPath prefix of workspacePath', () => {
    expect(resolveOpAppId({ workspacePath: '/repos/proj/packages/web/src' }, apps)).toBe('inner');
    expect(resolveOpAppId({ workspacePath: '/repos/proj/docs' }, apps)).toBe('outer');
    expect(resolveOpAppId({ workspacePath: '/repos/proj' }, apps)).toBe('outer'); // exact match
  });
  it('does not match a sibling path that merely shares a prefix', () => {
    // /repos/proj-other is NOT under /repos/proj — boundary-aware, not raw startsWith.
    expect(resolveOpAppId({ workspacePath: '/repos/proj-other/src' }, apps)).toBeNull();
  });
  it('returns null when nothing matches', () => {
    expect(resolveOpAppId({ workspacePath: '/elsewhere' }, apps)).toBeNull();
    expect(resolveOpAppId({}, apps)).toBeNull();
    expect(resolveOpAppId(null, apps)).toBeNull();
  });
});

describe('readTokensPerSec sentinel (via afterglow retention)', () => {
  it('treats null / empty-string throughput as unknown, not a measured zero', () => {
    // A terminal event with no real throughput must drop the op (unknown), not keep it as
    // a zero-throughput afterglow.
    let ops = applyAiStatusEvent({}, ev('a', 'start', 'm'), NOW);
    ops = applyAiStatusEvent(ops, ev('a', 'complete', 'm', { tokensPerSec: null }), NOW + 1);
    expect(Object.keys(ops)).toEqual([]);
    ops = applyAiStatusEvent({}, ev('b', 'start', 'm'), NOW);
    ops = applyAiStatusEvent(ops, ev('b', 'complete', 'm', { tokensPerSec: '' }), NOW + 1);
    expect(Object.keys(ops)).toEqual([]);
  });
  it('keeps a genuine zero-throughput afterglow distinct from unknown', () => {
    let ops = applyAiStatusEvent({}, ev('a', 'start', 'm'), NOW);
    ops = applyAiStatusEvent(ops, ev('a', 'complete', 'm', { tokensPerSec: 0 }), NOW + 1);
    expect(ops.a?.done).toBe(true);
    expect(ops.a.tokensPerSec).toBe(0);
  });
});

describe('pruneAiOps', () => {
  it('returns the same reference when nothing expired', () => {
    const ops = { a: { id: 'a', ts: NOW } };
    expect(pruneAiOps(ops, NOW)).toBe(ops);
  });
  it('drops expired in-flight and afterglow ops', () => {
    const ops = {
      live: { id: 'live', ts: NOW },
      stale: { id: 'stale', ts: NOW - AI_CORE.opMaxAgeMs - 1 },
      glow: { id: 'glow', done: true, ts: NOW - AI_CORE.afterglowMs - 1 },
    };
    const pruned = pruneAiOps(ops, NOW);
    expect(Object.keys(pruned)).toEqual(['live']);
  });
});

describe('beamThickness', () => {
  it('renders base thickness for unknown / null throughput', () => {
    expect(beamThickness(null)).toBe(AI_CORE.beamThicknessBase);
    expect(beamThickness(undefined)).toBe(AI_CORE.beamThicknessBase);
    expect(beamThickness('nope')).toBe(AI_CORE.beamThicknessBase);
  });
  it('scales toward max with throughput and clamps at the top', () => {
    expect(beamThickness(0)).toBe(AI_CORE.beamThicknessBase);
    expect(beamThickness(AI_CORE.beamThicknessTopTokensPerSec)).toBe(AI_CORE.beamThicknessMax);
    expect(beamThickness(AI_CORE.beamThicknessTopTokensPerSec * 10)).toBe(AI_CORE.beamThicknessMax);
    const mid = beamThickness(AI_CORE.beamThicknessTopTokensPerSec / 2);
    expect(mid).toBeGreaterThan(AI_CORE.beamThicknessBase);
    expect(mid).toBeLessThan(AI_CORE.beamThicknessMax);
  });
});

describe('computeAiCoreBeams', () => {
  const apps = [{ id: 'app-1', repoPath: '/repos/one' }];
  const positions = new Map([['app-1', { x: 10, z: -6, district: 'downtown' }]]);

  it('targets the building for an app-associated op (apex-local target vector)', () => {
    const ops = { a: { id: 'a', appId: 'app-1', tokensPerSec: 200, ts: NOW } };
    const beams = computeAiCoreBeams(ops, positions, apps, AI_CORE.apexY, '#fff', NOW);
    expect(beams).toHaveLength(1);
    expect(beams[0].targeted).toBe(true);
    expect(beams[0].appId).toBe('app-1');
    expect(beams[0].target).toEqual([10, -AI_CORE.apexY + 4, -6]);
    expect(beams[0].thickness).toBe(AI_CORE.beamThicknessMax); // 200 tok/s → max
  });

  it('resolves a workspacePath op to its app building', () => {
    const ops = { a: { id: 'a', workspacePath: '/repos/one/worktrees/x', ts: NOW } };
    const beams = computeAiCoreBeams(ops, positions, apps, AI_CORE.apexY, '#fff', NOW);
    expect(beams[0].targeted).toBe(true);
    expect(beams[0].appId).toBe('app-1');
  });

  it('falls back to a radial beam when there is no building association', () => {
    const ops = { a: { id: 'a', ts: NOW }, b: { id: 'b', appId: 'unknown', ts: NOW } };
    const beams = computeAiCoreBeams(ops, positions, apps, AI_CORE.apexY, '#fff', NOW);
    expect(beams).toHaveLength(2);
    expect(beams.every(b => !b.targeted)).toBe(true);
    expect(beams[0]).toMatchObject({ angle: 0, length: AI_CORE.radialLength });
  });

  it('accepts a plain-object position map and caps at maxBeams', () => {
    const ops = {};
    for (let i = 0; i < AI_CORE.maxBeams + 4; i++) ops[i] = { id: String(i), ts: NOW };
    const beams = computeAiCoreBeams(ops, {}, apps, AI_CORE.apexY, '#fff', NOW);
    expect(beams).toHaveLength(AI_CORE.maxBeams);
  });

  it('ignores stale ops past opMaxAgeMs', () => {
    const ops = { a: { id: 'a', appId: 'app-1', ts: NOW } };
    const beams = computeAiCoreBeams(ops, positions, apps, AI_CORE.apexY, '#fff', NOW + AI_CORE.opMaxAgeMs + 1);
    expect(beams).toHaveLength(0);
  });

  it('colors each beam by its own tier, falling back to the passed color when tier is absent', () => {
    const ops = {
      a: { id: 'a', appId: 'app-1', tier: 'heavy', ts: NOW },
      b: { id: 'b', tier: 'light', ts: NOW }, // radial
      c: { id: 'c', ts: NOW }, // no tier → fallback color
    };
    const beams = computeAiCoreBeams(ops, positions, apps, AI_CORE.apexY, '#fallback', NOW);
    const byKey = Object.fromEntries(beams.map(b => [b.key, b]));
    expect(byKey.a.color).toBe(tierColor('heavy'));
    expect(byKey.b.color).toBe(tierColor('light'));
    expect(byKey.c.color).toBe('#fallback');
  });

  it('draws a done afterglow op with its measured thickness, then drops it after afterglowMs', () => {
    const ops = { a: { id: 'a', appId: 'app-1', done: true, tokensPerSec: 200, ts: NOW } };
    const within = computeAiCoreBeams(ops, positions, apps, AI_CORE.apexY, '#fff', NOW + AI_CORE.afterglowMs - 1);
    expect(within).toHaveLength(1);
    expect(within[0].targeted).toBe(true);
    expect(within[0].thickness).toBe(AI_CORE.beamThicknessMax);
    const after = computeAiCoreBeams(ops, positions, apps, AI_CORE.apexY, '#fff', NOW + AI_CORE.afterglowMs + 1);
    expect(after).toHaveLength(0);
  });
});

describe('computeAiCore with afterglow ops', () => {
  it('does not count a done afterglow op toward busy/activeCount', () => {
    const ops = {
      a: { id: 'a', tier: 'heavy', ts: NOW }, // in flight
      b: { id: 'b', tier: 'light', done: true, tokensPerSec: 50, ts: NOW }, // afterglow
    };
    const vm = computeAiCore(ops, 0, NOW);
    expect(vm.activeCount).toBe(1);
    expect(vm.busy).toBe(true);
    expect(vm.tier).toBe('heavy');
  });

  it('reads idle when only done afterglow ops remain', () => {
    const ops = { b: { id: 'b', tier: 'light', done: true, tokensPerSec: 50, ts: NOW } };
    const vm = computeAiCore(ops, 0, NOW);
    expect(vm.busy).toBe(false);
    expect(vm.activeCount).toBe(0);
  });
});
