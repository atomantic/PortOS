import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const mock = vi.hoisted(() => ({ getInstanceFeatures: vi.fn() }));
vi.mock('../services/api', () => mock);

import { INSTANCE_FEATURES_CHANGED } from '../constants/events.js';
import {
  useInstanceFeatures,
  publishInstanceFeatures,
  __resetInstanceFeatureCache,
} from './useInstanceFeatures.js';

const JIRA_ON = [{ id: 'jira', label: 'JIRA', enabled: true }];
const JIRA_OFF = [{ id: 'jira', label: 'JIRA', enabled: false }];

function Probe({ label = 'a' }) {
  const { isFeatureEnabled } = useInstanceFeatures();
  return <output data-testid={label}>{isFeatureEnabled('jira') ? 'on' : 'off'}</output>;
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('useInstanceFeatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetInstanceFeatureCache();
    mock.getInstanceFeatures.mockResolvedValue({ features: JIRA_OFF });
  });

  it('shares one fetch across every consumer', async () => {
    render(<><Probe label="a" /><Probe label="b" /></>);
    await act(async () => {});

    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('a')).toHaveTextContent('off');
    expect(screen.getByTestId('b')).toHaveTextContent('off');
  });

  it('applies a published list to every consumer without refetching', async () => {
    render(<><Probe label="a" /><Probe label="b" /></>);
    await act(async () => {});

    act(() => publishInstanceFeatures(JIRA_ON, { featureId: 'jira', enabled: true }));

    expect(screen.getByTestId('a')).toHaveTextContent('on');
    expect(screen.getByTestId('b')).toHaveTextContent('on');
    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(1);
  });

  it('refetches when told the underlying state changed but not what it is', async () => {
    render(<Probe />);
    await act(async () => {});
    mock.getInstanceFeatures.mockResolvedValue({ features: JIRA_ON });

    await act(async () => {
      window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, { detail: { featureId: 'jira' } }));
    });

    expect(screen.getByTestId('a')).toHaveTextContent('on');
    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(2);
  });

  // The race the generation counter exists for: a save lands while the initial
  // fetch is still open, and that fetch read the PRE-save state.
  it('does not let a stale in-flight response overwrite a newer answer', async () => {
    const slow = deferred();
    mock.getInstanceFeatures.mockReturnValueOnce(slow.promise);
    render(<Probe />);

    // The save publishes the fresh list while the first fetch is still open.
    act(() => publishInstanceFeatures(JIRA_ON, { featureId: 'jira', enabled: true }));
    expect(screen.getByTestId('a')).toHaveTextContent('on');

    // The stale response now arrives carrying the pre-save answer.
    await act(async () => {
      slow.resolve({ features: JIRA_OFF });
      await slow.promise;
    });

    expect(screen.getByTestId('a')).toHaveTextContent('on');
  });

  it('starts a fresh shared read after a legacy invalidation during an in-flight read', async () => {
    const stale = deferred();
    const fresh = deferred();
    mock.getInstanceFeatures
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    render(<Probe />);

    act(() => {
      window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, { detail: { featureId: 'jira' } }));
    });
    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(2);

    await act(async () => {
      fresh.resolve({ features: JIRA_ON });
      await fresh.promise;
    });
    expect(screen.getByTestId('a')).toHaveTextContent('on');

    await act(async () => {
      stale.resolve({ features: JIRA_OFF });
      await stale.promise;
    });
    expect(screen.getByTestId('a')).toHaveTextContent('on');
  });

  it('fails open so a failed fetch never blanks navigation', async () => {
    mock.getInstanceFeatures.mockRejectedValue(new Error('offline'));
    render(<Probe />);
    await act(async () => {});

    expect(screen.getByTestId('a')).toHaveTextContent('on');
  });
});
