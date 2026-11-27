import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LocalLlmRuntimesView from './LocalLlmRuntimesView.jsx';

const fakeRuntime = vi.hoisted(() => {
  let status = { installed: false, running: false };
  return {
    status: vi.fn(async () => status),
    setStatus: (nextStatus) => { status = nextStatus; },
    install: vi.fn(async () => {
      status = { installed: true, running: false, cachedModels: ['example/checkpoint'] };
    }),
    start: vi.fn(async () => {
      status = { ...status, running: true, managed: true };
    }),
    stop: vi.fn(async () => {
      status = { ...status, running: false };
    }),
    upgrade: vi.fn(async () => {}),
  };
});

vi.mock('./localRuntimeDescriptors.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    LOCAL_RUNTIME_DESCRIPTORS: {
      ...original.LOCAL_RUNTIME_DESCRIPTORS,
      example: {
        ...original.LOCAL_RUNTIME_DESCRIPTORS.mtplx,
        id: 'example',
        label: 'Example runtime',
        api: fakeRuntime,
        capabilities: {},
        copy: {},
      },
    },
  };
});

vi.mock('../../services/apiLocalLlm.js', async (importOriginal) => ({
  ...await importOriginal(),
  getLocalLlmStatus: vi.fn(async () => ({ backend: 'ollama', ollama: {}, lmstudio: {} })),
  getLlamaServerStatus: vi.fn(async () => null),
  getMtplxServerStatus: vi.fn(async () => null),
  getSlotstreamServerStatus: vi.fn(async () => null),
  getManagedInklingRuntimeStatus: vi.fn(async () => null),
}));
vi.mock('../../services/apiProviders', () => ({
  getFleetLlmHost: vi.fn(async () => null),
  stopFleetLlmHost: vi.fn(),
}));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('./LocalPersistentMindSetupCard.jsx', () => ({ default: () => null }));
vi.mock('./HardwareLlmRecommendation.jsx', () => ({ default: () => null }));

describe('local runtime descriptors', () => {
  it('loads and controls a new runtime using only its registered descriptor', async () => {
    render(<MemoryRouter><LocalLlmRuntimesView /></MemoryRouter>);
    const row = within(screen.getByRole('group', { name: 'Example runtime' }));

    fireEvent.click(await row.findByRole('button', { name: 'Install' }));
    await waitFor(() => expect(fakeRuntime.install).toHaveBeenCalledOnce());
    fireEvent.click(await row.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(fakeRuntime.start).toHaveBeenCalledWith({}));
    fireEvent.click(await row.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(fakeRuntime.stop).toHaveBeenCalledOnce());
    expect(await row.findByText('Stopped')).toBeInTheDocument();
  });

  it('offers runtime install when an installed MTPLX wrapper is not bootstrapped', async () => {
    fakeRuntime.setStatus({ installed: true, running: false, runtimeReady: false, cachedModels: [] });
    render(<MemoryRouter><LocalLlmRuntimesView /></MemoryRouter>);
    const row = within(screen.getByRole('group', { name: 'Example runtime' }));

    expect(await row.findByRole('button', { name: 'Install' })).toBeInTheDocument();
    expect(await row.findByText('MTPLX runtime is not ready — use Install to download it')).toBeInTheDocument();
  });

  it('maps MTPLX runtime versions and updates to the roster row', async () => {
    fakeRuntime.setStatus({
      installed: true,
      running: false,
      runtimeReady: true,
      runtimeVersion: '1.0.0',
      lockedVersion: '1.1.0',
      runtimeOutdated: true,
      cachedModels: ['example/checkpoint'],
    });
    render(<MemoryRouter><LocalLlmRuntimesView /></MemoryRouter>);
    const row = within(screen.getByRole('group', { name: 'Example runtime' }));

    expect(await row.findByRole('button', { name: /Update/ })).toBeInTheDocument();
    expect(await row.findByText(/1\.0\.0/)).toBeInTheDocument();
  });
});
