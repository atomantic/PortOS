import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getMortalLoomStatus: vi.fn(),
  importMortalLoom: vi.fn(),
}));
vi.mock('../../services/apiSystem.js', () => ({ getSettings: api.getSettings, updateSettings: api.updateSettings }));
vi.mock('../../services/apiMortalLoom.js', () => ({
  getMortalLoomStatus: api.getMortalLoomStatus,
  importMortalLoom: api.importMortalLoom,
}));
vi.mock('../ui/Toast');

import MortalLoomTab from './MortalLoomTab.jsx';

beforeEach(() => Object.values(api).forEach((fn) => fn.mockReset()));

describe('MortalLoomTab', () => {
  it('blocks Save and Import after a failed settings read, then shows stored values on Retry', async () => {
    api.getSettings.mockRejectedValueOnce(new Error('offline'));
    api.getMortalLoomStatus.mockResolvedValue({ exists: true, defaultPath: '/default' });

    render(<MortalLoomTab />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Import from MortalLoom/ })).toBeDisabled();
    expect(api.updateSettings).not.toHaveBeenCalled();

    api.getSettings.mockResolvedValue({ mortalloom: { enabled: true, path: '/custom/ml.json' } });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByLabelText('iCloud file path')).toHaveValue('/custom/ml.json'));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled();
  });
});

describe('MortalLoom import', () => {
  beforeEach(() => {
    api.getSettings.mockResolvedValue({ mortalloom: { enabled: true, path: '/saved.json' } });
    api.getMortalLoomStatus.mockResolvedValue({ exists: true, path: '/saved.json' });
    api.updateSettings.mockResolvedValue({});
  });

  it('blocks import for draft edits and until a save finishes', async () => {
    let finishSave;
    api.updateSettings.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    render(<MortalLoomTab />);
    const importButton = await screen.findByRole('button', { name: 'Import from MortalLoom' });
    expect(importButton).toBeEnabled();

    fireEvent.click(screen.getByRole('switch', { name: 'Disable MortalLoom sync' }));
    expect(importButton).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable MortalLoom sync' }));
    expect(importButton).toBeEnabled();

    fireEvent.change(screen.getByLabelText('iCloud file path'), { target: { value: '/new.json' } });
    expect(importButton).toBeDisabled();
    expect(screen.getByText('Save your changes before importing.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(importButton).toBeDisabled();
    expect(screen.getByText('Wait for settings to finish saving before importing.')).toBeVisible();
    expect(api.importMortalLoom).not.toHaveBeenCalled();

    finishSave();
    await waitFor(() => expect(importButton).toBeEnabled());
  });

  it('keeps edits made during import in the draft and writes the saved configuration with the timestamp', async () => {
    let finishImport;
    api.importMortalLoom.mockImplementationOnce(() => new Promise(resolve => { finishImport = resolve; }));
    render(<MortalLoomTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import from MortalLoom' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Disable MortalLoom sync' }));
    fireEvent.change(screen.getByLabelText('iCloud file path'), { target: { value: '/draft.json' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    finishImport({ ok: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({
      mortalloom: { enabled: true, path: '/saved.json', lastImportAt: expect.any(String) },
    });
    expect(screen.getByLabelText('iCloud file path')).toHaveValue('/draft.json');
    expect(screen.getByRole('button', { name: 'Import from MortalLoom' })).toBeDisabled();
  });

  it('uses silent reads and offers status-only Retry after a failed probe', async () => {
    api.getMortalLoomStatus.mockRejectedValueOnce(new Error('offline'));
    render(<MortalLoomTab />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText('MortalLoom file status is unavailable.')).toBeVisible();
    expect(screen.queryByText(/File not found/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import from MortalLoom' })).toBeDisabled();
    expect(api.getSettings).toHaveBeenCalledExactlyOnceWith({ silent: true });
    expect(api.getMortalLoomStatus).toHaveBeenCalledExactlyOnceWith({ silent: true });

    api.getMortalLoomStatus.mockResolvedValueOnce({ exists: false });
    fireEvent.click(retry);
    expect(await screen.findByText(/File not found/)).toBeVisible();
    expect(screen.queryByText(/file status is unavailable/)).not.toBeInTheDocument();
    expect(api.getSettings).toHaveBeenCalledTimes(1);
    expect(api.getMortalLoomStatus).toHaveBeenLastCalledWith({ silent: true });
  });
});
