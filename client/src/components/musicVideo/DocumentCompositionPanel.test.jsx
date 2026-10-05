import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
// The shared Film style picker reads the catalog through the api barrel.
vi.mock('../../services/api', () => ({
  listFilmStyles: vi.fn(async () => [{ id: 'example-style', label: 'Example style', summary: 'A fixture style.', nativeMoves: [] }]),
  getFilmStyle: vi.fn(async () => ({ id: 'example-style', nativeMoves: [] })),
}));
const authorProvider = vi.hoisted(() => ({ type: 'api', toolFreeOneShot: true }));
vi.mock('../../hooks/useProviderModels.js', () => ({ default: () => ({
  providers: [{ id: 'stub-provider', name: 'Stub Provider', models: ['fixture-model'], ...authorProvider }],
  selectedProviderId: 'stub-provider', selectedModel: 'fixture-model', availableModels: ['fixture-model'],
  selectedProvider: { providerId: 'stub-provider', model: 'fixture-model' },
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

afterEach(() => { vi.useRealTimers(); });

beforeEach(() => {
  Object.assign(authorProvider, { type: 'api', toolFreeOneShot: true });
  for (const fn of Object.values(api)) fn.mockReset();
  api.startMusicVideoCompositionTemplate.mockResolvedValue({ project: attached, document: DOCUMENT });
  api.detachMusicVideoCompositionDocument.mockResolvedValue({ project: bare });
});

describe('DocumentCompositionPanel', () => {
  it('keeps an unsupported selected author visible but blocks generation until its CLI capability is verified', async () => {
    Object.assign(authorProvider, { type: 'cli', toolFreeOneShot: false });
    const props = { project: bare, onProject: vi.fn(), onSave: vi.fn() };
    const view = render(<DocumentCompositionPanel {...props} />);
    expect(screen.getByRole('option', { name: 'Stub Provider (not permitted here)' }).disabled).toBe(true);
    expect(screen.queryByRole('option', { name: /Custom combination/ })).toBeNull();
    const generate = screen.getByRole('button', { name: 'Generate mixed-media composition' });
    expect(generate.disabled).toBe(true);
    fireEvent.click(generate);
    expect(api.generateMusicVideoMixedMediaDocument).not.toHaveBeenCalled();
    Object.assign(authorProvider, { type: 'tui', toolFreeOneShot: true });
    view.rerender(<DocumentCompositionPanel {...props} />);
    expect(generate.disabled).toBe(true);
    authorProvider.type = 'cli';
    view.rerender(<DocumentCompositionPanel {...props} />);
    expect(generate.disabled).toBe(false);
    api.generateMusicVideoMixedMediaDocument.mockResolvedValue({ project: bare });
    fireEvent.click(generate);
    await waitFor(() => expect(api.generateMusicVideoMixedMediaDocument).toHaveBeenCalledWith('mv-1', { providerId: 'stub-provider', model: 'fixture-model' }, { silent: true }));
  });

  it('authors a code-only project and previews and accepts a Three.js scene candidate', async () => {
    const saved = { ...bare, mediaMode: 'code-only' };
    api.updateMusicVideoProject.mockResolvedValue(saved);
    api.generateMusicVideoMixedMediaDocument.mockResolvedValue({ project: { ...saved, composition: { ...saved.composition, documentDraft: generated } } });
    api.getMusicVideoMixedMediaCandidate.mockResolvedValue({ candidate: generated, source: generated, stale: false, sections: [{ id: 'world', label: 'World' }] });
    api.acceptMusicVideoMixedMediaDocument.mockResolvedValue({ project: { ...saved, composition: { ...saved.composition, document: generated } } });
    const onProject = vi.fn();
    const view = render(<DocumentCompositionPanel project={saved} onProject={onProject} onSave={vi.fn()} />);
    expect(screen.queryByLabelText('Design and composition media')).toBeNull(); // media mode is chosen in Setup only
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

  it('saves a film style grammar on the composition and clears it by omitting the key', async () => {
    const styled = { ...attached, composition: { ...attached.composition, styleGrammarId: 'example-style' } };
    api.updateMusicVideoProject.mockResolvedValueOnce(styled).mockResolvedValueOnce(attached);
    const onProject = vi.fn();
    const view = render(<DocumentCompositionPanel project={attached} onProject={onProject} onSave={vi.fn()} />);
    await screen.findByRole('option', { name: 'Example style' });
    fireEvent.change(screen.getByLabelText(/^film style/i), { target: { value: 'example-style' } });
    await waitFor(() => expect(onProject).toHaveBeenCalledWith(styled));
    expect(api.updateMusicVideoProject.mock.calls[0][1].composition).toMatchObject({ mode: 'document', styleGrammarId: 'example-style' });
    view.rerender(<DocumentCompositionPanel project={styled} onProject={onProject} onSave={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/^film style/i).value).toBe('example-style'));
    fireEvent.change(screen.getByLabelText(/^film style/i), { target: { value: '' } });
    await waitFor(() => expect(api.updateMusicVideoProject).toHaveBeenCalledTimes(2));
    expect(api.updateMusicVideoProject.mock.calls[1][1].composition).not.toHaveProperty('styleGrammarId');
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
    // The source summary is folded into the Document source section header; file count sits in the panel header.
    expect(screen.getByText('template · layered')).toBeTruthy();
    expect(screen.getByText(/9 files/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Replace with template/ }));
    expect(api.startMusicVideoCompositionTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Click again to replace/ }));
    await waitFor(() => expect(api.startMusicVideoCompositionTemplate).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /^Detach/ }));
    expect(api.detachMusicVideoCompositionDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Click again to detach/ }));
    await waitFor(() => expect(onProject).toHaveBeenLastCalledWith(bare));
  });

  it('expires the replace and detach confirmations after 5 seconds without acting', async () => {
    vi.useFakeTimers();
    render(<DocumentCompositionPanel project={attached} onProject={vi.fn()} onSave={vi.fn()} />);
    await act(async () => {}); // settle the film style catalog load

    fireEvent.click(screen.getByRole('button', { name: /Replace with template/ }));
    expect(screen.getByRole('button', { name: /Click again to replace/ })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(4900); });
    expect(screen.getByRole('button', { name: /Click again to replace/ })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole('button', { name: /Click again to replace/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Replace with template/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Detach/ }));
    expect(screen.getByRole('button', { name: /Click again to detach/ })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(5100); });
    expect(screen.queryByRole('button', { name: /Click again to detach/ })).toBeNull();

    expect(api.startMusicVideoCompositionTemplate).not.toHaveBeenCalled();
    expect(api.detachMusicVideoCompositionDocument).not.toHaveBeenCalled();
  });

  it('opens candidate review automatically when a candidate exists', async () => {
    api.getMusicVideoMixedMediaCandidate.mockResolvedValue({ candidate: generated, source: generated, stale: false,
      sections: [{ id: 'verse', label: 'Verse', startSec: 0, endSec: 10 }] });
    const { container } = render(<DocumentCompositionPanel project={withCandidate} onProject={vi.fn()} onSave={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept reviewed version' });
    expect(container.querySelector('#mv-doc-candidate').open).toBe(true);
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
