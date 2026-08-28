import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { downloadBackupSnapshot } from './apiSystem.js';

describe('downloadBackupSnapshot', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalShowSaveFilePicker = window.showSaveFilePicker;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    URL.createObjectURL = vi.fn(() => 'blob:backup');
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLAnchorElement.prototype.click = originalClick;
    window.showSaveFilePicker = originalShowSaveFilePicker;
  });

  it('fetches with same-origin credentials and saves the response blob', async () => {
    const blob = new Blob(['snapshot']);
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      blob: vi.fn().mockResolvedValue(blob),
    });

    await expect(downloadBackupSnapshot('2026-08-25T12-00-00'))
      .resolves.toEqual({ filename: 'portos-snapshot-2026-08-25T12-00-00.tar.gz' });

    expect(fetch).toHaveBeenCalledWith(
      '/api/backup/snapshots/2026-08-25T12-00-00/download',
      { credentials: 'same-origin' },
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:backup');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed download response', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({ error: 'Snapshot not found', code: 'NOT_FOUND' }),
    });

    await expect(downloadBackupSnapshot('missing'))
      .rejects.toMatchObject({ message: 'Snapshot not found', code: 'NOT_FOUND', status: 404 });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('forwards structured error.context from a failed download response', async () => {
    const context = { snapshotId: 'missing', retryable: false };
    fetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({ error: 'snapshot locked', code: 'ERR_SNAPSHOT_LOCKED', context }),
    });

    await expect(downloadBackupSnapshot('missing')).rejects.toMatchObject({ context });
  });

  it('streams large responses to a file picker when available', async () => {
    const pipeTo = vi.fn().mockResolvedValue(undefined);
    const writable = {};
    const createWritable = vi.fn().mockResolvedValue(writable);
    const blob = vi.fn();
    window.showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });
    fetch.mockResolvedValue({ ok: true, headers: new Headers(), body: { pipeTo }, blob });

    await expect(downloadBackupSnapshot('large'))
      .resolves.toEqual({ filename: 'portos-snapshot-large.tar.gz' });

    expect(window.showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'portos-snapshot-large.tar.gz' });
    expect(createWritable).toHaveBeenCalledOnce();
    expect(pipeTo).toHaveBeenCalledWith(writable);
    expect(blob).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('opens the save picker BEFORE fetching, so the click activation is still valid', async () => {
    const order = [];
    window.showSaveFilePicker = vi.fn(async () => {
      order.push('picker');
      return { createWritable: async () => ({}) };
    });
    fetch.mockImplementation(async () => {
      order.push('fetch');
      return { ok: true, headers: new Headers(), body: { pipeTo: vi.fn() }, blob: vi.fn() };
    });

    await downloadBackupSnapshot('large');

    expect(order).toEqual(['picker', 'fetch']);
  });

  it('aborts the opened file handle when the download turns out to 404', async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    window.showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: async () => ({ abort }) });
    fetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({ error: 'Snapshot not found', code: 'NOT_FOUND' }),
    });

    await expect(downloadBackupSnapshot('missing')).rejects.toMatchObject({ status: 404 });
    // Otherwise the picker leaves a 0-byte file where the user chose to save.
    expect(abort).toHaveBeenCalledOnce();
  });

  it('aborts the opened file handle when fetch rejects', async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    window.showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: async () => ({ abort }) });
    const error = new Error('network unavailable');
    fetch.mockRejectedValue(error);

    await expect(downloadBackupSnapshot('offline')).rejects.toBe(error);
    expect(abort).toHaveBeenCalledOnce();
  });

  it('aborts the opened file handle when streaming rejects', async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    const pipeError = new Error('destination failed');
    const pipeTo = vi.fn().mockRejectedValue(pipeError);
    window.showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: async () => ({ abort }) });
    fetch.mockResolvedValue({ ok: true, headers: new Headers(), body: { pipeTo } });

    await expect(downloadBackupSnapshot('stream-failure')).rejects.toBe(pipeError);
    expect(abort).toHaveBeenCalledOnce();
  });

  it('falls back to the blob download when the picker is unavailable', async () => {
    const blob = new Blob(['snapshot']);
    const body = { pipeTo: vi.fn() };
    const pickerError = Object.assign(new Error('Not supported here'), { name: 'SecurityError' });
    window.showSaveFilePicker = vi.fn().mockRejectedValue(pickerError);
    fetch.mockResolvedValue({ ok: true, headers: new Headers(), body, blob: vi.fn().mockResolvedValue(blob) });

    await expect(downloadBackupSnapshot('large'))
      .resolves.toEqual({ filename: 'portos-snapshot-large.tar.gz' });

    expect(body.pipeTo).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  });

  it('propagates a dismissed picker as a cancel, without fetching at all', async () => {
    window.showSaveFilePicker = vi.fn().mockRejectedValue(
      Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }),
    );

    await expect(downloadBackupSnapshot('large')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
