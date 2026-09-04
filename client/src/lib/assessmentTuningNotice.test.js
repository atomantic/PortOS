// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { tuningNoticeChip } from './assessmentTuningNotice';

describe('tuningNoticeChip', () => {
  it('says nothing for a reading whose configuration took effect', () => {
    expect(tuningNoticeChip({ tuningApplied: true, tuningKey: 'ubatchSize=512' })).toBeNull();
  });

  // `null` is "there was nothing to apply" — the daemon is at backend defaults
  // and the row is accurate, so a warning here would be noise.
  it('says nothing when there was nothing to apply', () => {
    expect(tuningNoticeChip({ tuningApplied: null, tuningKey: '' })).toBeNull();
  });

  it('names the requested tuning as unapplied for a tuned run', () => {
    expect(tuningNoticeChip({ tuningApplied: false, tuningKey: 'ubatchSize=512' })).toBe('tuning not applied');
  });

  // The untuned row already reads "backend defaults". "Tuning was not applied"
  // there contradicts the label instead of explaining it — the failure is that
  // the daemon could not be put BACK on defaults.
  it('names the leftover tuning for an untuned run that could not be cleared', () => {
    expect(tuningNoticeChip({ tuningApplied: false, tuningKey: '' })).toBe('not at defaults');
  });

  // The chip is a table's only room, so it must appear even when the manager
  // gave no reason — otherwise a suspect row reads as a clean one.
  it('still chips a failed application that recorded no reason', () => {
    expect(tuningNoticeChip({ tuningApplied: false, tuningKey: '', tuningNotApplied: null })).toBe('not at defaults');
  });
});
