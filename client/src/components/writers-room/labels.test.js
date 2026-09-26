import { describe, it, expect } from 'vitest';
import { WORK_KINDS, WORK_STATUSES } from '../../lib/writersRoomPresets.js';
import { KIND_LABELS, STATUS_LABELS } from './labels.js';

// A kind or status added server-side without a label here would render raw.
describe('Writers Room labels', () => {
  it('has exactly one label per server work kind', () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...WORK_KINDS].sort());
  });

  it('has exactly one label per server work status', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...WORK_STATUSES].sort());
  });
});
