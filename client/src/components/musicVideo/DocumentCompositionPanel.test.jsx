import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getMusicVideoCompositionDocument: vi.fn(),
  startMusicVideoCompositionTemplate: vi.fn(),
  importMusicVideoCompositionZip: vi.fn(),
  importMusicVideoCompositionDirectory: vi.fn(),
  getMusicVideoCompositionExport: vi.fn(),
  detachMusicVideoCompositionDocument: vi.fn(),
  getMusicVideoMixedMediaCandidate: vi.fn(),
  generateMusicVideoMixedMediaDocument: vi.fn(),
  regenerateMusicVideoMixedMediaSection: vi.fn(),
  acceptMusicVideoMixedMediaDocument: vi.fn(),
  discardMusicVideoMixedMediaDocument: vi.fn(),
  reviseMusicVideoMixedMediaEvents: vi.fn(),
  updateMusicVideoProject: vi.fn(),
}));
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../hooks/useProviderModels.js', () => ({ default: () => ({
  providers: [{ id: 'stub-provider', name: 'Stub Provider', models: ['fixture-model'] }],
  selectedProviderId: 'stub-provider', selectedModel: 'fixture-model', availableModels: ['fixture-model'],
  selectedProvider: { id: 'stub-provider', name: 'Stub Provider' },
  setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(),
}) }));
vi.mock('./CompositionPreviewPlayer.jsx', () => ({ default: () => <div>Candidate preview</div> }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import DocumentCompositionPanel from './DocumentCompositionPanel.jsx';

const DOCUMENT = { directory: 'music-video/mv-1/composition/doc-a', entry: 'index.html', updatedAt: '2026-01-01T00:00:00.000Z', source: { kind: 'template', name: 'layered' }, files: 9, bytes: 90000 };
const bare = { id: 'mv-1', name: 'Example', updatedAt: '2026-01-01T00:00:00.000Z', composition: { mode: 'document' } };
const attached = { ...bare, composition: { mode: 'document', document: DOCUMENT } };
const generated = { ...DOCUMENT, directory: 'music-video/mv-1/composition/doc-generated', source: { kind: 'generated', name: 'Mixed-media composition' } };
const withCandidate = { ...bare, composition: { mode: 'document', document: DOCUMENT, documentDraft: generated } };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.startMusicVideoCompositionTemplate.mockResolvedValue({ project: attached, document: DOCUMENT });
  api.detachMusicVideoCompositionDocument.mockResolvedValue({ project: bare });
});

