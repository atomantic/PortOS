import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiSystem.js', () => ({ rectifyModelDuplicates: vi.fn(async () => ({ reclaimedBytes: 1024 })) }));
const { rectifyModelDuplicates } = await import('../../services/apiSystem.js');

const memory = vi.hoisted(() => ({ publish: null }));
vi.mock('../settings/MemoryManagement.jsx', () => ({
  default: ({ onLoadedModelsChange }) => {
    memory.publish = onLoadedModelsChange;
    return <div>Memory status</div>;
  },
}));

vi.mock('../ui/Toast');
const toast = (await import('../ui/Toast')).default;

const ModelsPanel = (await import('./ModelsPanel.jsx')).default;

const model = {
  id: 'ollama:example:latest',
  backend: 'ollama',
  name: 'Example model',
  sizeBytes: 1024,
  loaded: false,
  managePath: '/models/llms',
  action: { type: 'local-model', backend: 'ollama', modelId: 'example:latest' },
};
const report = {
  generatedAt: '2026-08-16T00:00:00.000Z',
  sourceErrors: [],
  models: { downloaded: [model], totals: { all: 1024 } },
  cleanupCandidates: [{
    ...model,
    label: model.name,
    estimatedBytes: model.sizeBytes,
    action: model.action,
    busy: false,
    manualOnly: false,
  }],
};
const cleanup = {
  busyId: null,
  locked: false,
  isConfirming: vi.fn(() => false),
  request: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
};

describe('ModelsPanel converted sources', () => {
  it('offers prune only where the row carries a source action', () => {
    const fastvideo = {
      id: 'fastvideo-mlx:snap',
      backend: 'fastvideo-mlx',
      name: 'snap',
      detail: 'Converted MLX checkpoint · Org/Repo@aaaaaaaa · source weights (re-downloadable; needed only to re-convert)',
      sizeBytes: 10,
      sourcePrune: { backend: 'fastvideo-mlx', key: 'snap' },
      action: { type: 'model-store', backend: 'fastvideo-mlx', key: 'snap' },
    };
    const auk = {
      id: 'auk-ckpts:AuK-Flash',
      backend: 'auk-ckpts',
      name: 'AuK-Flash',
      detail: 'AuK voice runtime checkpoint · tencent/AuK-Flash · the AuK runtime reads these weights',
      sizeBytes: 10,
      action: { type: 'model-store', backend: 'auk-ckpts', key: 'AuK-Flash' },
    };
    const requestPrune = vi.fn();
    render(
      <MemoryRouter>
        <ModelsPanel
          report={{ ...report, models: { downloaded: [fastvideo, auk], totals: { all: 20 } } }}
          loading={false}
          onRunReport={vi.fn()}
          cleanup={{ ...cleanup, requestPrune, isPruneConfirming: () => false }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/source weights \(re-downloadable; needed only to re-convert\)/)).toBeInTheDocument();
    expect(screen.getByText(/the AuK runtime reads these weights/)).toBeInTheDocument();
    const prune = screen.getAllByRole('button', { name: 'Prune source' });
    expect(prune).toHaveLength(1);
    fireEvent.click(prune[0]);
    expect(requestPrune).toHaveBeenCalledWith('fastvideo-mlx:snap');
  });
});

describe('ModelsPanel live residency', () => {
  it('revokes a stale delete action when the model becomes resident', () => {
    render(
      <MemoryRouter>
        <ModelsPanel report={report} loading={false} onRunReport={vi.fn()} cleanup={cleanup} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Remove Example model' })).toBeInTheDocument();

    act(() => memory.publish({
      ollama: [{ id: 'example:latest', name: 'example:latest' }],
      lmstudio: [],
      sourceErrors: [],
    }));

    expect(screen.getByText('loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Example model' })).not.toBeInTheDocument();
  });

  it('fails closed when live residency becomes unknown', () => {
    render(
      <MemoryRouter>
        <ModelsPanel report={report} loading={false} onRunReport={vi.fn()} cleanup={cleanup} />
      </MemoryRouter>,
    );

    act(() => memory.publish({ ollama: [], lmstudio: [], sourceErrors: ['ollama'] }));

    expect(screen.getByText('status unknown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Example model' })).not.toBeInTheDocument();
  });

  it('hides unavailable sources the user intentionally disabled', () => {
    render(
      <MemoryRouter>
        <ModelsPanel
          report={{
            ...report,
            sourceErrors: ['lmstudio-backend', 'ollama-backend'],
            disabledSources: ['lmstudio'],
          }}
          loading={false}
          onRunReport={vi.fn()}
          cleanup={cleanup}
        />
      </MemoryRouter>,
    );

    const warning = screen.getByText(/Some model sources are unavailable:/);
    expect(warning.textContent).toContain('ollama-backend');
    expect(warning.textContent).not.toContain('lmstudio-backend');
  });
});

