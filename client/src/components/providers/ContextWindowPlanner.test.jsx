import { describe, expect, it } from 'vitest';
import { withRecommendedWindows } from './ContextWindowPlanner';

describe('withRecommendedWindows', () => {
  it('fills each planned model with its best fit and keeps other lines', () => {
    const text = 'custom-model = 4096\nold = 8192';
    const plans = [{ modelId: 'old', recommended: 262144 }, { modelId: 'long', recommended: 1048576 }, { modelId: 'none', recommended: null }];
    expect(withRecommendedWindows(text, plans)).toBe('custom-model = 4096\nold = 262144\nlong = 1048576');
  });
});
