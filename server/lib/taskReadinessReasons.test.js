import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TASK_READINESS_REASON, TASK_READINESS_REASONS, TASK_READINESS_REASON_SET } from './taskReadinessReasons.js';

const service = readFileSync(new URL('../services/taskSchedule.js', import.meta.url), 'utf8');
const readiness = service.split('async function evaluateTaskReadiness(')[1]?.split('\n/**')[0];

describe('scheduled-task readiness wire reasons', () => {
  it('keeps the emitted set equal to the declared wire enum', () => {
    expect(readiness).toBeTruthy();
    expect(readiness).not.toMatch(/reason:\s*['"]/);
    const emittedKeys = [...readiness.matchAll(/reason:\s*TASK_READINESS_REASON\.([A-Z_]+)/g)].map(match => match[1]);
    expect(new Set(emittedKeys)).toEqual(new Set(Object.keys(TASK_READINESS_REASON)));
    expect(new Set(TASK_READINESS_REASONS)).toEqual(TASK_READINESS_REASON_SET);
  });
});
