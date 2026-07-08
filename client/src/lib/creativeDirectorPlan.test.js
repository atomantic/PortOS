import { describe, it, expect } from 'vitest';
import {
  annotatePlanSteps,
  planCostSummary,
  planStatusSummary,
  stepRequiresApproval,
  stepResultLink,
  isDirectiveProject,
  DELIVERABLE_OPTIONS,
} from './creativeDirectorPlan.js';

const toolMap = new Map([
  ['universe_create', { costClass: 'free', longRunning: false, destructive: false }],
  ['story_generateStep', { costClass: 'llm', longRunning: false, destructive: false }],
  ['media_enqueueImage', { costClass: 'render', longRunning: true, destructive: false }],
  ['universe_delete', { costClass: 'free', longRunning: false, destructive: true }],
]);

describe('annotatePlanSteps', () => {
  const steps = [
    { stepId: 'a', toolName: 'universe_create', status: 'done', dependsOn: [] },
    { stepId: 'b', toolName: 'story_generateStep', status: 'running', dependsOn: ['a'] },
    { stepId: 'c', toolName: 'media_enqueueImage', status: 'pending', dependsOn: ['b'] },
    { stepId: 'd', toolName: 'ghost_tool', status: 'pending', dependsOn: [] },
  ];
  const runs = [
    { kind: 'plan-step', stepId: 'a', startedAt: '2026-07-01T00:00:00Z', completedAt: '2026-07-01T00:01:00Z' },
    { kind: 'plan-step', stepId: 'a', startedAt: '2026-07-01T00:05:00Z', completedAt: '2026-07-01T00:06:00Z' },
    { kind: 'plan', stepId: undefined, startedAt: '2026-07-01T00:00:00Z' },
  ];

  it('annotates cost class, longRunning, destructive from the tool map', () => {
    const out = annotatePlanSteps(steps, runs, toolMap, { withinBudget: true });
    expect(out[0]).toMatchObject({ stepId: 'a', costClass: 'free', longRunning: false, destructive: false, unknownTool: false });
    expect(out[2]).toMatchObject({ stepId: 'c', costClass: 'render', longRunning: true });
  });

  it('flags an unknown tool and never auto-approves it', () => {
    const out = annotatePlanSteps(steps, runs, toolMap, { withinBudget: false });
    const ghost = out.find((s) => s.stepId === 'd');
    expect(ghost.unknownTool).toBe(true);
    expect(ghost.costClass).toBeNull();
    expect(ghost.requiresApproval).toBe(false);
  });

  it('attaches the LATEST matching plan-step run timing', () => {
    const out = annotatePlanSteps(steps, runs, toolMap, {});
    expect(out[0].startedAt).toBe('2026-07-01T00:05:00Z');
    expect(out[0].completedAt).toBe('2026-07-01T00:06:00Z');
  });

  it('requires approval for a budgeted step when the budget is exhausted', () => {
    const out = annotatePlanSteps(steps, runs, toolMap, { withinBudget: false });
    expect(out.find((s) => s.stepId === 'b').requiresApproval).toBe(true); // llm, over budget
    expect(out.find((s) => s.stepId === 'c').requiresApproval).toBe(true); // render, over budget
    expect(out.find((s) => s.stepId === 'a').requiresApproval).toBe(false); // free
  });

  it('does not require approval for budgeted steps when within budget', () => {
    const out = annotatePlanSteps(steps, runs, toolMap, { withinBudget: true });
    expect(out.every((s) => s.requiresApproval === false)).toBe(true);
  });

  it('returns [] for a null/undefined step list', () => {
    expect(annotatePlanSteps(undefined, runs, toolMap, {})).toEqual([]);
    expect(annotatePlanSteps(null, null, null, {})).toEqual([]);
  });

  it('accepts a plain object tool map as well as a Map', () => {
    const out = annotatePlanSteps(steps, [], { universe_create: { costClass: 'free' } }, {});
    expect(out[0].costClass).toBe('free');
  });
});

describe('stepRequiresApproval', () => {
  it('is true for destructive tools regardless of budget', () => {
    expect(stepRequiresApproval({ costClass: 'free', destructive: true }, { withinBudget: true })).toBe(true);
  });
  it('is true for budgeted tools only when over budget', () => {
    expect(stepRequiresApproval({ costClass: 'llm' }, { withinBudget: false })).toBe(true);
    expect(stepRequiresApproval({ costClass: 'llm' }, { withinBudget: true })).toBe(false);
  });
  it('is false for missing metadata', () => {
    expect(stepRequiresApproval(null, { withinBudget: false })).toBe(false);
  });
});

describe('planCostSummary / planStatusSummary', () => {
  const annotated = [
    { costClass: 'free', status: 'done' },
    { costClass: 'llm', status: 'running' },
    { costClass: 'llm', status: 'blocked' },
    { costClass: null, status: 'pending' },
  ];
  it('counts cost classes', () => {
    expect(planCostSummary(annotated)).toEqual({ free: 1, llm: 2, render: 0 });
  });
  it('counts statuses', () => {
    expect(planStatusSummary(annotated)).toEqual({ pending: 1, running: 1, blocked: 1, done: 1, failed: 0, skipped: 0 });
  });
});

describe('stepResultLink', () => {
  it('links a series result to the pipeline series route', () => {
    expect(stepResultLink({ toolName: 'pipeline_createSeries', result: { seriesId: 's1' } }))
      .toEqual({ to: '/pipeline/series/s1', label: 'Open series' });
  });
  it('links an issue result', () => {
    expect(stepResultLink({ result: { issueId: 'i1' } })).toEqual({ to: '/pipeline/issues/i1', label: 'Open issue' });
  });
  it('links a universe result', () => {
    expect(stepResultLink({ result: { universeId: 'u1' } })).toEqual({ to: '/universes/u1', label: 'Open universe' });
  });
  it('links a work result', () => {
    expect(stepResultLink({ result: { workId: 'w1' } })).toEqual({ to: '/writers-room/works/w1', label: 'Open work' });
  });
  it('links a minted cd sub-project by id', () => {
    expect(stepResultLink({ toolName: 'cd_produceVideoFromIssue', result: { id: 'cd-9' } }))
      .toEqual({ to: '/media/creative-director/cd-9/overview', label: 'Open project' });
  });
  it('returns null with no linkable result', () => {
    expect(stepResultLink({ result: null })).toBeNull();
    expect(stepResultLink({ result: { planned: true } })).toBeNull();
  });
});

describe('isDirectiveProject / DELIVERABLE_OPTIONS', () => {
  it('detects a directive project', () => {
    expect(isDirectiveProject({ directive: { goal: 'x' } })).toBe(true);
    expect(isDirectiveProject({ directive: null })).toBe(false);
    expect(isDirectiveProject({})).toBe(false);
  });
  it('exposes a stable deliverable menu', () => {
    expect(DELIVERABLE_OPTIONS.map((o) => o.id)).toContain('covers');
    expect(DELIVERABLE_OPTIONS.map((o) => o.id)).toContain('video-teaser');
  });
});
