import { describe, it, expect } from 'vitest';
import {
  AI_CORE,
  modelTier,
  tierColor,
  applyAiStatusEvent,
  computeAiCore,
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