describe('DocumentCompositionPanel', () => {
  it('selects code-only and authors, previews and accepts a Three.js scene candidate', async () => {
    const saved = { ...bare, mediaMode: 'code-only' };
    api.updateMusicVideoProject.mockResolvedValue(saved);
    api.generateMusicVideoMixedMediaDocument.mockResolvedValue({ project: { ...saved, composition: { ...saved.composition, documentDraft: generated } } });
    api.getMusicVideoMixedMediaCandidate.mockResolvedValue({ candidate: generated, source: generated, stale: false, sections: [{ id: 'world', label: 'World' }] });
    api.acceptMusicVideoMixedMediaDocument.mockResolvedValue({ project: { ...saved, composition: { ...saved.composition, document: generated } } });
    const onProject = vi.fn();
    const view = render(<DocumentCompositionPanel project={bare} onProject={onProject} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Design and composition media'), { target: { value: 'code-only' } });
    await waitFor(() => expect(onProject).toHaveBeenCalledWith(saved));
    view.rerender(<DocumentCompositionPanel project={saved} onProject={onProject} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Authoring renderer').value).toBe('three');
    fireEvent.click(screen.getByRole('button', { name: 'Generate authored 3D composition' }));
    await waitFor(() => expect(api.generateMusicVideoMixedMediaDocument).toHaveBeenCalledWith('mv-1', { providerId: 'stub-provider', model: 'fixture-model' }, { silent: true }));
    const next = onProject.mock.calls.at(-1)[0];
    view.rerender(<DocumentCompositionPanel project={next} onProject={onProject} onSave={vi.fn()} />);
    await screen.findByText('Candidate preview');
    fireEvent.click(await screen.findByRole('button', { name: /Accept/ }));
    await waitFor(() => expect(api.acceptMusicVideoMixedMediaDocument).toHaveBeenCalled());
  });

  it('gates authoring on saved event bindings and sends an event-only revision against the reviewed document', async () => {
    api.getMusicVideoMixedMediaCandidate.mockResolvedValue({ candidate: generated, source: generated, stale: true, eventRevisionAvailable: true,
      sections: [{ id: 'verse', label: 'Verse', startSec: 0, endSec: 10 }] });
    let finishSave;
    api.updateMusicVideoProject.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    const onProject = vi.fn();
    const { rerender } = render(<DocumentCompositionPanel project={withCandidate} onProject={onProject} onSave={vi.fn()} />);
    const revise = await screen.findByRole('button', { name: 'Revise events only' });
    await waitFor(() => expect(revise.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add narrative event' }));
    expect(screen.getByRole('button', { name: /Generate mixed-media/ }).disabled).toBe(true);
    expect(revise.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save event bindings' }));
    await waitFor(() => expect(api.updateMusicVideoProject).toHaveBeenCalledTimes(1));
    const saved = { ...withCandidate, updatedAt: '2026-01-02', composition: api.updateMusicVideoProject.mock.calls[0][1].composition };
    expect(saved.composition.narrativeEvents[0]).toMatchObject({ kind: 'reveal', anchor: { kind: 'time', atSec: 0 } });
    expect(revise.disabled).toBe(true);
    finishSave(saved);
    await waitFor(() => expect(onProject).toHaveBeenCalledWith(saved));
    rerender(<DocumentCompositionPanel project={saved} onProject={onProject} onSave={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revise events only' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Revise events only' }));
    await waitFor(() => expect(api.reviseMusicVideoMixedMediaEvents).toHaveBeenCalledWith('mv-1', {
      providerId: 'stub-provider', model: 'fixture-model', expectedDraft: generated.directory,
    }, { silent: true }));
    expect(api.generateMusicVideoMixedMediaDocument).not.toHaveBeenCalled();
  });

  it('starts from the template in one click when nothing is attached', async () => {
    const onProject = vi.fn();
    render(<DocumentCompositionPanel project={bare} onProject={onProject} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Start from template/ }));
    await waitFor(() => expect(onProject).toHaveBeenCalledWith(attached));
    expect(api.startMusicVideoCompositionTemplate).toHaveBeenCalledWith('mv-1', 'layered', { silent: true });
  });

  it('shows the attached document and asks twice before replacing or detaching it', async () => {
    const onProject = vi.fn();
    render(<DocumentCompositionPanel project={attached} onProject={onProject} onSave={vi.fn()} />);
    expect(screen.getByText(/template · layered · 9 files/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Replace with template/ }));
    expect(api.startMusicVideoCompositionTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Click again to replace/ }));
    await waitFor(() => expect(api.startMusicVideoCompositionTemplate).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /^Detach/ }));
    expect(api.detachMusicVideoCompositionDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Click again to detach/ }));
    await waitFor(() => expect(onProject).toHaveBeenLastCalledWith(bare));
  });

  it('keeps the active document while a generated candidate is reviewed and explicitly accepted', async () => {
    api.getMusicVideoMixedMediaCandidate.mockResolvedValue({
      candidate: generated, source: generated, stale: false, providerId: 'stub-provider', model: 'fixture-model',
      sections: [{ id: 'verse', label: 'Verse', startSec: 0, endSec: 10 }],
    });
    api.acceptMusicVideoMixedMediaDocument.mockResolvedValue({ project: { ...bare, composition: { mode: 'document', document: generated } } });
    const onProject = vi.fn();
    render(<DocumentCompositionPanel project={withCandidate} onProject={onProject} onSave={vi.fn()} />);
    expect(await screen.findByText('Candidate preview')).toBeTruthy();
    expect(api.acceptMusicVideoMixedMediaDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept reviewed version' }));
    await waitFor(() => expect(api.acceptMusicVideoMixedMediaDocument).toHaveBeenCalledWith('mv-1', generated.directory, { silent: true }));
    expect(onProject).toHaveBeenCalled();
  });

  it('does not regenerate a section removed by a refreshed candidate timeline', async () => {
    const next = { ...generated, directory: 'music-video/mv-1/composition/doc-next' };
    api.getMusicVideoMixedMediaCandidate
      .mockResolvedValueOnce({ candidate: generated, source: generated, stale: false,
        sections: [{ id: 'verse', label: 'Verse', startSec: 0, endSec: 10 }] })
      .mockResolvedValueOnce({ candidate: next, source: next, stale: false,
        sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 10 }] });
    const { rerender } = render(<DocumentCompositionPanel project={withCandidate} onProject={vi.fn()} onSave={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Section to revise'), { target: { value: 'verse' } });
    expect(screen.getByRole('button', { name: 'Regenerate section' }).disabled).toBe(false);
    rerender(<DocumentCompositionPanel project={{ ...withCandidate, updatedAt: '2026-01-02T00:00:00.000Z',
      composition: { ...withCandidate.composition, documentDraft: next } }} onProject={vi.fn()} onSave={vi.fn()} />);
    await waitFor(() => expect(api.getMusicVideoMixedMediaCandidate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate section' }).disabled).toBe(true));
    expect(screen.getByLabelText('Section to revise').value).toBe('');
    expect(api.regenerateMusicVideoMixedMediaSection).not.toHaveBeenCalled();
  });
});
