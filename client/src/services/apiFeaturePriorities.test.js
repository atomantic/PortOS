import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', () => ({ request: vi.fn() }));

import { request } from './apiCore.js';
import { postFeatureVisit } from './apiFeaturePriorities.js';

describe('postFeatureVisit', () => {
  beforeEach(() => vi.mocked(request).mockReset().mockResolvedValue({ recorded: true }));

  it('posts the path silently so a failed beacon never toasts', async () => {
    await postFeatureVisit('/brain');
    expect(request).toHaveBeenCalledWith('/feature-priorities/visit', {
      method: 'POST',
      body: JSON.stringify({ path: '/brain' }),
      silent: true,
      hostControlOptional: true,
    });
  });
});
