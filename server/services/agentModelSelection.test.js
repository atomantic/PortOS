import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the learning store so we control what suggestModelTier returns; keep
// thinkingLevels real so getModelForLevel/isLocalPreferred resolution is exercised.
vi.mock('./taskLearning.js', () => ({
  suggestModelTier: vi.fn()
}));

import { selectModelForTask } from './agentModelSelection.js';
import { suggestModelTier } from './taskLearning.js';

const PROVIDER = {
  defaultModel: 'default-model',
  mediumModel: 'medium-model',
  heavyModel: 'heavy-model',
  lightModel: 'light-model'
};

// A description that matches none of the heuristic branches (image/critical/
// complex/long-context/documentation), with no priority or thinking metadata
// so resolveThinkingLevel resolves "from default" and selection falls through
// to the learning path rather than the thinking-level early return.
const benignTask = { description: 'organize the weekly digest', taskType: 'user' };

describe('selectModelForTask — learning-suggested tier resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('honors a literal-tier suggestion via the static map', async () => {
    suggestModelTier.mockResolvedValue({ suggested: 'light', reason: 'r' });
    const result = await selectModelForTask(benignTask, PROVIDER);
    expect(result.model).toBe('light-model');
    expect(result.tier).toBe('light');
    expect(result.reason).toBe('learning-suggested');
  });

  it('resolves a thinking-level suggestion (high) through getModelForLevel instead of dropping to default', async () => {
    suggestModelTier.mockResolvedValue({ suggested: 'high', reason: 'r' });
    const result = await selectModelForTask(benignTask, PROVIDER);
    // high → provider-heavy
    expect(result.model).toBe('heavy-model');
    expect(result.tier).toBe('high');
    expect(result.reason).toBe('learning-suggested');
  });

  it('does NOT honor a local-preferred thinking-level suggestion under a cloud provider — falls through with an accurate tier', async () => {
    // minimal/low map to the cross-provider 'lmstudio' sentinel; honoring it here
    // would mis-record the local tier while the run actually uses the default.
    suggestModelTier.mockResolvedValue({ suggested: 'minimal', reason: 'r' });
    const result = await selectModelForTask(benignTask, PROVIDER);
    expect(result.tier).toBe('default');
    expect(result.reason).toBe('standard-task');
  });

  it('falls through to default when the suggested tier resolves to no model', async () => {
    // user-specified is not a thinking level → getModelForLevel returns null, no static map entry.
    suggestModelTier.mockResolvedValue({ suggested: 'user-specified', reason: 'r' });
    const result = await selectModelForTask(benignTask, PROVIDER);
    expect(result.tier).toBe('default');
    expect(result.reason).toBe('standard-task');
  });
});
