import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toastMock = { success: vi.fn(), error: vi.fn() };

vi.mock('../components/ui/Toast', () => ({ default: toastMock }));

let writeClipboardSilently;
let copyToClipboard;
let readClipboard;

beforeEach(async () => {
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  vi.resetModules();
  ({ writeClipboardSilently, copyToClipboard, readClipboard } = await import('./clipboard.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setClipboard(clipboard) {
  vi.stubGlobal('navigator', clipboard === undefined ? {} : { clipboard });
}

function unsetNavigator() {
  vi.stubGlobal('navigator', undefined);
}

describe('writeClipboardSilently', () => {
  it('returns true and writes text on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await writeClipboardSilently('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('returns false when navigator.clipboard is unavailable (no toasts)', async () => {
    setClipboard(undefined);
    expect(await writeClipboardSilently('hello')).toBe(false);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('returns false when navigator itself is undefined (no ReferenceError)', async () => {
    unsetNavigator();
    expect(await writeClipboardSilently('hello')).toBe(false);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('returns false when writeText throws (no toasts)', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    expect(await writeClipboardSilently('hello')).toBe(false);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('returns false for empty text without touching navigator', async () => {
    const writeText = vi.fn();
    setClipboard({ writeText });
    expect(await writeClipboardSilently('')).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('copyToClipboard', () => {
  it('toasts success and returns true on success', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    expect(await copyToClipboard('hello')).toBe(true);
    expect(toastMock.success).toHaveBeenCalledWith('Copied');
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('uses a custom success message when provided', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    expect(await copyToClipboard('hello', 'Snippet copied')).toBe(true);
    expect(toastMock.success).toHaveBeenCalledWith('Snippet copied');
  });

  it('suppresses the success toast when successMessage is null', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    expect(await copyToClipboard('hello', null)).toBe(true);
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('still toasts the failure on null successMessage when writeText throws', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    expect(await copyToClipboard('hello', null)).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith('Copy failed');
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('toasts the insecure-context error when isSecureContext is false', async () => {
    setClipboard(undefined);
    vi.stubGlobal('isSecureContext', false);
    expect(await copyToClipboard('hello')).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith('Clipboard unavailable on insecure context');
  });

  it('toasts the generic error when clipboard is missing on a secure context', async () => {
    setClipboard(undefined);
    vi.stubGlobal('isSecureContext', true);
    expect(await copyToClipboard('hello')).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith('Clipboard unavailable');
  });

  it('toasts the generic error when navigator itself is undefined and isSecureContext is unknown', async () => {
    unsetNavigator();
    // isSecureContext deliberately not stubbed — undefined ≠ false
    expect(await copyToClipboard('hello')).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith('Clipboard unavailable');
  });

  it('toasts the failure and returns false when writeText throws', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    expect(await copyToClipboard('hello')).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith('Copy failed');
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('returns false for empty text without toasting', async () => {
    setClipboard({ writeText: vi.fn() });
    expect(await copyToClipboard('')).toBe(false);
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});

describe('readClipboard', () => {
  it('returns the clipboard contents on success', async () => {
    setClipboard({ readText: vi.fn().mockResolvedValue('pasted') });
    expect(await readClipboard()).toBe('pasted');
  });

  it('returns null when navigator.clipboard.readText is unavailable', async () => {
    setClipboard({});
    expect(await readClipboard()).toBeNull();
  });

  it('returns null when navigator itself is undefined (no ReferenceError)', async () => {
    unsetNavigator();
    expect(await readClipboard()).toBeNull();
  });

  it('returns null when readText throws', async () => {
    setClipboard({ readText: vi.fn().mockRejectedValue(new Error('denied')) });
    expect(await readClipboard()).toBeNull();
  });
});
