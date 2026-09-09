import { describe, expect, it, beforeEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mock = vi.hoisted(() => ({ getInstanceFeatures: vi.fn() }));
vi.mock('../services/api', () => mock);

import { INSTANCE_FEATURES_CHANGED } from '../constants/events.js';
import {
  useInstanceFeatures,
  publishInstanceFeatures,
  invalidateInstanceFeatures,
  __resetInstanceFeatureCache,
} from './useInstanceFeatures.js';

const JIRA_ON = [{ id: 'jira', label: 'JIRA', enabled: true }];
const JIRA_OFF = [{ id: 'jira', label: 'JIRA', enabled: false }];

function Probe({ label = 'a' }) {
  const { features, error, isFeatureEnabled, reload } = useInstanceFeatures();
  return <>
    <output data-testid={label} data-features={JSON.stringify(features)} data-error={Boolean(error)}>
      {isFeatureEnabled('jira') ? 'on' : 'off'}
    </output>
    <button onClick={reload}>Reload {label}</button>
  </>;
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
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
    render(<><Probe label="a" /><Probe label="b" /></>);
    await act(async () => {});
    mock.getInstanceFeatures.mockResolvedValue({ features: JIRA_ON });

    await act(async () => {
      window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, { detail: { featureId: 'jira', enabled: true } }));
    });

    expect(screen.getByTestId('a')).toHaveTextContent('on');
    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(2);
  });

  // The race the generation counter exists for: a save lands while the initial
  // fetch is still open, and that fetch read the PRE-save state.
  it('does not let a stale in-flight response overwrite a newer answer', async () => {
    const slow = deferred();
    mock.getInstanceFeatures.mockReturnValueOnce(slow.promise);
    render(<><Probe label="a" /><Probe label="b" /></>);

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

  it.each(['before', 'after'])('ignores a superseded read settling %s its replacement', async (order) => {
    const stale = deferred();
    const fresh = deferred();
    mock.getInstanceFeatures.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    render(<><Probe label="a" /><Probe label="b" /></>);
    act(() => invalidateInstanceFeatures('jira'));
    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(2);

    const settleStale = () => act(async () => { stale.resolve({ features: JIRA_ON }); });
    if (order === 'before') {
      await settleStale();
      for (const label of ['a', 'b']) {
        expect(screen.getByTestId(label)).toHaveAttribute('data-features', 'null');
        expect(screen.getByTestId(label)).toHaveTextContent('off');
      }
    }
    await act(async () => { fresh.resolve({ features: JIRA_OFF }); });
    if (order === 'after') await settleStale();
    for (const label of ['a', 'b']) {
      expect(screen.getByTestId(label)).toHaveAttribute('data-features', JSON.stringify(JIRA_OFF));
      expect(screen.getByTestId(label)).toHaveTextContent('off');
    }
  });

  it('shares refresh failures and recovers every consumer when one retries', async () => {
    render(<><Probe label="a" /><Probe label="b" /></>);
    await act(async () => {});
    const failed = deferred();
    mock.getInstanceFeatures.mockReturnValueOnce(failed.promise);
    act(() => invalidateInstanceFeatures('jira'));
    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(2);
    await act(async () => { failed.reject(new Error('synthetic offline')); });
    for (const label of ['a', 'b']) {
      expect(screen.getByTestId(label)).toHaveTextContent('on');
      expect(screen.getByTestId(label)).toHaveAttribute('data-features', 'null');
      expect(screen.getByTestId(label)).toHaveAttribute('data-error', 'true');
    }
    await act(async () => { fireEvent.click(screen.getByText('Reload a')); });
    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(3);
    for (const label of ['a', 'b']) {
      expect(screen.getByTestId(label)).toHaveTextContent('off');
      expect(screen.getByTestId(label)).toHaveAttribute('data-error', 'false');
    }
  });

  it('keeps one bridge through StrictMode, late subscriptions and remounts', async () => {
    const view = render(<StrictMode><Probe /></StrictMode>);
    await act(async () => {});
    act(() => publishInstanceFeatures([]));
    view.rerender(<StrictMode><Probe /><Probe label="b" /></StrictMode>);
    expect(screen.getByTestId('b')).toHaveAttribute('data-features', '[]');
    expect(screen.getByTestId('b')).toHaveTextContent('on');
    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<StrictMode><Probe /><Probe label="b" /></StrictMode>);
    await act(async () => { invalidateInstanceFeatures('jira'); });
    expect(mock.getInstanceFeatures).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('a')).toHaveTextContent('off');
    expect(screen.getByTestId('b')).toHaveTextContent('off');
  });

  it('fails open so a failed fetch never blanks navigation', async () => {
    mock.getInstanceFeatures.mockRejectedValue(new Error('offline'));
    render(<><Probe label="a" /><Probe label="b" /></>);
    await act(async () => {});

    expect(screen.getByTestId('a')).toHaveTextContent('on');
  });
});
