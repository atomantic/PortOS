import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

// Mock the socket module so the test can drive the 'media:annotation:updated'
// handler that the hook subscribes to.
const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    emit: vi.fn(),
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
  },
}));

// Mock the API so the initial fetch resolves to a known map.
const listMediaAnnotations = vi.fn();
const setMediaAnnotation = vi.fn();
vi.mock('../services/api', () => ({
  listMediaAnnotations: (...args) => listMediaAnnotations(...args),
  setMediaAnnotation: (...args) => setMediaAnnotation(...args),
}));

vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn() } }));

import { useMediaAnnotations } from './useMediaAnnotations.js';

const emit = (payload) => act(() => { handlers.get('media:annotation:updated')(payload); });

// Mount the hook, wait until it has subscribed to the socket, then flush the
// mount fetch's setAnnotations commit so the initial enrichAll({}) can't land
// mid-test and swap the annotations object reference under React 19.
async function mountHook() {
  const { result } = renderHook(() => useMediaAnnotations());
  await waitFor(() => expect(handlers.has('media:annotation:updated')).toBe(true));
  await act(async () => {});
  return result;
}

describe('useMediaAnnotations — socket bail-out guard', () => {
  beforeEach(() => {
    handlers.clear();
    listMediaAnnotations.mockResolvedValue({ annotations: {} });
    setMediaAnnotation.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('applies a new entry from the socket broadcast', async () => {
    const result = await mountHook();

    emit({ key: 'a.png', entry: { own: { starred: true, note: '', updatedAt: '2026-01-01T00:00:00Z' } } });

    expect(result.current.annotations['a.png']?.starred).toBe(true);
  });

  it('returns the same annotations reference when an identical entry is rebroadcast', async () => {
    const result = await mountHook();

    const entry = { own: { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00Z' } };
    emit({ key: 'a.png', entry });
    const first = result.current.annotations;

    // Re-broadcast the same entry (the originator re-receives its own write).
    emit({ key: 'a.png', entry: { own: { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00Z' } } });

    expect(result.current.annotations).toBe(first);
  });

  it('still re-renders when a field changes (e.g. a newer updatedAt)', async () => {
    const result = await mountHook();

    emit({ key: 'a.png', entry: { own: { starred: false, note: 'first', updatedAt: '2026-01-01T00:00:00Z' } } });
    const first = result.current.annotations;

    emit({ key: 'a.png', entry: { own: { starred: false, note: 'second', updatedAt: '2026-01-02T00:00:00Z' } } });

    expect(result.current.annotations).not.toBe(first);
    expect(result.current.annotations['a.png']?.note).toBe('second');
  });

  it('returns the same reference when deleting a key that was never present', async () => {
    const result = await mountHook();

    const before = result.current.annotations;
    emit({ key: 'missing.png', entry: null });

    expect(result.current.annotations).toBe(before);
  });

  it('removes an existing key when the broadcast clears it', async () => {
    const result = await mountHook();

    emit({ key: 'a.png', entry: { own: { starred: true, note: '', updatedAt: '2026-01-01T00:00:00Z' } } });
    expect(result.current.annotations['a.png']).toBeTruthy();

    emit({ key: 'a.png', entry: null });
    expect('a.png' in result.current.annotations).toBe(false);
  });
});
