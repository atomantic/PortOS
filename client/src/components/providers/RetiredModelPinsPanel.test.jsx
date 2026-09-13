import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  getModelPinWarnings: vi.fn(),
  clearModelPin: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import * as api from '../../services/api';
import RetiredModelPinsPanel from './RetiredModelPinsPanel.jsx';

const STALE = {
  pins: [{
    id: 'settings:imageGen.agy.model',
    kind: 'imageGen',
    mode: 'agy',
    providerId: 'antigravity-cli',
    model: 'gemini-3.5-flash-low',
    label: 'Agy CLI image model',
    location: 'Settings → Media Gen → Image Gen',
    href: '/media/image?settings=1',
  }],
  providers: {
    'antigravity-cli': { id: 'antigravity-cli', name: 'Antigravity CLI', available: ['gemini-3.6-flash'] },
  },
};

const renderPanel = (props = {}) =>
  render(<MemoryRouter><RetiredModelPinsPanel {...props} /></MemoryRouter>);

beforeEach(() => vi.clearAllMocks());

describe('RetiredModelPinsPanel', () => {
  it('names the stale pin, where it lives, and what the catalog now offers', async () => {
    api.getModelPinWarnings.mockResolvedValue(STALE);
    renderPanel();

    // Composed from the client's own registries, so the panel and the Settings
    // page it deep-links to name the same row the same way.
    expect(await screen.findByText('Agy image model:')).toBeTruthy();
    expect(screen.getByText('gemini-3.5-flash-low')).toBeTruthy();
    expect(screen.getByText(/Settings → Media Gen → Image Gen/)).toBeTruthy();
    expect(screen.getByText(/Now offered: gemini-3.6-flash/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open setting' })).toHaveAttribute(
      'href', '/media/image?settings=1',
    );
  });

  it('names a render-default pin by its Settings label, not its raw target id', async () => {
    api.getModelPinWarnings.mockResolvedValue({
      pins: [{
        id: 'settings:renderDefaults.universe-bible.imageModel',
        kind: 'renderDefault',
        target: 'universe-bible',
        providerId: 'antigravity-cli',
        model: 'gemini-3.5-flash-low',
        label: 'universe-bible render model',
        location: 'Settings → Media Gen → Render Defaults',
      }],
      providers: {},
    });
    renderPanel();

    expect(await screen.findByText('Universe Bible & canon renders — model:')).toBeTruthy();
  });

  it('renders nothing on a healthy install', async () => {
    api.getModelPinWarnings.mockResolvedValue({ pins: [], providers: {} });
    const { container } = renderPanel();
    await waitFor(() => expect(api.getModelPinWarnings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden rather than erroring when the audit cannot be read', async () => {
    // A provider service that isn't up yet is not something to shout about on a
    // page the user opened to look at providers.
    api.getModelPinWarnings.mockRejectedValue(new Error('service down'));
    const { container } = renderPanel();
    await waitFor(() => expect(api.getModelPinWarnings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('clears only the pin the user clicked, and never rewrites it to another model', async () => {
    api.getModelPinWarnings.mockResolvedValue(STALE);
    api.clearModelPin.mockResolvedValue({ cleared: true, id: 'settings:imageGen.agy.model' });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear pin' }));

    await waitFor(() => expect(api.clearModelPin).toHaveBeenCalledWith('settings:imageGen.agy.model'));
    // Exactly one write, naming the pin — no substitute model id anywhere in it.
    expect(api.clearModelPin).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Agy image model:')).toBeNull());
    // The write already landed, so the row goes without a second audit read.
    expect(api.getModelPinWarnings).toHaveBeenCalledTimes(1);
  });

  it('keeps the row when the clear fails, so the warning is not silently lost', async () => {
    api.getModelPinWarnings.mockResolvedValue(STALE);
    api.clearModelPin.mockRejectedValue(new Error('write failed'));
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear pin' }));

    await waitFor(() => expect(api.clearModelPin).toHaveBeenCalled());
    expect(await screen.findByText('Agy image model:')).toBeTruthy();
  });

  it('re-reads when the caller signals a catalog refresh landed', async () => {
    api.getModelPinWarnings.mockResolvedValue({ pins: [], providers: {} });
    const { rerender } = renderPanel({ reloadKey: 0 });
    await waitFor(() => expect(api.getModelPinWarnings).toHaveBeenCalledTimes(1));

    api.getModelPinWarnings.mockResolvedValue(STALE);
    rerender(<MemoryRouter><RetiredModelPinsPanel reloadKey={1} /></MemoryRouter>);

    expect(await screen.findByText('Agy image model:')).toBeTruthy();
  });
});
