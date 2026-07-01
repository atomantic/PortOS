import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getImageGenStatus: vi.fn(),
  generateImage: vi.fn(),
  registerTool: vi.fn(),
  updateTool: vi.fn(),
  getToolsList: vi.fn(),
  getHfTokenStatus: vi.fn(),
  saveHfToken: vi.fn(),
  clearHfToken: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));
// LocalSetupPanel has its own SSE/install-stream deps — stub it out; this suite
// only cares that the Local tab hosts a python-path panel.
vi.mock('./LocalSetupPanel', () => ({
  default: ({ pythonPath }) => <div data-testid="local-setup-panel">{pythonPath}</div>,
}));
vi.mock('../../hooks/useMediaJobSse', () => ({
  useMediaJobSse: () => ({ attach: vi.fn(), close: vi.fn() }),
}));

import {
  getSettings, getToolsList, getHfTokenStatus, updateSettings,
} from '../../services/api';
import { ImageGenTab } from './ImageGenTab';

const renderTab = async (initialEntries = ['/media/image']) => {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <ImageGenTab />
    </MemoryRouter>,
  );
  // Cards render only after the settings fetch resolves.
  await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
};

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({
    imageGen: {
      mode: 'external',
      external: { sdapiUrl: 'http://localhost:7860' },
      local: { pythonPath: '/usr/bin/python3' },
      codex: { enabled: false },
      expose: { a1111: false },
    },
  });
  getToolsList.mockResolvedValue([]);
  getHfTokenStatus.mockResolvedValue({ hfTokenPresent: false, source: 'none' });
  updateSettings.mockResolvedValue({});
});

describe('ImageGenTab grouped tabs', () => {
  it('renders a pills sub-nav with all seven media-settings groups', async () => {
    await renderTab();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    for (const label of ['Backend', 'External', 'Local', 'Codex CLI', 'Tokens', 'Expose', 'Test']) {
      expect(tabs.some((t) => t.includes(label))).toBe(true);
    }
  });

  it('defaults to the Backend tab and shows the mode cards', async () => {
    await renderTab();
    expect(screen.getByRole('heading', { name: 'Backend' })).toBeTruthy();
    expect(screen.getByText('External SD API')).toBeTruthy();
    expect(screen.getByText('Local (mflux)')).toBeTruthy();
    // Sections from other tabs are not mounted in the default view.
    expect(screen.queryByText('HuggingFace Token')).toBeNull();
    expect(screen.queryByText('Test Render')).toBeNull();
  });

  it('switches to the External tab and shows only that group', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /External/i }));
    expect(screen.getByText('External AUTOMATIC1111 / Forge URL')).toBeTruthy();
    // Backend mode cards are no longer mounted.
    expect(screen.queryByText('External SD API')).toBeNull();
  });

  it('hosts the python-path panel on the Local tab regardless of active mode', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /^Local/i }));
    expect(screen.getByTestId('local-setup-panel')).toBeTruthy();
  });

  it('deep-links the active sub-tab from the mediaTab search param', async () => {
    await renderTab(['/media/image?mediaTab=tokens']);
    // The Tokens group renders immediately without a click.
    expect(screen.getByRole('heading', { name: 'HuggingFace Token' })).toBeTruthy();
    const tokensTab = screen.getByRole('tab', { name: /Tokens/i });
    expect(tokensTab.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the global Save + Test Connection bar visible on every tab', async () => {
    await renderTab();
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Test Connection/i })).toBeTruthy();
    // Still present after switching to a non-backend tab.
    fireEvent.click(screen.getByRole('tab', { name: /Expose/i }));
    expect(screen.getByText('Expose as A1111 API on the Tailnet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeTruthy();
  });

  it('preserves the save behavior — dirtying a field enables Save and PUTs the full imageGen patch', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /External/i }));
    const urlInput = screen.getByPlaceholderText('http://localhost:7860');
    fireEvent.change(urlInput, { target: { value: 'http://localhost:9999' } });
    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const patch = updateSettings.mock.calls[0][0];
    expect(patch.imageGen.external.sdapiUrl).toBe('http://localhost:9999');
    expect(patch.imageGen.mode).toBe('external');
    expect(patch.imageGen).toHaveProperty('codex');
    expect(patch.imageGen).toHaveProperty('expose');
  });
});
