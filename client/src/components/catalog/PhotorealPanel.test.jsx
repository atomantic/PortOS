import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PhotorealPanel from './PhotorealPanel';
import { draftCatalogPhotorealLook, getCatalogPhotoreal, openCatalogPhotorealBlend, previewCatalogPhotorealLookPrompt, saveCatalogGreybox, saveCatalogPhotorealLook, startCatalogPhotorealRender } from '../../services/apiCatalog';

const { handlers } = vi.hoisted(() => ({ handlers: new Map() }));
vi.mock('../../services/socket', () => ({ default: { on: (event, handler) => handlers.set(event, handler), off: (event) => handlers.delete(event) } }));
vi.mock('../../services/apiCatalog', () => ({
  getCatalogPhotoreal: vi.fn(), openCatalogPhotorealBlend: vi.fn(), saveCatalogGreybox: vi.fn(), startCatalogPhotorealRender: vi.fn(),
  draftCatalogPhotorealLook: vi.fn(), previewCatalogPhotorealLookPrompt: vi.fn(), saveCatalogPhotorealLook: vi.fn(),
}));
vi.mock('../musicVideo/MusicVideoLlmPicker', () => ({ default: () => null }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../MediaImage', () => ({ default: (props) => <img alt={props.alt} src={props.src} /> }));

const greybox = {
  source: 'spec', parts: [{ id: 'floor', type: 'box', size: [1, 1, 1] }],
  shots: [{ id: 'wide', label: 'Wide', aspect: '16:9' }, { id: 'booth', label: 'Booth', aspect: '9:16' }],
};
const record = { id: 'plc-example', payload: { greybox } };
const render1 = { mediaKey: 'wide-render.png', kind: 'reference', role: 'photoreal:wide', caption: 'Example Rink: Wide', createdAt: '2026-01-02' };

const show = (props = {}) => render(<MemoryRouter><PhotorealPanel record={record} media={[render1]} {...props} /></MemoryRouter>);

beforeEach(() => {
  vi.resetAllMocks(); handlers.clear();
  try { localStorage.clear(); } catch { /* storage unavailable */ }
  previewCatalogPhotorealLookPrompt.mockResolvedValue({ sentPrompt: 'composed', promptAdditions: [] });
  getCatalogPhotoreal.mockResolvedValue({ job: null, blendUrl: '/api/catalog/ingredients/plc-example/photoreal/blend', blenderVersion: '5.2.3' });
});

describe('PhotorealPanel', () => {
  it('keeps every camera deselected when the last checked camera is unchecked', async () => {
    show();
    const wide = await screen.findByLabelText(/Wide/);
    const booth = screen.getByLabelText(/Booth/);
    expect(wide).toBeChecked();
    expect(booth).toBeChecked();

    fireEvent.click(booth);
    fireEvent.click(wide);

    expect(wide).not.toBeChecked();
    expect(booth).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Render 0 cameras' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Render fly-through/ })).toBeDisabled();
    expect(startCatalogPhotorealRender).not.toHaveBeenCalled();

    fireEvent.click(booth);
    expect(booth).toBeChecked();
    expect(wide).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Render 1 camera' })).toBeEnabled();
  });

  it('renders the picked cameras with the chosen engine and reloads media when the socket says done', async () => {
    const onRendered = vi.fn();
    show({ onRendered });
    expect(await screen.findByRole('link', { name: /Download .blend/ })).toHaveAttribute('href', '/api/catalog/ingredients/plc-example/photoreal/blend');
    fireEvent.click(screen.getByRole('button', { name: 'Cycles final' }));
    fireEvent.click(screen.getByLabelText(/Booth/));
    startCatalogPhotorealRender.mockResolvedValue({ id: 'pr-1', state: 'running', engine: 'cycles', shotIds: ['wide'], startedAt: new Date().toISOString() });
    fireEvent.click(screen.getByRole('button', { name: 'Render 1 camera' }));
    await waitFor(() => expect(startCatalogPhotorealRender).toHaveBeenCalledWith('plc-example', { shotIds: ['wide'], engine: 'cycles', samples: 128 }, { silent: true }));
    expect(await screen.findByRole('button', { name: /Rendering/ })).toBeDisabled();

    await act(async () => handlers.get('catalog:photoreal')({ ingredientId: 'other-place', job: { state: 'done' } }));
    expect(onRendered).not.toHaveBeenCalled();
    await act(async () => handlers.get('catalog:photoreal')({ ingredientId: 'plc-example', job: { id: 'pr-1', state: 'done', engine: 'cycles', shotIds: ['wide'], report: { version: '5.2.3', device: 'GPU', backend: 'METAL' } } }));
    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/GPU \(METAL\)/)).toBeInTheDocument();
  });

  // Catches a fly-through sent as stills, in the wrong camera order, or with no way to reach the saved MP4.
  it('renders a fly-through through the cameras in list order and links the MP4 in Media History', async () => {
    show();
    const fly = await screen.findByRole('button', { name: /Render fly-through \(192 frames\)/ });
    fireEvent.change(screen.getByLabelText('Seconds'), { target: { value: '4' } });
    startCatalogPhotorealRender.mockResolvedValue({ id: 'pr-fly', state: 'running', engine: 'eevee', shotIds: ['wide', 'booth'], flythroughSeconds: 4, startedAt: new Date().toISOString() });
    fireEvent.click(screen.getByRole('button', { name: /Render fly-through \(96 frames\)/ }));
    await waitFor(() => expect(startCatalogPhotorealRender).toHaveBeenCalledWith('plc-example',
      { shotIds: ['wide', 'booth'], engine: 'eevee', samples: 32, flythroughSeconds: 4 }, { silent: true }));
    expect(await screen.findByText(/fly-through, 4s \(96 frames\)/)).toBeInTheDocument();
    await act(async () => handlers.get('catalog:photoreal')({ ingredientId: 'plc-example', job: { id: 'pr-fly', state: 'done', engine: 'eevee', shotIds: ['wide', 'booth'], flythroughSeconds: 4,
      report: { version: '5.2.3', device: 'GPU', backend: 'METAL' }, video: { id: 'upload-abc123', filename: 'upload-abc123.mp4' } } }));
    expect(screen.getByLabelText('Fly-through')).toHaveAttribute('src', '/data/videos/upload-abc123.mp4');
    expect(screen.getByRole('link', { name: 'Open in Media History' })).toHaveAttribute('href', '/media/history?preview=video%3Aupload-abc123');

    // One camera is not a path.
    fireEvent.click(screen.getByLabelText(/Booth/));
    expect(fly).toBeDisabled();
  });

  it('opens the built scene in Blender from the tab', async () => {
    openCatalogPhotorealBlend.mockResolvedValue({ opened: true, blenderVersion: '5.2.3' });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Blender' }));
    await waitFor(() => expect(openCatalogPhotorealBlend).toHaveBeenCalledWith('plc-example', { silent: true }));
  });

  it('lets 10-19 seconds and multi-digit samples be typed, clamping only on blur or render', async () => {
    show();
    const seconds = await screen.findByLabelText('Seconds');
    fireEvent.change(seconds, { target: { value: '1' } });
    fireEvent.change(seconds, { target: { value: '15' } });
    expect(seconds).toHaveValue(15);
    expect(screen.getByRole('button', { name: /Render fly-through \(360 frames\)/ })).toBeInTheDocument();

    // Emptied then left: restores an in-range value.
    fireEvent.change(seconds, { target: { value: '' } });
    fireEvent.blur(seconds);
    expect(seconds).toHaveValue(2);

    const samples = screen.getByLabelText('Samples');
    fireEvent.change(samples, { target: { value: '' } });
    fireEvent.change(samples, { target: { value: '64' } });
    expect(samples).toHaveValue(64);

    // Out-of-range text still in the field is clamped when the render starts.
    startCatalogPhotorealRender.mockResolvedValue({ id: 'pr-c', state: 'running', engine: 'eevee', shotIds: ['wide', 'booth'], startedAt: new Date().toISOString() });
    fireEvent.change(seconds, { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: /Render fly-through/ }));
    await waitFor(() => expect(startCatalogPhotorealRender).toHaveBeenCalled());
    const body = startCatalogPhotorealRender.mock.calls[0][1];
    expect(body.samples).toBe(64);
    expect(body.flythroughSeconds).toBeLessThan(9999);
  });

  it('keeps a finish frame that arrives before the start response', async () => {
    const onRendered = vi.fn();
    show({ onRendered });
    await screen.findByRole('link', { name: /Download .blend/ });
    let respond;
    startCatalogPhotorealRender.mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Render 2 cameras' }));
    await waitFor(() => expect(respond).toBeTypeOf('function'));
    // Same batch: React may commit both together.
    await act(async () => {
      handlers.get('catalog:photoreal')({ ingredientId: 'plc-example', job: { id: 'pr-9', state: 'done', engine: 'eevee', shotIds: ['wide', 'booth'], report: { version: '5.2.3', device: 'GPU', backend: 'METAL' } } });
      respond({ id: 'pr-9', state: 'running', engine: 'eevee', shotIds: ['wide', 'booth'], startedAt: new Date().toISOString() });
    });
    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Render 2 cameras' })).toBeEnabled();
  });

  it('finishes a render still running from an earlier visit to the tab', async () => {
    const onRendered = vi.fn();
    getCatalogPhotoreal.mockResolvedValueOnce({ job: { id: 'pr-5', state: 'running', engine: 'cycles', shotIds: ['wide'], startedAt: new Date().toISOString() }, blendUrl: null, blenderVersion: '5.2.3' });
    show({ onRendered });
    expect(await screen.findByRole('button', { name: /Rendering/ })).toBeDisabled();
    await act(async () => handlers.get('catalog:photoreal')({ ingredientId: 'plc-example', job: { id: 'pr-5', state: 'done', engine: 'cycles', shotIds: ['wide'], report: { version: '5.2.3', device: 'GPU', backend: 'METAL' } } }));
    expect(onRendered).toHaveBeenCalledTimes(1);
  });

  it('acts on a finish frame that lands before the status read on reopen', async () => {
    const onRendered = vi.fn();
    let answer;
    getCatalogPhotoreal.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    show({ onRendered });
    await act(async () => handlers.get('catalog:photoreal')({ ingredientId: 'plc-example', job: { id: 'pr-6', state: 'failed', error: 'Out of memory', engine: 'cycles', shotIds: ['wide'] } }));
    await act(async () => answer({ job: { id: 'pr-6', state: 'running', engine: 'cycles', shotIds: ['wide'], startedAt: new Date().toISOString() }, blendUrl: null, blenderVersion: '5.2.3' }));
    expect((await import('../ui/Toast')).default.error).toHaveBeenCalledWith('Blender render failed: Out of memory');
    expect(screen.getByRole('alert')).toHaveTextContent('Out of memory');
    await act(async () => handlers.get('catalog:photoreal')({ ingredientId: 'plc-example', job: { id: 'pr-6', state: 'failed', error: 'Out of memory' } }));
    expect((await import('../ui/Toast')).default.error).toHaveBeenCalledTimes(1);
  });

  it('settles a render whose finish frame was missed while the socket was down', async () => {
    const onRendered = vi.fn();
    getCatalogPhotoreal.mockResolvedValueOnce({ job: { id: 'pr-7', state: 'running', engine: 'cycles', shotIds: ['wide'], startedAt: new Date().toISOString() }, blendUrl: null, blenderVersion: '5.2.3' });
    show({ onRendered });
    expect(await screen.findByRole('button', { name: /Rendering/ })).toBeDisabled();
    getCatalogPhotoreal.mockResolvedValue({ job: { id: 'pr-7', state: 'done', engine: 'cycles', shotIds: ['wide'], report: { version: '5.2.3', device: 'GPU', backend: 'METAL' } }, blendUrl: '/api/catalog/ingredients/plc-example/photoreal/blend', blenderVersion: '5.2.3' });
    await act(async () => handlers.get('connect')());
    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Render 2 cameras' })).toBeEnabled();
    expect(screen.getByRole('link', { name: /Download .blend/ })).toBeInTheDocument();
  });

  it('sets the newest render as the camera photo plate on the saved greybox', async () => {
    const onSaved = vi.fn();
    saveCatalogGreybox.mockResolvedValue({ id: 'plc-example', payload: {} });
    show({ onSaved });
    fireEvent.click(await screen.findByRole('button', { name: 'Use as photo plate' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, saved] = saveCatalogGreybox.mock.calls[0];
    expect(saved.shots.find((s) => s.id === 'wide')).toMatchObject({ plate: 'wide-render.png' });
    expect(saved.shots.find((s) => s.id === 'booth').plate).toBeUndefined();
  });

  it('drafts a look with AI as a preview and saves it only on Apply', async () => {
    const onSaved = vi.fn();
    const look = { materials: [{ id: 'maple', part: 'floor', preset: 'wood-floor', color: '#c89a5a', wear: 0.3, emission: 0 }], lights: [{ id: 'panel', type: 'area' }], atmosphere: { haze: 0.2, exposure: 0, sun: false } };
    draftCatalogPhotorealLook.mockResolvedValue({ look, edited: false, providerId: 'p1', model: 'm1', sentPrompt: 'composed', promptAdditions: [] });
    saveCatalogPhotorealLook.mockResolvedValue({ id: 'plc-example', payload: { photoreal: look } });
    show({ onSaved });
    fireEvent.change(await screen.findByLabelText('Describe the look'), { target: { value: 'waxed maple floor, light haze' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dress with AI' }));
    await waitFor(() => expect(draftCatalogPhotorealLook).toHaveBeenCalledWith('plc-example', expect.objectContaining({ instruction: 'waxed maple floor, light haze', useCurrent: false }), { silent: true }));
    expect(await screen.findByText(/Draft look, not saved yet/)).toBeInTheDocument();
    expect(screen.getByText(/floor: wood-floor, worn/)).toBeInTheDocument();
    expect(saveCatalogPhotorealLook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply look' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saveCatalogPhotorealLook).toHaveBeenCalledWith('plc-example', look, { source: 'refine', silent: true });
  });
});
