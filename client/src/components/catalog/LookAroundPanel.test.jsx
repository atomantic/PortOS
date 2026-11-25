import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getCatalogLookAround: vi.fn(), startCatalogLookAround: vi.fn(), scoreCatalogLookAroundClip: vi.fn(), saveCatalogLookAroundAngles: vi.fn(),
}));
vi.mock('../../services/apiCatalog', () => api);
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../ui/Toast');
vi.mock('../MediaImage', () => ({ default: () => null }));

const { default: LookAroundPanel } = await import('./LookAroundPanel.jsx');

const CLIP = { id: 'clip-1', filename: 'clip-1.mp4', motion: 'full-turn', sourceMediaKey: 'plate.png', createdAt: '2026-11-01T00:00:00Z' };
const info = (extra = {}) => ({
  motions: [{ id: 'full-turn', label: 'Full turn (360°)', defaultSec: 15 }, { id: 'half-left', label: 'Half turn left (180°)', defaultSec: 10 }],
  models: [{ id: 'minimax/h3-max-turbo/image-to-video', label: 'MiniMax H3 Max Turbo (image)', resolutions: ['768P'], defaultResolution: '768P' }],
  defaults: { motion: 'full-turn', modelId: 'minimax/h3-max-turbo/image-to-video' },
  configured: true, mainPlate: 'plate.png', clips: [], pending: [], ...extra,
});
const media = [{ mediaKey: 'plate.png', kind: 'reference', role: 'plate', library: {} }];
const mount = (path = '/environments/plc-1/plates') => render(
  <MemoryRouter initialEntries={[path]}><LookAroundPanel ingredientId="plc-1" media={media} onSaved={vi.fn()} /></MemoryRouter>,
);

describe('LookAroundPanel', () => {
  beforeEach(() => { Object.values(api).forEach((fn) => fn.mockReset()); });

  // Uniquely catches a render that can be sent before its prompt and price were shown, or an edited prompt rewritten.
  it('shows the prompt and price before rendering and sends an edited prompt as typed', async () => {
    api.getCatalogLookAround.mockResolvedValue(info());
    api.startCatalogLookAround.mockImplementation(async (_id, body) => ({ dryRun: body.dryRun, jobId: 'job-1', motion: 'half-left', modelLabel: 'MiniMax H3 Max Turbo (image)',
      seconds: 10, resolution: '768P', estimatedCostUsd: 0.4, prompt: body.prompt ?? 'Locked-off tripod shot.', promptIsDefault: !body.prompt, configured: true, body: {} }));
    mount();
    fireEvent.change(await screen.findByLabelText('Camera move'), { target: { value: 'half-left' } });
    expect(screen.getByRole('button', { name: 'Preview first' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Preview prompt and price/ }));
    await screen.findByText(/10s at 768P, about \$0\.40/);
    expect(api.startCatalogLookAround).toHaveBeenLastCalledWith('plc-1', { motion: 'half-left', modelId: 'minimax/h3-max-turbo/image-to-video', dryRun: true }, { silent: true });
    fireEvent.change(screen.getByLabelText(/^Prompt/), { target: { value: 'My own pan words ' } });
    expect(screen.getByRole('button', { name: 'Preview first' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Preview prompt and price/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Render for $0.40' }));
    await waitFor(() => expect(api.startCatalogLookAround).toHaveBeenLastCalledWith('plc-1', expect.objectContaining({ prompt: 'My own pan words ', dryRun: false }), { silent: true }));
  });

  // Uniquely catches angles saved without the frames the director ticked, or the picker not opening from the URL.
  it('opens the clip from the URL, ticks strip frames and keeps them with their bearings and names', async () => {
    api.getCatalogLookAround.mockResolvedValue(info({ clips: [CLIP] }));
    api.scoreCatalogLookAroundClip.mockResolvedValue({ clipId: 'clip-1', durationSec: 15, motion: 'full-turn', direction: 'left', directionSource: 'frames', requestedDirection: 'right',
      frames: [{ atSec: 0, bearingDeg: 0, progress: 0, sharpness: 0.5 }, { atSec: 3.75, bearingDeg: 270, progress: 0.25, sharpness: 0.6 }],
      strip: [{ atSec: 3.75, bearingDeg: 270, progress: 0.25, sharpness: 0.6, label: '90° left', thumb: 'data:image/jpeg;base64,AA==' }] });
    api.saveCatalogLookAroundAngles.mockResolvedValue({ dryRun: false, angles: [{ mediaKey: 'a.png' }], cleanupJobs: [] });
    mount('/environments/plc-1/plates?lookAround=clip-1');
    expect(await screen.findByText(/The camera turned left, not right as asked/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /90° left/ }));
    fireEvent.change(screen.getByPlaceholderText('Name (optional)'), { target: { value: 'Gate' } });
    fireEvent.click(screen.getByRole('button', { name: /Keep 1 angle as plates/ }));
    await waitFor(() => expect(api.saveCatalogLookAroundAngles).toHaveBeenCalledWith('plc-1', 'clip-1',
      { angles: [{ atSec: 3.75, bearingDeg: 270, name: 'Gate' }], cleanup: false, dryRun: false }, { silent: true }));
  });
});
