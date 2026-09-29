import { describe, it, expect } from 'vitest';
import { REJECTION_REASON_LABELS } from './layeredIntelligenceRejectionLabels.js';
import { REJECTION_REASON_VALUES } from '../services/layeredIntelligenceRejections.js';

describe('REJECTION_REASON_LABELS', () => {
  it('glosses every rejection reason the store may hold, and nothing else', () => {
    expect(Object.keys(REJECTION_REASON_LABELS).sort()).toEqual([...REJECTION_REASON_VALUES].sort());
  });
});
