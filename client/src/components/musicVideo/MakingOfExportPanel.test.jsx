import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import MakingOfExportPanel from './MakingOfExportPanel.jsx';

const { api, downloadBlob, toast } = vi.hoisted(() => ({ api: {
  getMusicVideoMakingOfCatalog: vi.fn(), listMusicVideoProjectSummaries: vi.fn(), previewMusicVideoMakingOf: vi.fn(), exportMusicVideoMakingOf: vi.fn(),
}, downloadBlob: vi.fn(), toast: { error: vi.fn() } }));
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../lib/downloadBlob.js', () => ({ downloadBlob }));
vi.mock('../ui/Toast', () => ({ default: toast }));
const project = { id: 'mv-example', name: 'Example Blueprint', version: 1 };
const catalog = (id = 'mv-example') => ({ project: { id, name: id === 'mv-example' ? 'Example Blueprint' : 'Example Hybrid', version: 1 }, snapshot: 'a'.repeat(64),
  assets: [{ id: 'artifact:example:v1', label: 'Example guide · v1', kind: 'cast-sets', status: 'included', bytes: 100 },
    { id: 'frame:scene-example', label: 'Missing frame', kind: 'storyboard', status: 'missing', reason: 'not-generated' }] });
const result = { previewDigest: 'b'.repeat(64), bytes: 300, files: [{ path: 'README.md', bytes: 300, sha256: 'c'.repeat(64) }],
  manifest: { inventory: [{ projectId: 'mv-example', id: 'frame:scene-example', status: 'missing', reason: 'not-generated', rights: 'unknown' }] } };
beforeEach(() => {
  api.getMusicVideoMakingOfCatalog.mockImplementation(async id => catalog(id));
  api.listMusicVideoProjectSummaries.mockResolvedValue({ items: [{ id: 'mv-example', name: 'Example Blueprint' }, { id: 'mv-hybrid', name: 'Example Hybrid' }] });
  api.previewMusicVideoMakingOf.mockResolvedValue(result);
  api.exportMusicVideoMakingOf.mockResolvedValue(new ArrayBuffer(4));
});
afterEach(cleanup);

describe('Making-of export panel', () => {
  it('requires explicit file selection and inventory preview, combines variants, and binds the download to the preview', async () => {
    render(<MakingOfExportPanel project={project} />);
    const guide = await screen.findByRole('checkbox', { name: /Example guide/ });
    expect(guide.checked).toBe(false);
    expect(screen.getByRole('checkbox', { name: /Missing frame/ }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Download planning ZIP' }).disabled).toBe(true);
    fireEvent.click(guide);
    fireEvent.change(screen.getByLabelText('Rights declaration'), { target: { value: 'licensed' } });
    fireEvent.change(screen.getByLabelText('Attribution / license note'), { target: { value: 'Example license' } });
    fireEvent.change(screen.getByLabelText('Add another version or project'), { target: { value: 'mv-hybrid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to package' }));
    await screen.findByText('Example Hybrid · v1');
    fireEvent.click(screen.getByRole('button', { name: 'Preview inventory' }));
    await screen.findByLabelText('Package inventory');
    const selection = api.previewMusicVideoMakingOf.mock.calls[0][0];
    expect(selection.projects).toHaveLength(2);
    expect(selection.projects[0].assets).toEqual([{ id: 'artifact:example:v1', rights: 'licensed', attribution: 'Example license', ownershipConfirmed: false }]);
    expect(screen.getByLabelText('Package inventory').textContent).toContain('missing (not-generated)');
    fireEvent.click(screen.getByRole('button', { name: 'Download planning ZIP' }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'music-video-making-of.zip', 'application/zip'));
    expect(api.exportMusicVideoMakingOf).toHaveBeenCalledWith({ ...selection, previewDigest: result.previewDigest }, { silent: true });
    fireEvent.change(screen.getByLabelText('Attribution / license note'), { target: { value: 'Changed credit' } });
    expect(screen.getByRole('button', { name: 'Download planning ZIP' }).disabled).toBe(true);
  });

  it('drops catalog responses from an earlier project and surfaces catalog failures', async () => {
    let finish;
    api.getMusicVideoMakingOfCatalog.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<MakingOfExportPanel project={project} />);
    rerender(<MakingOfExportPanel project={{ id: 'mv-hybrid' }} />);
    await screen.findByText('Example Hybrid · v1');
    await act(async () => finish(catalog()));
    expect(screen.queryByText('Example Blueprint · v1')).toBeNull();
    api.getMusicVideoMakingOfCatalog.mockRejectedValueOnce(new Error('Catalog unavailable'));
    rerender(<MakingOfExportPanel project={{ id: 'mv-third' }} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Catalog unavailable');
  });

  it('refreshes changed project snapshots before compiling a new inventory', async () => {
    render(<MakingOfExportPanel project={project} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Example guide/ }));
    api.getMusicVideoMakingOfCatalog.mockResolvedValueOnce({ ...catalog(), snapshot: 'd'.repeat(64) });
    fireEvent.click(screen.getByRole('button', { name: 'Preview inventory' }));
    await screen.findByLabelText('Package inventory');
    expect(api.previewMusicVideoMakingOf.mock.calls[0][0].projects[0]).toMatchObject({ snapshot: 'd'.repeat(64), assets: [{ id: 'artifact:example:v1', rights: 'unknown', attribution: '', ownershipConfirmed: false }] });
  });

  it('records explicit ownership for embedded graphics and invalidates its preview when that declaration changes', async () => {
    api.getMusicVideoMakingOfCatalog.mockImplementation(async () => ({ ...catalog(), assets: [{ ...catalog().assets[0], status: 'partial', reason: 'some-visuals-not-exported', visualCount: 26, ownershipDeclarationAvailable: true }] }));
    render(<MakingOfExportPanel project={project} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Example guide/ }));
    const declaration = screen.getByRole('checkbox', { name: /I own this file/ });
    expect(declaration.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Rights declaration'), { target: { value: 'owned' } });
    fireEvent.click(declaration);
    fireEvent.click(screen.getByRole('button', { name: 'Preview inventory' }));
    await screen.findByLabelText('Package inventory');
    expect(api.previewMusicVideoMakingOf.mock.calls[0][0].projects[0].assets[0]).toMatchObject({ rights: 'owned', ownershipConfirmed: true });
    fireEvent.click(declaration);
    expect(screen.getByRole('button', { name: 'Download planning ZIP' }).disabled).toBe(true);
  });
});
