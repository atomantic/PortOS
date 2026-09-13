import { describe, it, expect } from 'vitest';
import {
  PREFLIGHT_PHASES,
  applyPreflightStep,
  createPreflightState,
  finalizePreflight,
  preflightHeadline,
  preflightStepPlan,
} from './preflightPlan.js';

const keys = (preflight) => preflight.steps.map((step) => `${step.key}:${step.status}`);

describe('preflightPlan', () => {
  it('names pr-reviewer\'s real checks, and falls back to a generic plan for other types', () => {
    expect(preflightStepPlan('pr-reviewer').map((step) => step.key))
      .toEqual(['queued', 'cadence', 'list-prs', 'in-flight', 'security-scan', 'snapshot', 'dispatch']);
    expect(preflightStepPlan('code-quality').map((step) => step.key)).toEqual(['queued', 'prepare', 'dispatch']);
  });

  it('opens already waiting, so the card means something the instant the request is queued', () => {
    const state = createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer' });
    expect(state.phase).toBe(PREFLIGHT_PHASES.QUEUED);
    expect(state.steps[0]).toMatchObject({ key: 'queued', status: 'active' });
    expect(preflightHeadline(state)).toBe('Waiting for a free task slot');
  });

  it('closes every earlier unfinished step when a later one starts', () => {
    const state = createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer' });
    const scanning = applyPreflightStep(state, 'security-scan', { detail: 'Screening 2 pull requests' });
    expect(keys(scanning)).toEqual([
      'queued:done', 'cadence:done', 'list-prs:done', 'in-flight:done',
      'security-scan:active', 'snapshot:pending', 'dispatch:pending',
    ]);
    expect(preflightHeadline(scanning)).toBe('Screening PR content for hidden Unicode and prompt injection');
    expect(scanning.steps[4].detail).toBe('Screening 2 pull requests');
  });

  it('ignores a step key the plan does not declare, so a card cannot claim work the preflight never does', () => {
    const state = createPreflightState({ requestId: 'demand-1', taskType: 'pr-reviewer' });
    expect(applyPreflightStep(state, 'invent-a-check')).toBe(state);
    expect(applyPreflightStep(state, 'cadence', { status: 'bogus' })).toBe(state);
  });

  it('marks unreached steps skipped on a close, so a finished card never renders as still working', () => {
    const state = applyPreflightStep(createPreflightState({ requestId: 'd', taskType: 'pr-reviewer' }), 'list-prs');
    const closed = finalizePreflight(state, { outcome: 'nothing-to-do', reason: 'no-external-open-prs' });
    expect(closed.phase).toBe(PREFLIGHT_PHASES.DONE);
    expect(keys(closed)).toEqual([
      'queued:done', 'cadence:done', 'list-prs:done', 'in-flight:skipped',
      'security-scan:skipped', 'snapshot:skipped', 'dispatch:skipped',
    ]);
    expect(preflightHeadline(closed)).toBe('Preflight found nothing to do');
  });

  it('fails the step that was running, and reports its reason', () => {
    const state = applyPreflightStep(createPreflightState({ requestId: 'd', taskType: 'pr-reviewer' }), 'security-scan');
    const closed = finalizePreflight(state, { outcome: 'failed', reason: 'security-guard-unavailable' });
    expect(closed.phase).toBe(PREFLIGHT_PHASES.FAILED);
    expect(closed.steps.find((step) => step.key === 'security-scan')).toMatchObject({
      status: 'failed', detail: 'security-guard-unavailable',
    });
    expect(preflightHeadline(closed)).toBe('Preflight failed: security-guard-unavailable');
  });

  it('keeps the FIRST close: a generic drain sweep must not overwrite the specific reason', () => {
    const failed = finalizePreflight(
      applyPreflightStep(createPreflightState({ requestId: 'd', taskType: 'pr-reviewer' }), 'security-scan'),
      { outcome: 'failed', reason: 'security-guard-unavailable' },
    );
    expect(finalizePreflight(failed, { outcome: 'nothing-to-do', reason: 'idle' })).toBe(failed);
  });

  it('refuses to advance a closed card', () => {
    const closed = finalizePreflight(createPreflightState({ requestId: 'd', taskType: 'pr-reviewer' }), { outcome: 'handed-off' });
    expect(applyPreflightStep(closed, 'security-scan')).toBe(closed);
  });

  it('distinguishes a hand-off from work that never needed an agent', () => {
    const base = createPreflightState({ requestId: 'd', taskType: 'pr-reviewer' });
    expect(preflightHeadline(finalizePreflight(base, { outcome: 'handed-off', resultTaskId: 't-1' })))
      .toBe('Preflight passed — agent started');
    expect(preflightHeadline(finalizePreflight(base, { outcome: 'programmatic' }))).toBe('Completed without an agent');
    expect(preflightHeadline(finalizePreflight(base, { outcome: 'interrupted' })))
      .toBe('Preflight interrupted by a server restart');
  });
});
