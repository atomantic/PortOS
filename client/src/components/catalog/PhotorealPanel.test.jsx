import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PhotorealPanel from './PhotorealPanel';
import { getCatalogPhotoreal, saveCatalogGreybox, startCatalogPhotorealRender } from '../../services/apiCatalog';

const { handlers } = vi.hoisted(() => ({ handlers: new Map() }));
vi.mock('../../services/socket', () => ({ default: { on: (event, handler) => handlers.set(event, handler), off: (event) => handlers.delete(event) } }));
vi.mock('../../services/apiCatalog', () => ({ getCatalogPhotoreal: vi.fn(), saveCatalogGreybox: vi.fn(), startCatalogPhotorealRender: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn() } }));
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
  getCatalogPhotoreal.mockResolvedValue({ job: null, blendUrl: '/api/catalog/ingredients/plc-example/photoreal/blend', blenderVersion: '5.2.3' });
});

describe('PhotorealPanel', () => {
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
});
