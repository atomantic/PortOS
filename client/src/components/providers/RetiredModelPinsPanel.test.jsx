import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiProviders.js', () => ({
  getModelPinWarnings: vi.fn(),
  clearModelPin: vi.fn(),
}));
vi.mock('../ui/Toast');

import { getModelPinWarnings, clearModelPin } from '../../services/apiProviders.js';
import RetiredModelPinsPanel from './RetiredModelPinsPanel.jsx';

const STALE = {
  pins: [{
    id: 'settings:imageGen.agy.model',
    kind: 'imageGen',
    mode: 'agy',
    providerIds: ['antigravity-cli'],
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
    getModelPinWarnings.mockResolvedValue(STALE);
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
    getModelPinWarnings.mockResolvedValue({
      pins: [{
        id: 'settings:renderDefaults.universe-bible.imageModel',
        kind: 'renderDefault',
        target: 'universe-bible',
        providerIds: ['antigravity-cli'],
        model: 'gemini-3.5-flash-low',
        label: 'universe-bible render model',
        location: 'Settings → Media Gen → Render Defaults',
      }],
      providers: {},
    });
    renderPanel();

    expect(await screen.findByText('Universe Bible & canon renders — model:')).toBeTruthy();
  });

  it('names a per-record pin by the record, and links to that record', async () => {
    // A record pin (#7326) has no client-side registry to compose a name from —
    // the record's own name is the name — so the panel falls through to the
    // server's label rather than printing the pin kind.
    getModelPinWarnings.mockResolvedValue({
      pins: [{
        id: 'record:universe:u-1',
        kind: 'record',
        family: 'universe',
        recordId: 'u-1',
        mode: 'agy',
        providerIds: ['antigravity-cli'],
        model: 'gemini-3.5-flash-low',
        label: 'Example Universe · universe render model',
        location: 'Universes → Render',
        href: '/universes/u-1?tab=render',
      }],
      providers: STALE.providers,
    });
    renderPanel();

    expect(await screen.findByText('Example Universe · universe render model:')).toBeTruthy();
    expect(screen.getByText(/Universes → Render/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open setting' })).toHaveAttribute(
      'href', '/universes/u-1?tab=render',
    );
  });

  it('renders nothing on a healthy install', async () => {
    getModelPinWarnings.mockResolvedValue({ pins: [], providers: {} });
    const { container } = renderPanel();
    await waitFor(() => expect(getModelPinWarnings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden rather than erroring when the audit cannot be read', async () => {
    // A provider service that isn't up yet is not something to shout about on a
    // page the user opened to look at providers.
    getModelPinWarnings.mockRejectedValue(new Error('service down'));
    const { container } = renderPanel();
    await waitFor(() => expect(getModelPinWarnings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('clears only the pin the user clicked, and never rewrites it to another model', async () => {
    getModelPinWarnings.mockResolvedValue(STALE);
    clearModelPin.mockResolvedValue({ cleared: true, id: 'settings:imageGen.agy.model' });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear pin' }));

    await waitFor(() => expect(clearModelPin).toHaveBeenCalledWith('settings:imageGen.agy.model'));
    // Exactly one write, naming the pin — no substitute model id anywhere in it.
    expect(clearModelPin).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Agy image model:')).toBeNull());
    // The write already landed, so the row goes without a second audit read.
    expect(getModelPinWarnings).toHaveBeenCalledTimes(1);
  });

  it('keeps the row when the clear fails, so the warning is not silently lost', async () => {
    getModelPinWarnings.mockResolvedValue(STALE);
    clearModelPin.mockRejectedValue(new Error('write failed'));
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear pin' }));

    await waitFor(() => expect(clearModelPin).toHaveBeenCalled());
    expect(await screen.findByText('Agy image model:')).toBeTruthy();
  });

  it('re-reads when the caller signals a catalog refresh landed', async () => {
    getModelPinWarnings.mockResolvedValue({ pins: [], providers: {} });
    const { rerender } = renderPanel({ reloadKey: 0 });
    await waitFor(() => expect(getModelPinWarnings).toHaveBeenCalledTimes(1));

    getModelPinWarnings.mockResolvedValue(STALE);
    rerender(<MemoryRouter><RetiredModelPinsPanel reloadKey={1} /></MemoryRouter>);

    expect(await screen.findByText('Agy image model:')).toBeTruthy();
  });
});

describe('a reviewer pin judged against several provider records (#7339)', () => {
  const REVIEWER_PIN = {
    pins: [{
      id: 'codeReview:claudeModel',
      kind: 'reviewerModel',
      reviewer: 'claude',
      providerIds: ['claude-code', 'claude-code-tui'],
      model: 'claude-3-opus',
      label: 'claude reviewer model',
      location: 'Code Review Defaults',
      href: '/models/code-reviewers',
    }],
    providers: {
      'claude-code': { id: 'claude-code', name: 'Claude Code', available: ['claude-sonnet-4-6'] },
      'claude-code-tui': { id: 'claude-code-tui', name: 'Claude Code TUI', available: ['claude-sonnet-5'] },
    },
  };

  it('offers the union of every judged record, not just the preferred one', async () => {
    // Showing one record's catalog would hide tiers the reviewer's binary can
    // still be handed — the same staleness the union exists to route around.
    getModelPinWarnings.mockResolvedValue(REVIEWER_PIN);
    renderPanel();

    const offered = await screen.findByText(/Now offered:/);
    expect(offered.textContent).toContain('claude-sonnet-4-6');
    expect(offered.textContent).toContain('claude-sonnet-5');
    expect(screen.getByText(/Claude Code · Claude Code TUI/)).toBeTruthy();
  });
});
