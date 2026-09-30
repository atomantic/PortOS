import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getMusicVideoCompositionPreview: vi.fn(),
  getMusicVideoCompositionDocument: vi.fn(),
  startMusicVideoCompositionTemplate: vi.fn(),
  importMusicVideoCompositionZip: vi.fn(),
  importMusicVideoCompositionDirectory: vi.fn(),
  getMusicVideoCompositionExport: vi.fn(),
  detachMusicVideoCompositionDocument: vi.fn(),
  fetchMusicVideoPreviewAsset: vi.fn(),
}));
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import DocumentCompositionPanel from './DocumentCompositionPanel.jsx';

const DOCUMENT = { directory: 'music-video/mv-1/composition/doc-a', entry: 'index.html', updatedAt: '2026-01-01T00:00:00.000Z', source: { kind: 'template', name: 'layered' }, files: 9, bytes: 90000 };
const bare = { id: 'mv-1', name: 'Example', updatedAt: '2026-01-01T00:00:00.000Z', composition: { mode: 'document' } };
const attached = { ...bare, composition: { mode: 'document', document: DOCUMENT } };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getMusicVideoCompositionPreview.mockResolvedValue({ html: '<!doctype html><p>preview</p>', assets: [], width: 1920, height: 1080, fps: 24, durationSec: 10 });
  api.startMusicVideoCompositionTemplate.mockResolvedValue({ project: attached, document: DOCUMENT });
  api.detachMusicVideoCompositionDocument.mockResolvedValue({ project: bare });
});

describe('DocumentCompositionPanel', () => {
  it('starts from the template in one click when nothing is attached, and builds no preview', async () => {
    const onProject = vi.fn();
    render(<DocumentCompositionPanel project={bare} audioUrl={null} onProject={onProject} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Start from template/ }));
    await waitFor(() => expect(onProject).toHaveBeenCalledWith(attached));
    expect(api.startMusicVideoCompositionTemplate).toHaveBeenCalledWith('mv-1', 'layered', { silent: true });
    expect(api.getMusicVideoCompositionPreview).not.toHaveBeenCalled();
  });

  it('shows the attached document in a sandboxed preview and asks twice before replacing or detaching it', async () => {
    const onProject = vi.fn();
    render(<DocumentCompositionPanel project={attached} audioUrl={null} onProject={onProject} onSave={vi.fn()} />);
    expect(screen.getByText(/template · layered · 9 files/)).toBeTruthy();
    const frame = await screen.findByTitle('Composition document preview');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');

    fireEvent.click(screen.getByRole('button', { name: /Replace with template/ }));
    expect(api.startMusicVideoCompositionTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Click again to replace/ }));
    await waitFor(() => expect(api.startMusicVideoCompositionTemplate).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /^Detach/ }));
    expect(api.detachMusicVideoCompositionDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Click again to detach/ }));
    await waitFor(() => expect(onProject).toHaveBeenLastCalledWith(bare));
  });
});
