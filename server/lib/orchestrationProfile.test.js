import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ORCHESTRATION_MODE,
  ORCHESTRATION_ROLES,
  isOrchestratedTask,
  normalizeOrchestrationMode,
  normalizeOrchestrationProfile,
  parseReasoningDirective,
  roleAssignment,
} from './orchestrationProfile.js';

const orchestrated = (profile) => ({
  metadata: { orchestrationMode: 'orchestrated', orchestrationProfile: profile },
});

describe('normalizeOrchestrationProfile', () => {
  it('keeps only known roles and only fields that carry a value', () => {
    expect(normalizeOrchestrationProfile({
      architect: { provider: ' claude-code ', model: 'opus', effort: 'high' },
      implementer: { model: 'haiku' },
      reviewer: {},
      saboteur: { model: 'evil' },
    })).toEqual({
      architect: { provider: 'claude-code', model: 'opus', effort: 'high' },
      implementer: { model: 'haiku' },
    });
  });

  it('returns null when nothing usable survives, so an empty profile is never persisted', () => {
    expect(normalizeOrchestrationProfile({ architect: {}, reviewer: { effort: 'nonsense' } })).toBeNull();
    expect(normalizeOrchestrationProfile(null)).toBeNull();
    expect(normalizeOrchestrationProfile('architect')).toBeNull();
  });
});

describe('mode + role gating', () => {
  it('defaults to direct and treats an unknown mode as direct', () => {
    expect(normalizeOrchestrationMode(undefined)).toBe(DEFAULT_ORCHESTRATION_MODE);
    expect(normalizeOrchestrationMode('turbo')).toBe('direct');
  });

  it('is inert without BOTH the orchestrated mode and a usable profile', () => {
    const profile = { architect: { model: 'opus' } };
    expect(isOrchestratedTask({ metadata: { orchestrationProfile: profile } })).toBe(false);
    expect(isOrchestratedTask({ metadata: { orchestrationMode: 'orchestrated' } })).toBe(false);
    expect(isOrchestratedTask(orchestrated(profile))).toBe(true);
  });

  it('returns no assignment for a stored profile the task did not enable', () => {
    const task = { metadata: { orchestrationMode: 'direct', orchestrationProfile: { architect: { model: 'opus' } } } };
    expect(roleAssignment(task, 'architect')).toBeNull();
  });

  it('resolves each configured role and nothing else', () => {
    const task = orchestrated({ architect: { model: 'opus' }, implementer: { model: 'haiku', effort: 'low' } });
    expect(roleAssignment(task, 'architect')).toEqual({ model: 'opus' });
    expect(roleAssignment(task, 'implementer')).toEqual({ model: 'haiku', effort: 'low' });
    expect(roleAssignment(task, 'reviewer')).toBeNull();
    expect(roleAssignment(task, 'saboteur')).toBeNull();
  });
});

describe('reasoning directives', () => {
  it('reads the rung the architect wrote into a spec', () => {
    const spec = 'OBJECTIVE: ship it\nREASONING: xhigh';
    expect(parseReasoningDirective(spec)).toEqual({ rung: 'xhigh' });
  });

  it('errors on an unsupported rung instead of rounding it to a supported one', () => {
    const result = parseReasoningDirective('REASONING: galaxy-brain');
    expect(result.error).toContain('galaxy-brain');
    expect(result.rung).toBeUndefined();
  });

  it('reports absence as null, distinct from an invalid rung', () => {
    expect(parseReasoningDirective('OBJECTIVE: ship it')).toBeNull();
    expect(parseReasoningDirective(undefined)).toBeNull();
  });
});

describe('role vocabulary', () => {
  it('is the plan → build → check triple the doctrine renders', () => {
    expect([...ORCHESTRATION_ROLES]).toEqual(['architect', 'implementer', 'reviewer']);
  });
});