it.each([false, true])('confirms duplicate linking and refreshes the inventory (refresh fails: %s)', async (refreshFails) => {
  const refresh = vi.fn();
  if (refreshFails) refresh.mockRejectedValueOnce(new Error('Refresh failed'));
  render(<MemoryRouter><ModelsPanel report={{ ...report, modelDuplicates: {
    items: [
      { model: 'Example weights', sourcePath: '/models/example.safetensors', targetPath: '/pinokio/example.safetensors', canLink: true, sizeBytes: 1024, reclaimableBytes: 1024 },
      { model: 'Other weights', sourcePath: '/models/other.safetensors', targetPath: '/pinokio/other.safetensors', canLink: true, sizeBytes: 2048, reclaimableBytes: 2048 },
    ],
  } }} loading={false} onRunReport={refresh} cleanup={cleanup} /></MemoryRouter>);
  expect(screen.getByText('Duplicate Model Weights')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Link & Reclaim 1 KB' }));
  expect(rectifyModelDuplicates).not.toHaveBeenCalled();
  expect(screen.getByText(/In-place edits affect both applications/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm linking' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(rectifyModelDuplicates).toHaveBeenCalledWith({ mode: 'hardlink', pairs: [{
    sourcePath: '/models/example.safetensors', targetPath: '/pinokio/example.safetensors',
  }] }, { silent: true });
  if (refreshFails) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Link & Reclaim 2 KB' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('Refresh failed');
  }
});

it.each([false, true])('names the repos and bytes before a hub clone can be armed (refresh fails: %s)', async (refreshFails) => {
  const refresh = vi.fn();
  if (refreshFails) refresh.mockRejectedValueOnce(new Error('Refresh failed'));
  const blob = 'ab'.repeat(32);
  const sourcePath = `/cache/models--example--base/blobs/${blob}`;
  const targetPath = `/cache/models--example--distilled/blobs/${blob}`;
  render(<MemoryRouter><ModelsPanel report={{ ...report, modelDuplicates: {
    items: [],
    hub: {
      cloneSupported: true,
      apparentSizeNote: 'Finder and du count each clone at its full size.',
      totalReclaimableBytes: 2048,
      groups: [{
        blobName: blob,
        sizeBytes: 2048,
        repos: ['models--example--base', 'models--example--distilled'],
        logicalDuplicateBytes: 2048,
        reclaimableBytes: 2048,
        canClone: true,
        sourcePath,
        replacements: [{ repo: 'models--example--distilled', path: targetPath, reclaimableBytes: 2048 }],
      }],
    },
  } }} loading={false} onRunReport={refresh} cleanup={cleanup} /></MemoryRouter>);
  expect(screen.getByText(/Finder and du count each clone/)).toBeInTheDocument();
  expect(screen.getByText(/models--example--base, models--example--distilled/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clone duplicates' }));
  expect(rectifyModelDuplicates).not.toHaveBeenCalled();
  const confirm = screen.getByRole('button', { name: 'Clone and reclaim' });
  expect(confirm).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /models--example--base, models--example--distilled and reclaim 2 KB/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox'));
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(rectifyModelDuplicates).toHaveBeenCalledWith({ mode: 'clone', pairs: [{ sourcePath, targetPath }] }, { silent: true });
  if (refreshFails) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clone duplicates' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('Refresh failed');
  }
});

it('explains hub duplicates that cannot be cloned', () => {
  const blob = 'cd'.repeat(32);
  render(<MemoryRouter><ModelsPanel report={{ ...report, modelDuplicates: {
    items: [],
    hub: {
      cloneSupported: false,
      apparentSizeNote: 'Finder and du count each clone at its full size.',
      totalReclaimableBytes: 0,
      groups: [{
        blobName: blob,
        sizeBytes: 4096,
        repos: ['models--example--base', 'models--example--small'],
        logicalDuplicateBytes: 4096,
        reclaimableBytes: 0,
        canClone: false,
        reason: 'clones-unavailable',
        sourcePath: '/cache/a',
        replacements: [],
      }],
    },
  } }} loading={false} onRunReport={vi.fn()} cleanup={cleanup} /></MemoryRouter>);
  expect(screen.getByText(/Hardlinks are not used/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clone duplicates' })).not.toBeInTheDocument();
});
