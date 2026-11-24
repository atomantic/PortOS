import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/apiPalette.js', () => ({
  getPaletteManifest: vi.fn(() => Promise.resolve({ actions: [] })),
  runPaletteAction: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock('../services/apiSystem.js', () => ({
  getInstanceFeatures: vi.fn(() => Promise.resolve({ features: [] })),
}));
vi.mock('../services/apiDashboard.js', () => ({
  getDashboardLayouts: vi.fn(() => Promise.resolve({ layouts: [] })),
  setActiveDashboardLayout: vi.fn(() => Promise.resolve()),
}));
vi.mock('../services/apiCore.js', () => ({
  search: vi.fn(() => Promise.resolve({ sources: [] })),
}));
vi.mock('../services/apiCatalog.js', () => ({
  listCatalogIngredients: vi.fn(() => Promise.resolve({ items: [] })),
}));

import CmdKSearchGate from './CmdKSearchGate.jsx';
import KeyboardHelpGate from './KeyboardHelpGate.jsx';
import ThemeSwitcherGate from './ThemeSwitcherGate.jsx';
import { openCmdKSearch } from '../hooks/useCmdKSearch.js';

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('lazy shell overlay gates (#17007)', () => {
  it('mounts CmdKSearch lazily on Cmd+K / openCmdKSearch and uses bundled NAV_COMMANDS when actionsOnly omits nav', async () => {
    render(
      <MemoryRouter>
        <CmdKSearchGate />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    // Bundled NAV_COMMANDS are immediately searchable without server nav payload.
    expect(await screen.findByRole('option', { name: /Goals/i })).toBeInTheDocument();

    // Closing and reopening via the search button event keeps working.
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());

    act(() => openCmdKSearch());
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await act(async () => {});
  });

  it('mounts KeyboardHelp lazily on ? and closes on Escape', async () => {
    render(<KeyboardHelpGate />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: '?' });
    expect(await screen.findByText('Keyboard Shortcuts')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument());
  });

  it('mounts ThemeSwitcher lazily when the theme trigger is clicked', async () => {
    render(<ThemeSwitcherGate />);

    const trigger = screen.getByRole('button', { name: /Switch theme/ });
    expect(screen.queryByRole('menu', { name: 'Interface theme' })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(await screen.findByRole('menu', { name: 'Interface theme' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Interface theme' })).not.toBeInTheDocument());
  });
});
