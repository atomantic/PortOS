import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getMusicVideoCodeDocument: vi.fn(),
  generateMusicVideoCode: vi.fn(),
  regenerateMusicVideoCodeSection: vi.fn(),
}));

vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [{ id: 'stub-provider', name: 'Stub Provider', models: ['fixture-model'] }],
    selectedProviderId: 'stub-provider',
    selectedModel: 'fixture-model',
    availableModels: ['fixture-model'],
    selectedProvider: { id: 'stub-provider', name: 'Stub Provider' },
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
  }),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import CodeVideoPanel from './CodeVideoPanel.jsx';

const DOC = {
  html: '<!doctype html><html><body><canvas id="c"></canvas></body></html>',
  durationSec: 2,
  fps: 24,
  width: 320,
  height: 180,
  song: { sections: [
    { id: 'a', label: 'Verse', startSec: 0, endSec: 1 },
    { id: 'b', label: 'Chorus', startSec: 1, endSec: 2 },
  ] },
};

const project = { id: 'mv-1', updatedAt: '2026-01-01T00:00:00.000Z', composition: { mode: 'code' } };

beforeEach(() => {
  api.getMusicVideoCodeDocument.mockReset();
  api.generateMusicVideoCode.mockReset();
  api.regenerateMusicVideoCodeSection.mockReset();
  api.getMusicVideoCodeDocument.mockResolvedValue(DOC);
  api.generateMusicVideoCode.mockResolvedValue({ project });
  api.regenerateMusicVideoCodeSection.mockResolvedValue({ project });
});

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={['/music-video/mv-1']}>
      <CodeVideoPanel project={project} audioUrl={null} onProject={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('CodeVideoPanel (#9076)', () => {
  it('shows the provider before a click and does not generate on mount', async () => {
    renderPanel();
    expect(await screen.findByText(/Stub Provider \/ fixture-model/)).toBeTruthy();
    const generate = await screen.findByRole('button', { name: 'Generate code video' });
    await waitFor(() => expect(generate).toBeEnabled());
    expect(api.generateMusicVideoCode).not.toHaveBeenCalled();
    fireEvent.click(generate);
    await waitFor(() => expect(api.generateMusicVideoCode).toHaveBeenCalledWith(
      'mv-1',
      { providerId: 'stub-provider', model: 'fixture-model' },
      { silent: true },
    ));
  });

  it('steps a frame and selects the next section from the keyboard', async () => {
    renderPanel();
    await screen.findByLabelText('Scrub preview');
    fireEvent.keyDown(window, { key: '.' });
    expect(Number(screen.getByLabelText('Scrub preview').value)).toBeCloseTo(1 / 24, 5);
    fireEvent.keyDown(window, { key: ']' });
    await waitFor(() => expect(screen.getByText(/Chorus/)).toBeTruthy());
  });
});
