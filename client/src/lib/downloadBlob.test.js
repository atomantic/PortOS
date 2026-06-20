import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadBlob } from './downloadBlob.js';

describe('downloadBlob', () => {
  let createObjectURL;
  let revokeObjectURL;
  let clickSpy;
  // jsdom doesn't implement object URLs, so we assign them directly rather than
  // spy. `vi.restoreAllMocks()` won't undo a plain property assignment — save
  // and restore the originals ourselves so the mocks don't leak into later tests.
  let originalCreate;
  let originalRevoke;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    clickSpy = vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.spyOn(document.body, 'appendChild');
    vi.spyOn(document.body, 'removeChild');
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it('creates an object URL, clicks a download anchor, and cleans up', () => {
    downloadBlob('hello', 'note.txt', 'text/plain');
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/plain');
    expect(clickSpy).toHaveBeenCalledOnce();
    // The anchor carried the requested filename + the object URL.
    const anchor = document.body.appendChild.mock.calls[0][0];
    expect(anchor.tagName).toBe('A');
    expect(anchor.download).toBe('note.txt');
    expect(anchor.href).toContain('blob:mock-url');
    // Cleanup: anchor removed and URL revoked.
    expect(document.body.removeChild).toHaveBeenCalledWith(anchor);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('passes a Blob through without re-wrapping it', () => {
    const original = new Blob(['x'], { type: 'application/zip' });
    downloadBlob(original, 'bundle.zip');
    expect(createObjectURL).toHaveBeenCalledWith(original);
  });

  it('wraps an ArrayBuffer with the given MIME type', () => {
    downloadBlob(new ArrayBuffer(4), 'data.bin', 'application/zip');
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBe(4);
  });
});
