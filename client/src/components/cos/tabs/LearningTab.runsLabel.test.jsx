import { describe, it, expect } from 'vitest';
import { runsLabel } from './LearningTab';

// Evidence pairing (issue #2617): a recency-windowed rate must be labeled with
// the window's own sample count, never the lifetime total — "0% across 200
// attempts" for a 6-sample windowed rate overstates the evidence.
describe('LearningTab runsLabel', () => {
  it('uses the windowed sample count when the rate came from the recency window', () => {
    expect(runsLabel({ rateSource: 'windowed', windowedCompleted: 6, completed: 200 })).toBe('6 recent runs');
    expect(runsLabel({ rateSource: 'windowed', windowedCompleted: 6, completed: 200 }, 'attempts')).toBe('6 recent attempts');
  });

  it('uses the lifetime count for a lifetime-sourced rate (and for legacy payloads without rateSource)', () => {
    expect(runsLabel({ rateSource: 'lifetime', windowedCompleted: 2, completed: 55 })).toBe('55 runs');
    expect(runsLabel({ completed: 55 }, 'tasks')).toBe('55 tasks');
  });
});
