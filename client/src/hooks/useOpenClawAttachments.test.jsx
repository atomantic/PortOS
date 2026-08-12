import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOpenClawAttachments } from './useOpenClawAttachments';

vi.mock('../utils/fileUpload', () => ({
  readFileAsBase64: vi.fn(async () => 'ZmFrZQ==')
}));

function fakeFile({ name, size, type = 'image/png' }) {
  return { name, size, type, lastModified: 0 };
}

describe('useOpenClawAttachments oversize rejection', () => {
  beforeEach(() => {
    // jsdom does not implement the object-URL APIs the hook uses for image previews.
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });

  it('reports the size cap using the canonical formatBytes output', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useOpenClawAttachments({ sending: false, onError }));

    await act(async () => {
      await result.current.appendFiles([fakeFile({ name: 'huge.png', size: 20 * 1024 * 1024 })]);
    });

    // 9,999,999-byte cap → "10 MB" via formatBytes(bytes, 0), not a hand-rolled "10MB".
    expect(onError).toHaveBeenCalledWith('"huge.png" is too large. Maximum attachment size is 10 MB.');
    expect(result.current.attachments).toEqual([]);
  });

  it('accepts a file under the cap', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useOpenClawAttachments({ sending: false, onError }));

    await act(async () => {
      await result.current.appendFiles([fakeFile({ name: 'small.png', size: 1024 })]);
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(onError).toHaveBeenLastCalledWith('');
  });
});
