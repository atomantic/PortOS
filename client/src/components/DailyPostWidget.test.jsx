import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { INSTANCE_FEATURES_CHANGED } from '../constants/events.js';
import { __resetInstanceFeatureCache } from '../hooks/useInstanceFeatures.js';

const mock = vi.hoisted(() => ({
  getInstanceFeatures: vi.fn(),
  getPostStats: vi.fn(),
  getPostConfig: vi.fn(),
  getPostRecommendations: vi.fn(),
}));

vi.mock('../services/api', () => mock);

import DailyPostWidget from './DailyPostWidget';

describe('DailyPostWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetInstanceFeatureCache();
    mock.getInstanceFeatures.mockResolvedValue({
      features: [{ id: 'post', enabled: false }],
    });
  });

  it('does not collect or render POST metrics when the feature is disabled', async () => {
    const { container } = render(<MemoryRouter><DailyPostWidget /></MemoryRouter>);

    await waitFor(() => expect(mock.getInstanceFeatures).toHaveBeenCalledWith({ silent: true }));
    expect(mock.getPostStats).not.toHaveBeenCalled();
    expect(mock.getPostConfig).not.toHaveBeenCalled();
    expect(mock.getPostRecommendations).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('does not collect POST metrics when feature participation cannot be read', async () => {
    mock.getInstanceFeatures.mockRejectedValue(new Error('offline'));

    const { container } = render(<MemoryRouter><DailyPostWidget /></MemoryRouter>);

    await waitFor(() => expect(mock.getInstanceFeatures).toHaveBeenCalledWith({ silent: true }));
    expect(mock.getPostStats).not.toHaveBeenCalled();
    expect(mock.getPostConfig).not.toHaveBeenCalled();
    expect(mock.getPostRecommendations).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('refreshes the mounted widget after POST participation changes', async () => {
    mock.getInstanceFeatures
      .mockResolvedValueOnce({ features: [{ id: 'post', enabled: true }] })
      .mockResolvedValueOnce({ features: [{ id: 'post', enabled: false }] });
    mock.getPostStats.mockResolvedValue({ completedToday: false, currentStreak: 2 });
    mock.getPostConfig.mockResolvedValue({});
    mock.getPostRecommendations.mockResolvedValue({ recommendations: [] });

    const { container } = render(<MemoryRouter><DailyPostWidget /></MemoryRouter>);
    await waitFor(() => expect(mock.getPostStats).toHaveBeenCalled());

    act(() => window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, {
      detail: { featureId: 'post', enabled: false },
    })));

    await waitFor(() => expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores an in-flight POST read that started before opt-out', async () => {
    let resolveStats;
    const stats = new Promise((resolve) => { resolveStats = resolve; });
    mock.getInstanceFeatures
      .mockResolvedValueOnce({ features: [{ id: 'post', enabled: true }] })
      .mockResolvedValueOnce({ features: [{ id: 'post', enabled: false }] });
    mock.getPostStats.mockReturnValue(stats);
    mock.getPostConfig.mockResolvedValue({});
    mock.getPostRecommendations.mockResolvedValue({ recommendations: [] });

    const { container } = render(<MemoryRouter><DailyPostWidget /></MemoryRouter>);
    await waitFor(() => expect(mock.getPostStats).toHaveBeenCalled());

    act(() => window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, {
      detail: { featureId: 'post', enabled: false },
    })));
    await waitFor(() => expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(2));

    await act(async () => { resolveStats({ completedToday: false, currentStreak: 9 }); });
    expect(container).toBeEmptyDOMElement();
  });
});
