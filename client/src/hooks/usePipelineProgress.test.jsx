import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePipelineProgress } from './usePipelineProgress';
import { MockEventSource } from '../test/mockEventSource';

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
});

afterEach(() => {
  delete global.EventSource;
});

const sseUrl = (a, b) => `/api/thing/${a}/${b}/events`;

describe('usePipelineProgress', () => {
  it('builds the stream URL from the ids', () => {
    renderHook(() => usePipelineProgress(sseUrl, ['s1', 'v2']));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/thing/s1/v2/events');
  });

  it('stays closed while any id is falsy', () => {
    renderHook(() => usePipelineProgress(sseUrl, ['s1', null]));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('stays closed when disabled', () => {
    renderHook(() => usePipelineProgress(sseUrl, ['s1', 'v2'], { enabled: false }));
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
