import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';

vi.mock('../../services/apiFeaturePriorities', () => ({ postFeatureVisit: vi.fn() }));

import { postFeatureVisit } from '../../services/apiFeaturePriorities';
import useFeatureUsageBeacon, { FEATURE_VISIT_DWELL_MS } from './useFeatureUsageBeacon';

let visibility;
let focused;
const setAttention = (nextVisibility, nextFocused) => {
  visibility = nextVisibility;
  focused = nextFocused;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(nextFocused ? 'focus' : 'blur'));
  });
};

const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

// One hook instance that can also navigate, so a test drives route changes the way the app shell sees them.
const mount = ({ enabled = true, path = '/brain' } = {}) => renderHook(
  ({ on }) => {
    useFeatureUsageBeacon(on);
    return useNavigate();
  },
  { initialProps: { on: enabled }, wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter> },
);

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  focused = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.mocked(postFeatureVisit).mockReset().mockResolvedValue({ recorded: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useFeatureUsageBeacon', () => {
  it('posts the route once after 10 focused, visible seconds', () => {
    mount();
    advance(FEATURE_VISIT_DWELL_MS - 1);
    expect(postFeatureVisit).not.toHaveBeenCalled();
    advance(1);
    expect(postFeatureVisit).toHaveBeenCalledTimes(1);
    expect(postFeatureVisit).toHaveBeenCalledWith('/brain');
    advance(60_000);
    expect(postFeatureVisit).toHaveBeenCalledTimes(1);
  });

  it('never posts while the page is hidden or unfocused', () => {
    visibility = 'hidden';
    mount();
    advance(60_000);
    setAttention('visible', false);
    advance(60_000);
    expect(postFeatureVisit).not.toHaveBeenCalled();
  });

  it('restarts the dwell when attention is lost and regained', () => {
    mount();
    advance(8_000);
    setAttention('visible', false);
    advance(60_000);
    expect(postFeatureVisit).not.toHaveBeenCalled();
    setAttention('visible', true);
    advance(FEATURE_VISIT_DWELL_MS - 1);
    expect(postFeatureVisit).not.toHaveBeenCalled();
    advance(1);
    expect(postFeatureVisit).toHaveBeenCalledTimes(1);
  });

  it('does not schedule another post when attention returns after the route was reported', () => {
    mount();
    advance(FEATURE_VISIT_DWELL_MS);
    expect(postFeatureVisit).toHaveBeenCalledTimes(1);
    setAttention('visible', false);
    setAttention('visible', true);
    advance(60_000);
    expect(postFeatureVisit).toHaveBeenCalledTimes(1);
  });

  it('resets on a route change and posts each route at most once per page session', () => {
    const { result } = mount();
    advance(6_000);
    act(() => result.current('/jira'));
    advance(6_000);
    expect(postFeatureVisit).not.toHaveBeenCalled();
    advance(4_000);
    expect(postFeatureVisit).toHaveBeenCalledTimes(1);
    expect(postFeatureVisit).toHaveBeenLastCalledWith('/jira');

    act(() => result.current('/brain'));
    advance(FEATURE_VISIT_DWELL_MS);
    expect(postFeatureVisit).toHaveBeenCalledTimes(2);
    expect(postFeatureVisit).toHaveBeenLastCalledWith('/brain');

    act(() => result.current('/jira'));
    advance(60_000);
    expect(postFeatureVisit).toHaveBeenCalledTimes(2);
  });

  it('does nothing while disabled and when unmounted before the dwell completes', () => {
    mount({ enabled: false });
    advance(60_000);
    expect(postFeatureVisit).not.toHaveBeenCalled();

    const { unmount } = mount();
    advance(5_000);
    unmount();
    advance(60_000);
    expect(postFeatureVisit).not.toHaveBeenCalled();
  });

  it('drops a failed post silently without retrying', async () => {
    vi.mocked(postFeatureVisit).mockRejectedValue(new Error('offline'));
    mount();
    advance(FEATURE_VISIT_DWELL_MS);
    await act(async () => { await Promise.resolve(); });
    advance(60_000);
    expect(postFeatureVisit).toHaveBeenCalledTimes(1);
  });
});
