import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LocalLlmRuntimesView from './LocalLlmRuntimesView.jsx';

const fakeRuntime = vi.hoisted(() => {
  let status = { installed: false, running: false };
  return {
    status: vi.fn(async () => status),
    install: vi.fn(async () => {
      status = { installed: true, running: false, cachedModels: ['example/checkpoint'] };
    }),
    start: vi.fn(async () => {
      status = { ...status, running: true, managed: true };
    }),
    stop: vi.fn(async () => {
      status = { ...status, running: false };
    }),
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
});
