/**
 * Models → Status hosts BOTH halves of "what models does this machine have":
 * residency (loaded right now) and the downloaded-model inventory that used to
 * live at Dev Tools' `/system-resources/models` (#4728).
 *
 * The fold is only real if the inventory actually renders here — and only
 * tolerable if it does NOT scan on mount: the scan walks the Hugging Face cache,
 * `data/loras/`, Ollama and LM Studio, which is slow and wasted on a user who
 * came to unload a model.
 *
 * What the page shows INSTEAD of that scan is the manifest the server maintains
 * as models are installed and removed. These tests pin the three things that
 * makes load-bearing: the manifest renders without a scan, an unreconciled
 * install still offers the one-time scan rather than claiming an empty machine,
 * and an explicit scan still replaces what the record said.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const runSystemResourceReport = vi.fn();
const getTrackedModelInventory = vi.fn();
vi.mock('../../services/api', () => ({
  runSystemResourceReport: (...a) => runSystemResourceReport(...a),
  getTrackedModelInventory: (...a) => getTrackedModelInventory(...a),
  purgeDataCategory: vi.fn(),
  deleteCachedModel: vi.fn(),
  deleteLora: vi.fn(),
  deleteLocalLlmModel: vi.fn(),
}));

vi.mock('../settings/MemoryManagement.jsx', () => ({ default: () => <div>residency panel</div> }));

import ModelStatusTab from './ModelStatusTab';

const REPORT = {
  generatedAt: '2026-08-21T00:00:00.000Z',
  inventorySource: 'scan',
  cleanupCandidates: [],
  sourceErrors: [],
  models: {
    downloaded: [{
      id: 'hf:models--example--model',
      name: 'example-model',
      backend: 'huggingface',
      sizeBytes: 2048,
      loaded: false,
    }],
    loaded: [],
    totals: { all: 2048 },
  },
};

const MANIFEST = {
  inventorySource: 'manifest',
  generatedAt: '2026-08-20T00:00:00.000Z',
  reconciledAt: '2026-08-20T00:00:00.000Z',
  cleanupCandidates: [],
  sourceErrors: [],
  models: {
    downloaded: [{
      id: 'lora:tracked-example.safetensors',
      name: 'tracked-example',
      backend: 'lora',
      sizeBytes: 512,
      loaded: false,
      installedAt: '2026-08-19T00:00:00.000Z',
      source: 'install',
    }],
    loaded: [],
    totals: { all: 512 },
  },
};

const EMPTY_MANIFEST = {
  inventorySource: 'manifest',
  generatedAt: null,
  reconciledAt: null,
  cleanupCandidates: [],
  sourceErrors: [],
  models: { downloaded: [], loaded: [], totals: { all: null } },
};

const renderTab = () => render(<MemoryRouter><ModelStatusTab /></MemoryRouter>);

describe('ModelStatusTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTrackedModelInventory.mockResolvedValue(EMPTY_MANIFEST);
  });

  it('shows residency and the tracked inventory without scanning disk on mount', async () => {
    getTrackedModelInventory.mockResolvedValue(MANIFEST);
    renderTab();

    expect(screen.getByText('residency panel')).toBeInTheDocument();
    expect(await screen.findByText('tracked-example')).toBeInTheDocument();
    expect(runSystemResourceReport).not.toHaveBeenCalled();
    expect(screen.getByText(/tracked, last verified/i)).toBeInTheDocument();
    // A row PortOS installed itself reports when the weights actually landed.
    expect(screen.getByText(/installed .* ago/i)).toBeInTheDocument();
  });

  it('says "tracked since" for a row a scan adopted rather than claiming an install date', async () => {
    getTrackedModelInventory.mockResolvedValue({
      ...MANIFEST,
      models: {
        ...MANIFEST.models,
        downloaded: [{ ...MANIFEST.models.downloaded[0], source: 'scan' }],
      },
    });
    renderTab();

    // The weights may be years old; all PortOS knows is when it first looked.
    expect(await screen.findByText(/tracked since .* ago/i)).toBeInTheDocument();
    expect(screen.queryByText(/installed .* ago/i)).not.toBeInTheDocument();
  });

  it('offers the one-time scan when nothing has ever been reconciled', async () => {
    renderTab();
    expect(await screen.findByRole('button', { name: /run model inventory/i })).toBeInTheDocument();
    expect(runSystemResourceReport).not.toHaveBeenCalled();
  });

  it('renders the downloaded-model inventory once the user asks for it', async () => {
    runSystemResourceReport.mockResolvedValue(REPORT);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /run model inventory/i }));
    await waitFor(() => expect(runSystemResourceReport).toHaveBeenCalledWith({ silent: true }));
    expect(await screen.findByText('example-model')).toBeInTheDocument();
    expect(screen.getByText(/downloaded model inventory/i)).toBeInTheDocument();
  });

  it('replaces the tracked list with a fresh scan when the user rescans', async () => {
    getTrackedModelInventory.mockResolvedValue(MANIFEST);
    runSystemResourceReport.mockResolvedValue(REPORT);
    renderTab();

    expect(await screen.findByText('tracked-example')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /rescan disk/i }));

    expect(await screen.findByText('example-model')).toBeInTheDocument();
    // The rescan is what drops a model deleted outside PortOS — a row that
    // survived it would still offer a delete button for weights that are gone.
    expect(screen.queryByText('tracked-example')).not.toBeInTheDocument();
    expect(screen.getByText(/scanned just now/i)).toBeInTheDocument();
  });
});
