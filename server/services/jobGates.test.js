import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./brainStorage.js', () => ({
  getInboxLogCounts: vi.fn()
}));

import { checkJobGate, hasGate, getRegisteredGates } from './jobGates.js';
import { getInboxLogCounts } from './brainStorage.js';

describe('jobGates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hasGate', () => {
    it('returns true for registered gate', () => {
      expect(hasGate('job-brain-review')).toBe(true);
    });

    it('returns false for unregistered job', () => {
      expect(hasGate('job-unknown')).toBe(false);
    });
  });

  describe('getRegisteredGates', () => {
    it('returns all registered gate IDs', () => {
      const gates = getRegisteredGates();
      expect(gates).toContain('job-brain-review');
      expect(Array.isArray(gates)).toBe(true);
    });
  });

  describe('checkJobGate', () => {
    it('returns shouldRun:true for jobs without a gate', async () => {
      const result = await checkJobGate('job-no-gate');
      expect(result.shouldRun).toBe(true);
      expect(result.reason).toBe('No gate configured');
    });

    describe('brain-review gate', () => {
      it('returns shouldRun:true when needs_review items exist', async () => {
        getInboxLogCounts.mockResolvedValue({
          total: 10,
          needs_review: 3,
          classifying: 0,
          filed: 7,
          corrected: 0,
          done: 0,
          error: 0
        });

        const result = await checkJobGate('job-brain-review');
        expect(result.shouldRun).toBe(true);
        expect(result.reason).toContain('3 inbox item(s) need review');
        expect(result.context.needsReview).toBe(3);
      });

      it('returns shouldRun:false when no needs_review items', async () => {
        getInboxLogCounts.mockResolvedValue({
          total: 5,
          needs_review: 0,
          classifying: 0,
          filed: 5,
          corrected: 0,
          done: 0,
          error: 0
        });

        const result = await checkJobGate('job-brain-review');
        expect(result.shouldRun).toBe(false);
        expect(result.reason).toBe('No inbox items need review');
      });

      it('returns shouldRun:false when items are still classifying', async () => {
        getInboxLogCounts.mockResolvedValue({
          total: 2,
          needs_review: 0,
          classifying: 2,
          filed: 0,
          corrected: 0,
          done: 0,
          error: 0
        });

        const result = await checkJobGate('job-brain-review');
        expect(result.shouldRun).toBe(false);
        expect(result.reason).toContain('2 item(s) still classifying');
      });
    });
  });
});
